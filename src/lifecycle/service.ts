import { CompletedTurnCounter, type LifecycleSessionEvent } from './counters.js'
import { consolidateMemories } from './consolidate.js'
import { distillSession } from './distill.js'
import type { AuxiliaryModel } from './llm.js'
import { LifecycleScheduler, lifecycleErrorMessage } from './scheduler.js'
import { retentionSweep } from './retention.js'
import { scanSecrets } from '../safety/scanner.js'
import type { MemoryStore } from '../store/store.js'
import type { MemoryEntry, MemoryId, MemoryScope, UpsertMemoryInput } from '../store/types.js'

export interface MaintenanceHost {
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

const IDLE_ACTIVITY_EVENTS = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'turn/start', 'turn/end', 'turn/completed', 'agent/turn',
])

export interface MemoryLifecycleOptions {
  readonly maintenance?: MaintenanceHost
  readonly runMaintenance?: <T>(sessionId: string, task: (signal?: AbortSignal) => Promise<T>) => Promise<T>
  readonly route?: () => ModelRoute | undefined
  readonly model?: AuxiliaryModel
  readonly provider?: string
  readonly modelName?: string
  readonly now?: () => Date
  readonly reviewEveryUserTurns?: number | undefined
  readonly idleDelayMinutes?: number | undefined
  readonly consolidationCooldownHours?: number | undefined
  readonly retentionSweepHours?: number | undefined
  readonly transcript?: (sessionId: string) => string | Promise<string>
  readonly onChange?: (change: { kind: string; scope: MemoryScope; ids?: readonly MemoryId[] }) => void | Promise<void>
}

export class MemoryLifecycleService {
  private readonly scheduler: LifecycleScheduler
  private readonly counter: CompletedTurnCounter
  private readonly now: () => Date
  private readonly options: MemoryLifecycleOptions
  private reviewed = 0

  constructor(readonly store: MemoryStore, options: MemoryLifecycleOptions = {}) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.counter = new CompletedTurnCounter(options.reviewEveryUserTurns ?? 10)
    this.scheduler = new LifecycleScheduler(store, {
      ...(options.idleDelayMinutes === undefined ? {} : { idleDelayMinutes: options.idleDelayMinutes }),
      ...(options.consolidationCooldownHours === undefined ? {} : { consolidationCooldownHours: options.consolidationCooldownHours }),
      ...(options.retentionSweepHours === undefined ? {} : { retentionSweepHours: options.retentionSweepHours }),
      now: this.now,
      run: async kind => { await this.runIntent(kind) },
    })
  }

  get reviewCount(): number {
    return this.reviewed
  }

  start(): Promise<void> {
    return this.scheduler.start()
  }

  async dispose(): Promise<void> {
    await this.scheduler.dispose()
  }

  async handleSessionEvent(sessionId: string, event: LifecycleSessionEvent): Promise<void> {
    if (IDLE_ACTIVITY_EVENTS.has(event.type)) await this.scheduler.requestIdle(sessionId)
    if (this.counter.handleEvent(sessionId, event)) {
      this.reviewed += 1
      await this.scheduler.requestReview(sessionId)
    }
    if (event.type === 'session/archive' || event.type === 'session/stop' || event.type === 'agent/stop') {
      await this.scheduler.requestDistill(sessionId)
    }
  }

  runIntent(kind: string): Promise<{ written: number }> {
    const sessionId = kind.includes(':') ? kind.slice(kind.indexOf(':') + 1) : ''
    if (this.options.runMaintenance) {
      return this.options.runMaintenance(sessionId, signal => this.executeIntent(kind, signal))
    }
    if (this.options.maintenance) return this.options.maintenance.runMaintenance(signal => this.executeIntent(kind, signal))
    return this.executeIntent(kind)
  }

  private async executeIntent(kind: string, signal?: AbortSignal): Promise<{ written: number }> {
    const route = this.options.route?.()
    const selectedProvider = route?.provider ?? this.options.provider
    const selectedModel = route?.model ?? this.options.modelName
    try {
      const separator = kind.indexOf(':')
      const operation = separator < 0 ? kind : kind.slice(0, separator)
      const sessionId = separator < 0 ? '' : kind.slice(separator + 1)
      if (operation === 'retention') {
        const removed = await this.sweepRetention()
        return { written: removed.length }
      }
      if (operation === 'consolidate') {
        return { written: await this.consolidateWithResult(signal) }
      }
      if (operation !== 'review' && operation !== 'idle' && operation !== 'stop') {
        throw new Error(`Unknown memory lifecycle intent: ${kind}`)
      }
      const state = this.store.getSessionState(sessionId)
      const result = await distillSession(this.store, {
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(selectedProvider === undefined ? {} : { provider: selectedProvider }),
        ...(selectedModel === undefined ? {} : { modelName: selectedModel }),
        sessionId,
        ...(state.workspaceId === undefined ? {} : { workspaceId: state.workspaceId }),
        transcript: await this.options.transcript?.(sessionId) ?? '',
        kind: operation,
        now: this.now,
        ...(signal === undefined ? {} : { signal }),
      })
      if (result.written > 0 && state.workspaceId) {
        await this.scheduler.markDirty()
        await this.options.onChange?.({
          kind: 'distill',
          scope: { kind: 'workspace', workspaceId: state.workspaceId },
          ids: result.entries.map(entry => entry.id),
        })
      }
      return { written: result.written }
    } catch (error) {
      await this.store.updateMeta(meta => {
        meta.dirty = true
        meta.lastError = lifecycleErrorMessage(kind)
        meta.nextConsolidationAt = new Date(this.now().getTime() + (this.options.consolidationCooldownHours ?? 6) * 3_600_000).toISOString()
      })
      throw error
    }
  }

  async remember(input: UpsertMemoryInput): Promise<MemoryEntry> {
    this.validateInput(input)
    const entry = await this.store.upsert(input)
    await this.markChanged('remember', entry.scope, [entry.id])
    return entry
  }

  async correct(input: UpsertMemoryInput & { id: MemoryId }): Promise<MemoryEntry> {
    this.validateInput(input)
    const existing = this.store.read(input.scope, input.id)
    if (!existing) throw new Error('Cannot correct a memory that does not exist in this scope')
    const entry = await this.store.upsert(input)
    await this.markChanged('correct', entry.scope, [entry.id])
    return entry
  }

  async forget(scope: MemoryScope, id: MemoryId): Promise<boolean> {
    const removed = await this.store.remove(scope, id)
    if (removed) await this.markChanged('forget', scope, [id])
    return removed
  }

  consolidate(): Promise<number> {
    return this.consolidateWithResult()
  }

  retentionSweep(): Promise<MemoryId[]> {
    return this.sweepRetention()
  }

  private sweepRetention(): Promise<MemoryId[]> {
    return retentionSweep(this.store, {
      now: this.now,
      onChange: async (scope, ids) => { await this.options.onChange?.({ kind: 'retention', scope, ids }) },
    })
  }

  private async consolidateWithResult(signal?: AbortSignal): Promise<number> {
    const route = this.options.route?.()
    const provider = route?.provider ?? this.options.provider
    const modelName = route?.model ?? this.options.modelName
    return consolidateMemories(this.store, {
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(provider === undefined ? {} : { provider }),
      ...(modelName === undefined ? {} : { modelName }),
      now: this.now,
      ...(signal === undefined ? {} : { signal }),
      onChange: async (scope, entries) => {
        await this.options.onChange?.({ kind: 'consolidate', scope, ids: entries.map(entry => entry.id) })
      },
    })
  }

  private validateInput(input: UpsertMemoryInput): void {
    if (!input.summary.trim() || !input.detail.trim()) throw new Error('Memory summary and detail are required')
    if (input.detail.length > 16_000) throw new Error('Memory detail exceeds 16,000 characters')
    if (scanSecrets(`${input.summary}\n${input.detail}`).findings.length > 0) {
      throw new Error('Secret content cannot be persisted as memory')
    }
  }

  private async markChanged(kind: string, scope: MemoryScope, ids: readonly MemoryId[]): Promise<void> {
    await this.scheduler.markDirty()
    await this.options.onChange?.({ kind, scope, ids })
  }
}

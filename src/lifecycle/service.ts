import { CompletedTurnCounter, type LifecycleSessionEvent } from './counters.js'
import { consolidateMemories } from './consolidate.js'
import { distillSession } from './distill.js'
import type { AuxiliaryModel } from './llm.js'
import { LifecycleScheduler, lifecycleErrorMessage } from './scheduler.js'
import { DEFAULT_MEMORY_SETTINGS } from './settings.js'
import type { MemorySettingsStore } from './settings.js'
import { retentionSweep } from './retention.js'
import { scanSecrets } from '../safety/scanner.js'
import type { MemorySettings } from '../contract.js'
import type { MemoryStore } from '../store/store.js'
import type { MemoryEntry, MemoryId, MemoryScope, PromoteMemoryResult, UpsertMemoryInput, WorkspaceId } from '../store/types.js'
import { workspaceId } from '../store/types.js'
import type { TranscriptEvent } from '../runtime.js'

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
  readonly globalConsolidationCooldownDays?: number | undefined
  readonly retentionSweepHours?: number | undefined
  readonly settings?: MemorySettingsStore
  readonly transcriptEvents?: (sessionId: string) => readonly TranscriptEvent[] | Promise<readonly TranscriptEvent[]>
  readonly resolveWorkspaceId?: (sessionId: string) => WorkspaceId | undefined
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
    const settings = this.getSettings()
    this.counter = new CompletedTurnCounter(settings.reviewEveryUserTurns)
    this.scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: settings.idleDelayMinutes,
      consolidationCooldownHours: settings.consolidationCooldownHours,
      globalConsolidationCooldownDays: settings.globalConsolidationCooldownDays,
      ...(options.retentionSweepHours === undefined ? {} : { retentionSweepHours: options.retentionSweepHours }),
      now: this.now,
      run: async kind => { await this.runIntent(kind) },
    })
  }

  get reviewCount(): number {
    return this.reviewed
  }

  getSettings(): MemorySettings {
    return this.options.settings?.get() ?? {
      reviewEveryUserTurns: this.options.reviewEveryUserTurns ?? DEFAULT_MEMORY_SETTINGS.reviewEveryUserTurns,
      idleDelayMinutes: this.options.idleDelayMinutes ?? DEFAULT_MEMORY_SETTINGS.idleDelayMinutes,
      consolidationCooldownHours: this.options.consolidationCooldownHours ?? DEFAULT_MEMORY_SETTINGS.consolidationCooldownHours,
      globalConsolidationCooldownDays: this.options.globalConsolidationCooldownDays ?? DEFAULT_MEMORY_SETTINGS.globalConsolidationCooldownDays,
      snapshotTokenBudget: DEFAULT_MEMORY_SETTINGS.snapshotTokenBudget,
      retentionDays: { ...DEFAULT_MEMORY_SETTINGS.retentionDays },
    }
  }

  async updateSettings(input: MemorySettings): Promise<MemorySettings> {
    if (!this.options.settings) throw new Error('Lifecycle settings persistence is unavailable')
    const settings = await this.options.settings.update(input)
    this.counter.updateReviewEveryUserTurns(settings.reviewEveryUserTurns)
    this.scheduler.updateIdleDelayMinutes(settings.idleDelayMinutes)
    await this.scheduler.updateConsolidationCooldownHours(settings.consolidationCooldownHours)
    await this.scheduler.updateGlobalConsolidationCooldownDays(settings.globalConsolidationCooldownDays)
    return settings
  }

  start(): Promise<void> {
    return this.scheduler.start()
  }

  stop(): Promise<void> {
    return this.scheduler.stop()
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
    const separator = kind.indexOf(':')
    const operation = separator < 0 ? kind : kind.slice(0, separator)
    const sessionId = separator >= 0 && (operation === 'review' || operation === 'idle' || operation === 'stop')
      ? kind.slice(separator + 1)
      : ''
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
    const separator = kind.indexOf(':')
    const operation = separator < 0 ? kind : kind.slice(0, separator)
    const sessionId = operation === 'review' || operation === 'idle' || operation === 'stop'
      ? separator < 0 ? '' : kind.slice(separator + 1)
      : ''
    let consolidationWorkspaceId: WorkspaceId | undefined
    try {
      if (operation === 'retention') {
        const removed = await this.sweepRetention()
        return { written: removed.length }
      }
      if (operation === 'consolidate') {
        if (separator >= 0) consolidationWorkspaceId = workspaceId(decodeURIComponent(kind.slice(separator + 1)))
        const scope: MemoryScope | undefined = consolidationWorkspaceId === undefined
          ? undefined
          : { kind: 'workspace', workspaceId: consolidationWorkspaceId }
        return { written: await this.consolidateWithResult(scope, signal) }
      }
      if (operation === 'global-consolidate') {
        return { written: await this.consolidateWithResult({ kind: 'global' }, signal) }
      }
      if (operation !== 'review' && operation !== 'idle' && operation !== 'stop') {
        throw new Error(`Unknown memory lifecycle intent: ${kind}`)
      }
      let state = this.store.getSessionState(sessionId)
      if (state.workspaceId === undefined) {
        const resolvedWorkspaceId = this.options.resolveWorkspaceId?.(sessionId)
        if (resolvedWorkspaceId !== undefined) {
          state = await this.store.updateSessionState(sessionId, current => {
            current.workspaceId ??= resolvedWorkspaceId
          })
        }
      }
      const events = await this.options.transcriptEvents?.(sessionId) ?? []
      let written = 0
      const maxBatches = operation === 'review' ? 1 : 2
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await distillSession(this.store, {
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...(selectedProvider === undefined ? {} : { provider: selectedProvider }),
          ...(selectedModel === undefined ? {} : { modelName: selectedModel }),
          sessionId,
          ...(state.workspaceId === undefined ? {} : { workspaceId: state.workspaceId }),
          events,
          kind: operation,
          now: this.now,
          ...(signal === undefined ? {} : { signal }),
        })
        written += result.written
        if (result.written > 0 && state.workspaceId) {
          await this.scheduler.markDirty(state.workspaceId)
          await this.options.onChange?.({
            kind: 'distill',
            scope: { kind: 'workspace', workspaceId: state.workspaceId },
            ids: result.entries.map(entry => entry.id),
          })
        }
        if (!result.processed || !result.hasMore) break
      }
      return { written }
    } catch (error) {
      await this.store.updateMeta(meta => {
        meta.lastError = lifecycleErrorMessage(kind)
        if (kind === 'global-consolidate') {
          meta.globalDirty = true
          meta.nextGlobalConsolidationAt = new Date(this.now().getTime() + this.getSettings().globalConsolidationCooldownDays * 86_400_000).toISOString()
        } else if (consolidationWorkspaceId !== undefined) {
          const consolidation = meta.workspaceConsolidation[consolidationWorkspaceId] ??= {
            dirty: false,
            nextConsolidationAt: null,
            lastConsolidationAt: null,
          }
          consolidation.dirty = true
          consolidation.nextConsolidationAt = new Date(this.now().getTime() + this.getSettings().consolidationCooldownHours * 3_600_000).toISOString()
        }
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
    const existing = await this.store.read(input.scope, input.id)
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

  async promote(scope: MemoryScope, id: MemoryId): Promise<PromoteMemoryResult> {
    const result = await this.store.promote(scope, id)
    if (result.created) {
      await this.scheduler.markGlobalDirty()
      await this.options.onChange?.({ kind: 'promote', scope: { kind: 'global' }, ids: [result.id] })
    }
    return result
  }

  consolidate(): Promise<number> {
    return this.consolidateWithResult()
  }

  retentionSweep(): Promise<MemoryId[]> {
    return this.sweepRetention()
  }

  private sweepRetention(): Promise<MemoryId[]> {
    const settings = this.getSettings()
    return retentionSweep(this.store, {
      now: this.now,
      retentionDays: settings.retentionDays,
      consolidationCooldownHours: settings.consolidationCooldownHours,
      onChange: async (scope, ids) => { await this.options.onChange?.({ kind: 'retention', scope, ids }) },
    })
  }

  private async consolidateWithResult(scope?: MemoryScope, signal?: AbortSignal): Promise<number> {
    const route = this.options.route?.()
    const provider = route?.provider ?? this.options.provider
    const modelName = route?.model ?? this.options.modelName
    return consolidateMemories(this.store, {
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(provider === undefined ? {} : { provider }),
      ...(modelName === undefined ? {} : { modelName }),
      ...(scope === undefined ? {} : { scope }),
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
    if (scope.kind === 'global') await this.scheduler.markGlobalDirty()
    else await this.scheduler.markDirty(scope.workspaceId)
    await this.options.onChange?.({ kind, scope, ids })
  }
}

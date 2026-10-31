import { randomUUID } from 'node:crypto'
import { MemoryStoreReadonlyError, type MemoryStore } from '../store/store.js'
import type { LifecycleIntent, MemoryMeta, MemoryScope, WorkspaceId } from '../store/types.js'
import type {
  LifecycleActivityRecord,
  LifecycleActivitySink,
  LifecycleErrorCategory,
  LifecycleIntentRunResult,
  LifecycleOperation,
  LifecycleRunResult,
} from './activity.js'

/** Activity deadlines live only in memory, so a long-lived process must bound the map. */
const MAX_TRACKED_ACTIVITY = 256
/** Session intents retry with exponential backoff and stop after this many failed attempts. */
const MAX_SESSION_RETRIES = 6
/** Floor keeps a zero idle delay from turning a dead Session into a hot retry loop. */
const MIN_SESSION_RETRY_DELAY_MS = 60_000
const MAX_SESSION_RETRY_DELAY_MS = 86_400_000

interface ConsolidationRequest {
  intentId: string
  settled: boolean
  readonly promise: Promise<LifecycleIntentRunResult>
  readonly resolve: (result: LifecycleIntentRunResult) => void
  readonly reject: (error: Error) => void
}

export interface LifecycleSchedulerOptions {
  readonly idleDelayMinutes?: number
  readonly consolidationCooldownHours?: number
  readonly globalConsolidationCooldownDays?: number
  readonly retentionSweepHours?: number
  readonly now?: () => Date
  readonly activity?: LifecycleActivitySink
  readonly run: (kind: string) => Promise<LifecycleRunResult | void>
}

function isCurrentIntent(current: LifecycleIntent | undefined, expected: LifecycleIntent): boolean {
  if (current?.id !== expected.id) return false
  return !expected.kind.startsWith('idle:') || current.generation === expected.generation
}

function activityContext(kind: string): {
  operation: LifecycleOperation
  sessionId?: string
  workspaceId?: string
} {
  const separator = kind.indexOf(':')
  const operation = (separator < 0 ? kind : kind.slice(0, separator)) as LifecycleOperation
  if (operation === 'review' || operation === 'idle' || operation === 'stop') {
    return { operation, ...(separator < 0 ? {} : { sessionId: kind.slice(separator + 1) }) }
  }
  if (operation === 'consolidate' && separator >= 0) {
    try {
      return { operation, workspaceId: decodeURIComponent(kind.slice(separator + 1)) }
    } catch {
      return { operation }
    }
  }
  return { operation }
}

function activityErrorCategory(error: unknown): LifecycleErrorCategory {
  if (error instanceof MemoryStoreReadonlyError) return 'store-readonly'
  const category = (error as { activityCategory?: unknown } | null)?.activityCategory
  if (category === 'model-route-missing' || category === 'model-request-failed' || category === 'model-output-invalid'
    || category === 'model-output-empty' || category === 'model-output-invalid-json'
    || category === 'model-output-shape-invalid' || category === 'model-output-budget-exceeded'
    || category === 'store-readonly' || category === 'transcript-unavailable'
    || category === 'operation-aborted' || category === 'operation-failed') return category
  const message = error instanceof Error ? error.message : ''
  if (message === 'No auxiliary model route is available') return 'model-route-missing'
  if ((error as { name?: unknown } | null)?.name === 'AbortError' || /aborted|cancelled/i.test(message)) return 'operation-aborted'
  return 'operation-failed'
}

/** Status exposes a stable category, never exception text that may contain paths or secrets. */
export function lifecycleErrorMessage(kind: string): string {
  const separator = kind.indexOf(':')
  const operation = separator < 0 ? kind : kind.slice(0, separator)
  if (operation === 'global-consolidate') return 'Global memory consolidation failed'
  if (operation === 'consolidate') return 'Memory consolidation failed'
  if (operation === 'retention') return 'Memory retention failed'
  if (operation === 'review' || operation === 'idle' || operation === 'stop') return 'Session distillation failed'
  return 'Memory lifecycle operation failed'
}

/** Single-timer, serial, persistent-intent scheduling with restart recovery. */
export class LifecycleScheduler {
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private started = false
  private readonly deferredIntents = new Map<string, LifecycleIntent>()
  private readonly consolidationRequests = new Map<string, ConsolidationRequest>()
  private readonly activeConsolidations = new Map<string, string>()
  /** Latest Session activity, used to postpone idle work without rewriting authoritative state. */
  private readonly lastActivity = new Map<string, number>()
  /** Scopes currently being consolidated by a caller outside this scheduler, with nesting depth. */
  private readonly runningScopes = new Map<string, number>()
  /** Kind currently executing, so a refresh during a run can still persist a newer generation. */
  private readonly activeIntents = new Map<string, string>()
  private readonly now: () => Date

  constructor(
    private readonly store: MemoryStore,
    private options: LifecycleSchedulerOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  updateIdleDelayMinutes(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error('idleDelayMinutes must be a non-negative finite number')
    this.options = { ...this.options, idleDelayMinutes: value }
    this.schedule()
  }

  async updateConsolidationCooldownHours(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) throw new Error('consolidationCooldownHours must be a non-negative finite number')
    const current = this.store.getMeta()
    const hasWorkspaceWork = Object.values(current.workspaceConsolidation).some(consolidation => consolidation.dirty)
      || Object.keys(current.pending).some(kind => kind.startsWith('consolidate:'))
    if (hasWorkspaceWork) {
      const nextRunAt = new Date(this.now().getTime() + value * 3_600_000).toISOString()
      await this.store.updateMeta(meta => {
        for (const consolidation of Object.values(meta.workspaceConsolidation)) {
          if (consolidation.dirty) consolidation.nextConsolidationAt = nextRunAt
        }
        for (const [kind, intent] of Object.entries(meta.pending)) {
          if (kind.startsWith('consolidate:')) meta.pending[kind] = { ...intent, id: randomUUID(), createdAt: nextRunAt }
        }
      })
    }
    this.options = { ...this.options, consolidationCooldownHours: value }
    this.schedule()
  }

  async updateGlobalConsolidationCooldownDays(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) throw new Error('globalConsolidationCooldownDays must be a non-negative finite number')
    const current = this.store.getMeta()
    if (current.globalDirty || current.pending['global-consolidate']) {
      const nextRunAt = new Date(this.now().getTime() + value * 86_400_000).toISOString()
      await this.store.updateMeta(meta => {
        if (meta.globalDirty) meta.nextGlobalConsolidationAt = nextRunAt
        if (meta.pending['global-consolidate']) {
          meta.pending['global-consolidate'] = { ...meta.pending['global-consolidate'], id: randomUUID(), createdAt: nextRunAt }
        }
      })
    }
    this.options = { ...this.options, globalConsolidationCooldownDays: value }
    this.schedule()
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    const deferred = new Map(this.deferredIntents)
    try {
      await this.store.updateMeta(meta => {
        if (meta.nextRetentionAt === null) {
          meta.nextRetentionAt = new Date(this.now().getTime() + this.retentionDelayMs).toISOString()
        }
        for (const consolidation of Object.values(meta.workspaceConsolidation)) {
          if (consolidation.dirty && consolidation.nextConsolidationAt === null) {
            consolidation.nextConsolidationAt = new Date(this.now().getTime() + this.consolidationDelayMs).toISOString()
          }
        }
        if (meta.globalDirty && meta.nextGlobalConsolidationAt === null) {
          meta.nextGlobalConsolidationAt = new Date(this.now().getTime() + this.globalConsolidationDelayMs).toISOString()
        }
        for (const [kind, intent] of deferred) {
          meta.pending[kind] = intent
        }
      })
      for (const [kind, intent] of deferred) {
        if (this.deferredIntents.get(kind)?.id === intent.id) this.deferredIntents.delete(kind)
        this.logActivity(intent, 'intent-created')
      }
    } catch (error) {
      this.started = false
      throw error
    }
    this.schedule()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.rejectAllConsolidationRequests()
    await this.queue
  }

  /**
   * Activity inside one Session. The first event of an idle window persists the intent; later events
   * only move an in-memory deadline, so a chat burst cannot rewrite authoritative state per event.
   * Activity that lands while the window is already running still persists a newer generation,
   * otherwise that run's completion would drop the work it has not seen yet.
   */
  async requestIdle(sessionId: string): Promise<void> {
    this.rememberActivity(sessionId)
    const kind = `idle:${sessionId}`
    if (this.store.getMeta().pending[kind] === undefined || this.activeIntents.has(kind)) {
      await this.putIntent(kind, this.now().toISOString())
      return
    }
    this.schedule()
  }

  private rememberActivity(sessionId: string): void {
    this.lastActivity.set(sessionId, this.now().getTime())
    if (this.lastActivity.size <= MAX_TRACKED_ACTIVITY) return
    const oldest = [...this.lastActivity.entries()].sort((left, right) => left[1] - right[1])[0]
    if (oldest !== undefined) this.lastActivity.delete(oldest[0])
  }

  async requestReview(sessionId: string): Promise<void> {
    await this.putIntent(`review:${sessionId}`, this.now().toISOString())
  }

  async requestDistill(sessionId: string): Promise<void> {
    await this.putIntent(`stop:${sessionId}`, this.now().toISOString())
  }

  requestConsolidation(scope: MemoryScope): Promise<LifecycleIntentRunResult> {
    const kind = scope.kind === 'global' ? 'global-consolidate' : `consolidate:${encodeURIComponent(scope.workspaceId)}`
    const existing = this.consolidationRequests.get(kind)
    if (existing !== undefined) return existing.promise
    if (!this.store.writable) return Promise.reject(new MemoryStoreReadonlyError())
    if (!this.started || this.disposed) return Promise.reject(new Error(lifecycleErrorMessage(kind)))

    const activeId = this.activeConsolidations.get(kind)
    const intentId = activeId ?? this.store.getMeta().pending[kind]?.id ?? randomUUID()
    let resolve!: (result: LifecycleIntentRunResult) => void
    let reject!: (error: Error) => void
    const promise = new Promise<LifecycleIntentRunResult>((res, rej) => { resolve = res; reject = rej })
    const request: ConsolidationRequest = { intentId, settled: false, promise, resolve, reject }
    this.consolidationRequests.set(kind, request)
    if (activeId === undefined) void this.prepareConsolidation(kind, scope, request)
    return promise
  }

  /**
   * Throttle, not debounce: the first unscheduled write fixes one run time and later writes keep it,
   * so a continuously active workspace still consolidates on a fixed cadence. A write that lands
   * while this scope is consolidating must move the schedule, otherwise completion could drop work
   * the run never saw.
   */
  async markDirty(workspaceId: string): Promise<void> {
    const consolidating = this.isConsolidating(workspaceId)
    await this.store.updateMeta(meta => {
      const consolidation = meta.workspaceConsolidation[workspaceId] ??= {
        dirty: false,
        nextConsolidationAt: null,
        lastConsolidationAt: null,
      }
      consolidation.dirty = true
      if (consolidating || consolidation.nextConsolidationAt === null) {
        consolidation.nextConsolidationAt = new Date(this.now().getTime() + this.consolidationDelayMs).toISOString()
      }
    })
    this.schedule()
  }

  async markGlobalDirty(): Promise<void> {
    const consolidating = this.isConsolidating('global')
    await this.store.updateMeta(meta => {
      meta.globalDirty = true
      if (consolidating || meta.nextGlobalConsolidationAt === null) {
        meta.nextGlobalConsolidationAt = new Date(this.now().getTime() + this.globalConsolidationDelayMs).toISOString()
      }
    })
    this.schedule()
  }

  /** A caller outside the queue (manual consolidate) marks its scope so concurrent writes stay dirty. */
  beginConsolidation(scope: MemoryScope): void {
    const key = scope.kind === 'global' ? 'global' : scope.workspaceId
    this.runningScopes.set(key, (this.runningScopes.get(key) ?? 0) + 1)
  }

  endConsolidation(scope: MemoryScope): void {
    const key = scope.kind === 'global' ? 'global' : scope.workspaceId
    const depth = (this.runningScopes.get(key) ?? 1) - 1
    if (depth <= 0) {
      this.runningScopes.delete(key)
      return
    }
    this.runningScopes.set(key, depth)
  }

  private isConsolidating(scopeKey: string): boolean {
    if ((this.runningScopes.get(scopeKey) ?? 0) > 0) return true
    const kind = scopeKey === 'global' ? 'global-consolidate' : `consolidate:${encodeURIComponent(scopeKey)}`
    return this.activeConsolidations.has(kind)
  }

  finishConsolidation(
    meta: MemoryMeta,
    scope: MemoryScope,
    snapshot: MemoryMeta,
    completedAt: string,
  ): void {
    if (scope.kind === 'global') {
      if (meta.nextGlobalConsolidationAt === snapshot.nextGlobalConsolidationAt) {
        meta.globalDirty = false
        meta.lastGlobalConsolidationAt = completedAt
        meta.nextGlobalConsolidationAt = null
      }
    } else {
      const consolidation = meta.workspaceConsolidation[scope.workspaceId]
      const scheduleSnapshot = snapshot.workspaceConsolidation[scope.workspaceId]?.nextConsolidationAt
      if (consolidation && consolidation.nextConsolidationAt === scheduleSnapshot) {
        consolidation.dirty = false
        consolidation.lastConsolidationAt = completedAt
        consolidation.nextConsolidationAt = null
      }
    }
    meta.lastError = null
  }

  retryConsolidation(
    meta: MemoryMeta,
    workspaceId: WorkspaceId | undefined,
    retryAt: string,
    scheduleSnapshot?: string | null,
  ): void {
    if (workspaceId !== undefined) {
      const consolidation = meta.workspaceConsolidation[workspaceId] ??= {
        dirty: false,
        nextConsolidationAt: null,
        lastConsolidationAt: null,
      }
      if (scheduleSnapshot === undefined) consolidation.dirty = true
      if (scheduleSnapshot === undefined || consolidation.nextConsolidationAt === scheduleSnapshot) {
        consolidation.nextConsolidationAt = retryAt
      }
    } else {
      if (scheduleSnapshot === undefined) meta.globalDirty = true
      if (scheduleSnapshot === undefined || meta.nextGlobalConsolidationAt === scheduleSnapshot) {
        meta.nextGlobalConsolidationAt = retryAt
      }
    }
  }

  static finishRetention(
    meta: MemoryMeta,
    changedWorkspaces: readonly WorkspaceId[],
    now: () => Date,
    consolidationDelayMs: number,
    retentionDelayMs: number,
    scheduleSnapshot?: string | null,
  ): void {
    const completedAt = now()
    for (const id of changedWorkspaces) {
      const consolidation = meta.workspaceConsolidation[id] ??= {
        dirty: false,
        nextConsolidationAt: null,
        lastConsolidationAt: null,
      }
      consolidation.dirty = true
      consolidation.nextConsolidationAt = new Date(completedAt.getTime() + consolidationDelayMs).toISOString()
    }
    if (scheduleSnapshot === undefined || meta.nextRetentionAt === scheduleSnapshot) {
      meta.lastRetentionAt = completedAt.toISOString()
      meta.nextRetentionAt = new Date(now().getTime() + retentionDelayMs).toISOString()
    }
  }

  drain(): Promise<void> {
    return this.queue
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    try {
      await this.options.activity?.flush?.()
    } catch {
      // Activity history is diagnostic and never blocks disposal.
    }
  }

  private async prepareConsolidation(kind: string, scope: MemoryScope, request: ConsolidationRequest): Promise<void> {
    const createdAt = this.now().toISOString()
    let created = false
    try {
      await this.store.updateMeta(meta => {
        // A flush may have claimed the automatic intent while this write was queued.
        if (request.settled || this.activeConsolidations.has(kind) || !this.started || this.disposed) return
        const previous = meta.pending[kind]
        const intent: LifecycleIntent = { id: previous?.id ?? request.intentId, kind, createdAt }
        request.intentId = intent.id
        created = previous === undefined
        meta.pending[kind] = intent
        if (scope.kind === 'global') {
          meta.globalDirty = true
          meta.nextGlobalConsolidationAt = createdAt
        } else {
          const consolidation = meta.workspaceConsolidation[scope.workspaceId] ??= {
            dirty: false,
            nextConsolidationAt: null,
            lastConsolidationAt: null,
          }
          consolidation.dirty = true
          consolidation.nextConsolidationAt = createdAt
        }
      })
      if (request.settled || this.consolidationRequests.get(kind) !== request) return
      if (created) this.logActivity({ id: request.intentId, kind, createdAt }, 'intent-created')
      // Manual work is already due; enqueue it directly instead of depending on a zero-delay timer turn.
      this.enqueue()
    } catch {
      this.rejectConsolidation(kind, request.intentId)
    }
  }

  private async putIntent(kind: string, createdAt: string): Promise<void> {
    if (this.disposed) return
    const id = randomUUID()
    let intent: LifecycleIntent = {
      id, kind, createdAt, ...(kind.startsWith('idle:') ? { generation: id } : {}),
    }
    if (!this.store.writable) {
      this.deferredIntents.set(kind, intent)
      return
    }
    let previous: LifecycleIntent | undefined
    try {
      await this.store.updateMeta(meta => {
        previous = meta.pending[kind]
        if (previous !== undefined && kind.startsWith('idle:')) intent = { ...intent, id: previous.id }
        meta.pending[kind] = intent
      })
      if (this.deferredIntents.get(kind)?.id === intent.id) this.deferredIntents.delete(kind)
    } catch (error) {
      if (!(error instanceof MemoryStoreReadonlyError)) throw error
      this.deferredIntents.set(kind, intent)
      return
    }
    if (previous === undefined || !kind.startsWith('idle:')) this.logActivity(intent, 'intent-created')
    this.schedule()
  }

  private enqueue(): void {
    if (this.disposed) return
    this.queue = this.queue.then(() => this.flush()).catch(() => {})
  }

  private async flush(): Promise<void> {
    // dispose() clears future timers but deliberately drains an already queued flush.
    for (;;) {
      if (!this.started) return
      const meta = this.store.getMeta()
      const now = this.now().getTime()
      const due = Object.entries(meta.pending).find(([, value]) => this.dueAt(value) <= now)
      const workspaceDue = Object.entries(meta.workspaceConsolidation).find(([, consolidation]) => consolidation.dirty
        && consolidation.nextConsolidationAt !== null && new Date(consolidation.nextConsolidationAt).getTime() <= now)
      const globalConsolidationDue = meta.globalDirty && meta.nextGlobalConsolidationAt !== null
        && new Date(meta.nextGlobalConsolidationAt).getTime() <= now
      const retentionDue = meta.nextRetentionAt !== null && new Date(meta.nextRetentionAt).getTime() <= now
      if (!due && !workspaceDue && !globalConsolidationDue && !retentionDue) break

      const key = due?.[0] ?? (workspaceDue
        ? `consolidate:${encodeURIComponent(workspaceDue[0])}`
        : globalConsolidationDue ? 'global-consolidate' : 'retention')
      const value = due?.[1] ?? { id: randomUUID(), kind: key, createdAt: this.now().toISOString() }
      const workspaceId = this.workspaceId(value.kind)
      const scheduleSnapshot = workspaceId !== undefined
        ? meta.workspaceConsolidation[workspaceId]?.nextConsolidationAt
        : value.kind === 'global-consolidate'
          ? meta.nextGlobalConsolidationAt
          : value.kind === 'retention'
            ? meta.nextRetentionAt
            : null
      if (due && workspaceId !== undefined && !meta.workspaceConsolidation[workspaceId]?.dirty) {
        await this.store.updateMeta(current => {
          if (current.pending[key]?.id === value.id && !current.workspaceConsolidation[workspaceId]?.dirty) {
            delete current.pending[key]
          }
        })
        this.logActivity(value, 'run-skipped', { skipReason: 'workspace-clean' })
        continue
      }
      if (!due) {
        await this.store.updateMeta(current => { current.pending[key] = value })
        this.logActivity(value, 'intent-created')
      }
      const consolidation = workspaceId !== undefined || value.kind === 'global-consolidate'
      if (consolidation) {
        this.activeConsolidations.set(key, value.id)
        const request = this.consolidationRequests.get(key)
        if (request !== undefined && !request.settled) request.intentId = value.id
      }
      const startedAt = this.now().getTime()
      this.logActivity(value, 'run-started')
      this.activeIntents.set(key, value.id)
      let failed = false
      try {
        const result: LifecycleRunResult = await this.options.run(value.kind) ?? {
          written: 0,
          batches: 0,
          processed: true,
        }
        result.batchResults?.forEach((batch, index) => {
          this.logActivity(value, 'batch-completed', {
            batch: index + 1,
            written: batch.written,
            rejected: batch.rejected,
            cursor: batch.cursor,
          })
        })
        await this.store.updateMeta(current => {
          if (isCurrentIntent(current.pending[key], value)) {
            delete current.pending[key]
          }
          current.lastError = null
          if (workspaceId !== undefined) {
            this.finishConsolidation(current, { kind: 'workspace', workspaceId }, meta, this.now().toISOString())
          } else if (value.kind === 'global-consolidate') {
            this.finishConsolidation(current, { kind: 'global' }, meta, this.now().toISOString())
          } else if (value.kind === 'retention') {
            LifecycleScheduler.finishRetention(
              current, [], this.now, this.consolidationDelayMs, this.retentionDelayMs, scheduleSnapshot,
            )
          }
        })
        const cursor = result.batchResults?.at(-1)?.cursor
        this.logActivity(value, result.skipReason ? 'run-skipped' : 'run-succeeded', {
          durationMs: Math.max(0, this.now().getTime() - startedAt),
          batches: result.batches,
          written: result.written,
          processed: result.processed,
          ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(result.skipReason === undefined ? {} : { skipReason: result.skipReason }),
        })
        this.resolveConsolidation(key, value.id, { ...result, intentId: value.id })
      } catch (error) {
        failed = true
        this.logActivity(value, 'run-failed', {
          durationMs: Math.max(0, this.now().getTime() - startedAt),
          error: activityErrorCategory(error),
        })
        const sessionKind = value.kind.startsWith('review:') || value.kind.startsWith('idle:')
          || value.kind.startsWith('stop:')
        const attempts = (value.attempts ?? 0) + 1
        const exhausted = sessionKind && attempts >= MAX_SESSION_RETRIES
        const delay = workspaceId !== undefined
          ? this.consolidationDelayMs
          : value.kind === 'global-consolidate'
            ? this.globalConsolidationDelayMs
            : value.kind === 'retention'
              ? this.retentionDelayMs
              : this.sessionRetryDelayMs(attempts)
        const retryAt = new Date(this.now().getTime() + delay).toISOString()
        const retryCreatedAt = workspaceId !== undefined || value.kind === 'global-consolidate' || value.kind === 'retention'
          ? retryAt
          : this.now().toISOString()
        const retryKind = value.kind.startsWith('review:') || value.kind.startsWith('stop:')
          ? `idle:${value.kind.slice(value.kind.indexOf(':') + 1)}`
          : value.kind
        let retryIntent: LifecycleIntent | undefined
        let dropped = false
        await this.store.updateMeta(current => {
          current.lastError = lifecycleErrorMessage(value.kind)
          if (isCurrentIntent(current.pending[key], value)) {
            delete current.pending[key]
            if (exhausted) {
              // A Session whose transcript never returns must not retry forever.
              dropped = true
            } else if (retryKind === key || current.pending[retryKind] === undefined) {
              const id = randomUUID()
              retryIntent = {
                id, kind: retryKind, createdAt: retryCreatedAt,
                ...(retryKind.startsWith('idle:')
                  ? { generation: id, attempts, retryAt }
                  : {}),
              }
              current.pending[retryKind] = retryIntent
            }
          }
          if (workspaceId !== undefined || value.kind === 'global-consolidate') {
            this.retryConsolidation(current, workspaceId, retryAt, scheduleSnapshot)
          }
          if (value.kind === 'retention' && current.nextRetentionAt === scheduleSnapshot) {
            current.nextRetentionAt = retryAt
          }
        })
        if (retryIntent) {
          this.logActivity(value, 'retry-scheduled', {
            retryIntentId: retryIntent.id,
            retryAt: new Date(this.dueAt(retryIntent)).toISOString(),
          })
        } else if (dropped) {
          this.logActivity(value, 'retry-exhausted')
        }
      } finally {
        if (this.activeIntents.get(key) === value.id) this.activeIntents.delete(key)
        if (this.activeConsolidations.get(key) === value.id) this.activeConsolidations.delete(key)
        // This runs after retry persistence, or when that persistence itself fails.
        if (failed) this.rejectConsolidation(key, value.id)
      }
    }
    this.schedule()
  }

  private resolveConsolidation(kind: string, intentId: string, result: LifecycleIntentRunResult): void {
    const request = this.consolidationRequests.get(kind)
    if (request === undefined || request.settled || request.intentId !== intentId) return
    request.settled = true
    this.consolidationRequests.delete(kind)
    request.resolve(result)
  }

  private rejectConsolidation(kind: string, intentId: string): void {
    const request = this.consolidationRequests.get(kind)
    if (request === undefined || request.settled || request.intentId !== intentId) return
    request.settled = true
    this.consolidationRequests.delete(kind)
    request.reject(new Error(lifecycleErrorMessage(kind)))
  }

  private rejectAllConsolidationRequests(): void {
    for (const [kind, request] of this.consolidationRequests) {
      if (request.settled) continue
      request.settled = true
      this.consolidationRequests.delete(kind)
      request.reject(new Error(lifecycleErrorMessage(kind)))
    }
  }

  private logActivity(
    intent: LifecycleIntent,
    event: LifecycleActivityRecord['event'],
    details: Partial<LifecycleActivityRecord> = {},
  ): void {
    try {
      this.options.activity?.record({
        formatVersion: 1,
        time: this.now().toISOString(),
        event,
        intentId: intent.id,
        ...activityContext(intent.kind),
        ...details,
      })
    } catch {
      // A diagnostic sink cannot change lifecycle execution or persistence.
    }
  }

  private workspaceId(kind: string): WorkspaceId | undefined {
    if (!kind.startsWith('consolidate:')) return undefined
    try {
      return decodeURIComponent(kind.slice('consolidate:'.length)) as WorkspaceId
    } catch {
      return undefined
    }
  }

  /**
   * Consolidation and retention retries persist their absolute retry time in `createdAt`.
   * Session intents take their deadline from the latest in-memory activity and then honour the
   * persisted backoff, so a failing Session still gets a later attempt.
   */
  private dueAt(intent: LifecycleIntent): number {
    const createdAt = new Date(intent.createdAt).getTime()
    const idle = intent.kind.startsWith('idle:')
    const activity = idle ? this.lastActivity.get(intent.kind.slice('idle:'.length)) ?? 0 : 0
    const deadline = idle ? Math.max(createdAt, activity) + this.idleDelayMs : createdAt
    if (intent.retryAt === undefined) return deadline
    const retryAt = new Date(intent.retryAt).getTime()
    return Number.isFinite(retryAt) ? Math.max(deadline, retryAt) : deadline
  }

  private sessionRetryDelayMs(attempts: number): number {
    const base = Math.max(this.idleDelayMs, MIN_SESSION_RETRY_DELAY_MS)
    return Math.min(base * 2 ** Math.max(0, attempts - 1), MAX_SESSION_RETRY_DELAY_MS)
  }

  private get idleDelayMs(): number {
    return (this.options.idleDelayMinutes ?? 60) * 60_000
  }

  private get consolidationDelayMs(): number {
    return (this.options.consolidationCooldownHours ?? 20) * 3_600_000
  }

  private get globalConsolidationDelayMs(): number {
    return (this.options.globalConsolidationCooldownDays ?? 7) * 86_400_000
  }

  private get retentionDelayMs(): number {
    return (this.options.retentionSweepHours ?? 24) * 3_600_000
  }

  private schedule(): void {
    if (!this.started || this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    const meta = this.store.getMeta()
    const now = this.now().getTime()
    const times = Object.values(meta.pending).map(value => this.dueAt(value))
    for (const consolidation of Object.values(meta.workspaceConsolidation)) {
      if (consolidation.dirty && consolidation.nextConsolidationAt) times.push(new Date(consolidation.nextConsolidationAt).getTime())
    }
    if (meta.globalDirty && meta.nextGlobalConsolidationAt) times.push(new Date(meta.nextGlobalConsolidationAt).getTime())
    if (meta.nextRetentionAt) times.push(new Date(meta.nextRetentionAt).getTime())
    if (times.length === 0) {
      this.timer = undefined
      return
    }
    const delay = Math.max(0, Math.min(...times) - now)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.enqueue()
    }, delay)
  }
}

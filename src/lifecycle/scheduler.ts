import { MemoryStoreReadonlyError, type MemoryStore } from '../store/store.js'

export interface LifecycleSchedulerOptions {
  readonly idleDelayMinutes?: number
  readonly consolidationCooldownHours?: number
  readonly retentionSweepHours?: number
  readonly now?: () => Date
  readonly run: (kind: string) => Promise<void>
}

/** Status exposes a stable category, never exception text that may contain paths or secrets. */
export function lifecycleErrorMessage(kind: string): string {
  const separator = kind.indexOf(':')
  const operation = separator < 0 ? kind : kind.slice(0, separator)
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
  private readonly deferredIntents = new Map<string, string>()
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
    if (current.dirty || current.pending.consolidate) {
      const nextRunAt = new Date(this.now().getTime() + value * 3_600_000).toISOString()
      await this.store.updateMeta(meta => {
        if (meta.dirty) meta.nextConsolidationAt = nextRunAt
        if (meta.pending.consolidate) {
          meta.pending.consolidate = { ...meta.pending.consolidate, createdAt: nextRunAt }
        }
      })
    }
    this.options = { ...this.options, consolidationCooldownHours: value }
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
        if (meta.dirty && meta.nextConsolidationAt === null) {
          meta.nextConsolidationAt = new Date(this.now().getTime() + this.consolidationDelayMs).toISOString()
        }
        for (const [kind, createdAt] of deferred) {
          meta.pending[kind] = { kind, createdAt }
        }
      })
      for (const [kind, createdAt] of deferred) {
        if (this.deferredIntents.get(kind) === createdAt) this.deferredIntents.delete(kind)
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
    await this.queue
  }

  async requestIdle(sessionId: string): Promise<void> {
    await this.putIntent(`idle:${sessionId}`, this.now().toISOString())
  }

  async requestReview(sessionId: string): Promise<void> {
    await this.putIntent(`review:${sessionId}`, this.now().toISOString())
  }

  async requestDistill(sessionId: string): Promise<void> {
    await this.putIntent(`stop:${sessionId}`, this.now().toISOString())
  }

  async markDirty(): Promise<void> {
    await this.store.updateMeta(meta => {
      meta.dirty = true
      meta.nextConsolidationAt = new Date(this.now().getTime() + this.consolidationDelayMs).toISOString()
    })
    this.schedule()
  }

  drain(): Promise<void> {
    return this.queue
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private async putIntent(kind: string, createdAt: string): Promise<void> {
    if (this.disposed) return
    if (!this.store.writable) {
      this.deferredIntents.set(kind, createdAt)
      return
    }
    try {
      await this.store.updateMeta(meta => { meta.pending[kind] = { kind, createdAt } })
      this.deferredIntents.delete(kind)
    } catch (error) {
      if (!(error instanceof MemoryStoreReadonlyError)) throw error
      this.deferredIntents.set(kind, createdAt)
      return
    }
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
      const due = Object.entries(meta.pending).find(([, value]) => this.dueAt(value.kind, value.createdAt) <= now)
      const consolidationDue = meta.dirty && meta.nextConsolidationAt !== null
        && new Date(meta.nextConsolidationAt).getTime() <= now
      const retentionDue = meta.nextRetentionAt !== null && new Date(meta.nextRetentionAt).getTime() <= now
      if (!due && !consolidationDue && !retentionDue) break

      const key = due?.[0] ?? (consolidationDue ? 'consolidate' : 'retention')
      const value = due?.[1] ?? { kind: key, createdAt: this.now().toISOString() }
      if (!due) await this.store.updateMeta(current => { current.pending[key] = value })
      try {
        await this.options.run(value.kind)
        await this.store.updateMeta(current => {
          delete current.pending[key]
          current.lastError = null
          if (value.kind === 'consolidate') {
            current.dirty = false
            current.nextConsolidationAt = null
          } else if (value.kind === 'retention') {
            current.lastRetentionAt = this.now().toISOString()
            current.nextRetentionAt = new Date(this.now().getTime() + this.retentionDelayMs).toISOString()
          }
        })
      } catch {
        const delay = value.kind === 'consolidate'
          ? this.consolidationDelayMs
          : value.kind === 'retention'
            ? this.retentionDelayMs
            : this.idleDelayMs
        const retryAt = new Date(this.now().getTime() + delay).toISOString()
        const retryCreatedAt = value.kind === 'consolidate' || value.kind === 'retention'
          ? retryAt
          : this.now().toISOString()
        await this.store.updateMeta(current => {
          current.lastError = lifecycleErrorMessage(value.kind)
          current.pending[key] = {
            kind: value.kind.startsWith('review:') || value.kind.startsWith('stop:')
              ? `idle:${value.kind.slice(value.kind.indexOf(':') + 1)}`
              : value.kind,
            createdAt: retryCreatedAt,
          }
          if (value.kind === 'consolidate') current.nextConsolidationAt = retryAt
          if (value.kind === 'retention') current.nextRetentionAt = retryAt
        })
      }
    }
    this.schedule()
  }

  private dueAt(kind: string, createdAt: string): number {
    const base = new Date(createdAt).getTime()
    // Consolidation and retention retries store their absolute retry timestamp.
    return kind.startsWith('idle:') ? base + this.idleDelayMs : base
  }

  private get idleDelayMs(): number {
    return (this.options.idleDelayMinutes ?? 60) * 60_000
  }

  private get consolidationDelayMs(): number {
    return (this.options.consolidationCooldownHours ?? 20) * 3_600_000
  }

  private get retentionDelayMs(): number {
    return (this.options.retentionSweepHours ?? 24) * 3_600_000
  }

  private schedule(): void {
    if (!this.started || this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    const meta = this.store.getMeta()
    const now = this.now().getTime()
    const times = Object.values(meta.pending).map(value => this.dueAt(value.kind, value.createdAt))
    if (meta.dirty && meta.nextConsolidationAt) times.push(new Date(meta.nextConsolidationAt).getTime())
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

export interface WriterLifecycleRuntimeOptions {
  readonly initiallyActive?: boolean
  readonly retryMs?: number
  readonly prepare: () => Promise<void>
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
  readonly onError: () => void
}

/** Serializes writer transitions and retries transient activation failures while writable. */
export class WriterLifecycleRuntime {
  private writable = false
  private active: boolean
  private disposed = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private transition: Promise<void> = Promise.resolve()

  constructor(private readonly options: WriterLifecycleRuntimeOptions) {
    this.active = options.initiallyActive ?? false
  }

  setWritable(writable: boolean): void {
    this.writable = writable
    if (!writable) this.clearRetry()
    this.enqueue()
  }

  drain(): Promise<void> {
    return this.transition
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.clearRetry()
    await this.transition
  }

  private enqueue(): void {
    this.transition = this.transition.then(() => this.apply()).catch(() => {
      this.options.onError()
    })
  }

  private async apply(): Promise<void> {
    if (this.disposed) return
    if (!this.writable) {
      if (this.active) {
        await this.options.stop()
        this.active = false
      }
      return
    }
    if (this.active) return
    try {
      await this.options.prepare()
      if (!this.writable || this.disposed) return
      await this.options.start()
      this.active = true
    } catch {
      this.options.onError()
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.retry || !this.writable || this.disposed) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.enqueue()
    }, this.options.retryMs ?? 5_000)
    this.retry.unref()
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
  }
}

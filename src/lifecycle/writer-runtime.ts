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

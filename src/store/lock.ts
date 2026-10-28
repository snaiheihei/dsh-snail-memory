import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

interface LockOptions {
  readonly heartbeatMs: number
  readonly lockStaleMs: number
  readonly now: () => Date
}

interface LockRecord {
  readonly writerId: string
  readonly heartbeatAt: string
  readonly state?: 'active' | 'released'
}

interface LockSnapshot {
  readonly text: string
  readonly record: LockRecord | null
}

export class WriterLockOwnershipError extends Error {
  override readonly name = 'WriterLockOwnershipError'
}

export class WriterLock {
  readonly writerId = randomUUID()
  private timer: NodeJS.Timeout | undefined
  private owned = false
  private closed = false
  private handle: FileHandle | undefined
  private monitoring: Promise<void> = Promise.resolve()
  private promotion: Promise<void> = Promise.resolve()
  private onOwnershipChange?: (owned: boolean) => Promise<void>

  private constructor(readonly path: string, private readonly options: LockOptions) {}

  static async acquire(root: string, path: string, options: LockOptions): Promise<WriterLock> {
    await mkdir(root, { recursive: true })
    const lock = new WriterLock(path, options)
    const handle = await lock.tryAcquire()
    if (handle) {
      lock.handle = handle
      lock.owned = true
    }
    return lock
  }

  get writable(): boolean {
    return this.owned
  }

  monitor(onOwnershipChange: (owned: boolean) => Promise<void>): void {
    this.onOwnershipChange = onOwnershipChange
    if (this.timer || this.closed) return
    this.timer = setInterval(() => { void this.tick() }, this.options.heartbeatMs)
    this.timer.unref()
  }

  async assertOwner(): Promise<void> {
    if (!this.owned) throw new WriterLockOwnershipError('This Snail Memory host is read-only')
    const current = await this.read()
    if (current?.writerId !== this.writerId || current.state === 'released') {
      await this.loseOwnership()
      throw new WriterLockOwnershipError('Snail Memory writer fencing rejected a stale host')
    }
  }

  async heartbeat(): Promise<void> {
    await this.assertOwner()
    if (this.owned && this.handle) await this.writeRecord(this.handle, 'active')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.monitoring
    await this.release()
    await this.promotion
  }

  private async tryAcquire(): Promise<FileHandle | null> {
    const created = await this.create()
    if (created) return created
    const expected = await this.staleSnapshot()
    if (!expected) return null
    const quarantine = this.quarantinePath()
    try {
      await rename(this.path, quarantine)
    } catch {
      return null
    }
    try {
      const moved = await this.snapshot(quarantine)
      if (moved?.text !== expected.text) {
        // Another host installed a new lock after our stale read. Put it back
        // without overwriting any lock that may have appeared in the meantime.
        await this.restore(quarantine)
        return null
      }
      const handle = await this.create(quarantine)
      if (!handle) {
        await this.restore(quarantine)
        return null
      }
      await unlink(quarantine).catch(() => {})
      return handle
    } catch {
      await this.restore(quarantine)
      return null
    }
  }

  private tick(): Promise<void> {
    this.monitoring = this.monitoring.then(() => this.tickOnce()).catch(() => {})
    return this.monitoring
  }

  private async tickOnce(): Promise<void> {
    if (this.closed) return
    if (this.owned) {
      try {
        await this.heartbeat()
      } catch {
        if (this.owned) await this.loseOwnership()
      }
      return
    }
    const handle = await this.tryAcquire()
    if (!handle) return
    if (this.closed) {
      await this.releaseHandle(handle)
      return
    }
    this.handle = handle
    this.owned = true
    // Promotion can rebuild projections for longer than one heartbeat interval.
    // Keep the monitoring chain independent so later ticks continue heartbeating.
    this.promotion = (async () => {
      try {
        await this.onOwnershipChange?.(true)
      } catch {
        await this.release()
      }
    })()
  }

  private async loseOwnership(): Promise<void> {
    if (!this.owned) return
    this.owned = false
    const handle = this.handle
    this.handle = undefined
    if (handle) await handle.close().catch(() => {})
    await this.onOwnershipChange?.(false).catch(() => {})
  }

  private async release(): Promise<void> {
    this.owned = false
    const handle = this.handle
    this.handle = undefined
    if (handle) await this.releaseHandle(handle)
  }

  private async releaseHandle(handle: FileHandle): Promise<void> {
    await this.writeRecord(handle, 'released').catch(() => {})
    await handle.close().catch(() => {})
  }

  private async create(allowedQuarantine?: string): Promise<FileHandle | null> {
    if (await this.restoreQuarantined(allowedQuarantine)) return null
    let handle: FileHandle
    try {
      handle = await open(this.path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    try {
      await this.writeRecord(handle, 'active')
      return handle
    } catch (error) {
      await this.releaseHandle(handle)
      throw error
    }
  }

  private quarantinePath(): string {
    return `${this.path}.${randomUUID()}.stale`
  }

  private async restoreQuarantined(except?: string): Promise<boolean> {
    const name = basename(this.path)
    const directory = dirname(this.path)
    const names = await readdir(directory).catch(() => [] as string[])
    const pending = names.filter(candidate => candidate.startsWith(`${name}.`) && candidate.endsWith('.stale'))
      .map(candidate => join(directory, candidate))
      .filter(candidate => candidate !== except)
      .sort()
    for (const candidate of pending) {
      await this.restore(candidate)
      return true
    }
    return false
  }

  private async restore(quarantine: string): Promise<void> {
    try {
      // link publishes only when the destination is absent; rename could
      // overwrite a successor that appeared while recovery was in flight.
      await link(quarantine, this.path)
      await unlink(quarantine).catch(() => {})
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        // A current main lock is authoritative. This quarantine is an obsolete
        // crash remnant, not something to restore on every acquisition attempt.
        await unlink(quarantine).catch(() => {})
        return
      }
      if (code !== 'ENOENT') throw error
    }
  }

  private async staleSnapshot(): Promise<LockSnapshot | null> {
    const current = await this.snapshot(this.path)
    if (!current) return null
    if (current.record?.state === 'released') return current
    const heartbeat = current.record ? Date.parse(current.record.heartbeatAt) : Number.NaN
    if (Number.isFinite(heartbeat)) {
      return this.options.now().getTime() - heartbeat > this.options.lockStaleMs ? current : null
    }
    const info = await stat(this.path).catch(() => null)
    return info && this.options.now().getTime() - info.mtimeMs > this.options.lockStaleMs ? current : null
  }

  private async read(): Promise<LockRecord | null> {
    return (await this.snapshot(this.path))?.record ?? null
  }

  private async snapshot(path: string): Promise<LockSnapshot | null> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object') return { text, record: null }
      const record = value as Partial<LockRecord>
      return typeof record.writerId === 'string' && typeof record.heartbeatAt === 'string'
        && (record.state === undefined || record.state === 'active' || record.state === 'released')
        ? { text, record: { writerId: record.writerId, heartbeatAt: record.heartbeatAt, ...(record.state === undefined ? {} : { state: record.state }) } }
        : { text, record: null }
    } catch {
      return { text, record: null }
    }
  }

  private async writeRecord(handle: FileHandle, state: 'active' | 'released'): Promise<void> {
    const text = JSON.stringify({ writerId: this.writerId, heartbeatAt: this.options.now().toISOString(), state })
    const data = Buffer.from(text)
    await handle.write(data, 0, data.length, 0)
    await handle.truncate(data.length)
  }
}

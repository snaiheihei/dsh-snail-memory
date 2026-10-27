import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

interface LockOptions {
  readonly heartbeatMs: number
  readonly lockStaleMs: number
  readonly now: () => Date
}

interface LockRecord {
  readonly writerId: string
  readonly heartbeatAt: string
}

export class WriterLock {
  readonly writerId = randomUUID()
  private timer?: NodeJS.Timeout
  private owned = false

  private constructor(readonly path: string, private readonly options: LockOptions) {}

  static async acquire(root: string, path: string, options: LockOptions): Promise<WriterLock> {
    await mkdir(root, { recursive: true })
    const lock = new WriterLock(path, options)
    lock.owned = await lock.create()
    if (!lock.owned && await lock.isStale()) {
      const stale = `${path}.${randomUUID()}.stale`
      try {
        await rename(path, stale)
        await unlink(stale)
        lock.owned = await lock.create()
      } catch {
        lock.owned = false
      }
    }
    if (lock.owned) lock.startHeartbeat()
    return lock
  }

  get writable(): boolean {
    return this.owned
  }

  async assertOwner(): Promise<void> {
    if (!this.owned) throw new Error('This Snail Memory host is read-only')
    const current = await this.read()
    if (current?.writerId !== this.writerId) {
      this.owned = false
      throw new Error('Snail Memory writer fencing rejected a stale host')
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (!this.owned) return
    this.owned = false
    const current = await this.read().catch(() => null)
    if (current?.writerId === this.writerId) await unlink(this.path).catch(() => {})
  }

  private async create(): Promise<boolean> {
    try {
      const handle = await open(this.path, 'wx')
      await handle.writeFile(this.serialize())
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  private async isStale(): Promise<boolean> {
    const current = await this.read().catch(() => null)
    const heartbeat = current ? Date.parse(current.heartbeatAt) : Number.NaN
    if (Number.isFinite(heartbeat)) return this.options.now().getTime() - heartbeat > this.options.lockStaleMs
    const info = await stat(this.path).catch(() => null)
    return info ? this.options.now().getTime() - info.mtimeMs > this.options.lockStaleMs : false
  }

  private async read(): Promise<LockRecord | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object') return null
      const record = value as Partial<LockRecord>
      return typeof record.writerId === 'string' && typeof record.heartbeatAt === 'string'
        ? { writerId: record.writerId, heartbeatAt: record.heartbeatAt }
        : null
    } catch {
      return null
    }
  }

  private serialize(): string {
    return JSON.stringify({ writerId: this.writerId, heartbeatAt: this.options.now().toISOString() })
  }

  private startHeartbeat(): void {
    this.timer = setInterval(async () => {
      if (!this.owned) return
      try {
        await this.assertOwner()
        await writeFile(this.path, this.serialize(), 'utf8')
      } catch {
        this.owned = false
      }
    }, this.options.heartbeatMs)
    this.timer.unref()
  }
}

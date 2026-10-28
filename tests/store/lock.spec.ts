import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WriterLock } from '../../src/store/lock.js'

const control = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((path: string) => Promise<void>),
  beforeHeartbeat: undefined as undefined | (() => Promise<void>),
  afterHeartbeat: undefined as undefined | (() => void),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[0]).endsWith('lock.json')) await control.beforeRename?.(String(args[0]))
      return actual.rename(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith('lock.json')) await control.beforeHeartbeat?.()
      const result = await actual.writeFile(...args)
      if (String(args[0]).endsWith('lock.json')) control.afterHeartbeat?.()
      return result
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!String(args[0]).endsWith('lock.json')) return handle
      const writeFile = handle.writeFile.bind(handle)
      const write = handle.write.bind(handle)
      handle.writeFile = async (...writeArgs: Parameters<typeof writeFile>) => {
        await control.beforeHeartbeat?.()
        const result = await writeFile(...writeArgs)
        control.afterHeartbeat?.()
        return result
      }
      handle.write = (async (...writeArgs: Parameters<typeof write>) => {
        await control.beforeHeartbeat?.()
        const result = await write(...writeArgs)
        control.afterHeartbeat?.()
        return result
      }) as typeof write
      return handle
    },
  }
})

const roots: string[] = []
const locks: WriterLock[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'snail-memory-lock-'))
  roots.push(path)
  return path
}

async function acquire(path: string, heartbeatMs = 60_000, lockStaleMs = 30_000): Promise<WriterLock> {
  const lock = await WriterLock.acquire(path, join(path, 'lock.json'), {
    heartbeatMs,
    lockStaleMs,
    now: () => new Date(),
  })
  locks.push(lock)
  return lock
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(async () => {
  control.beforeRename = undefined
  control.beforeHeartbeat = undefined
  control.afterHeartbeat = undefined
  await Promise.all(locks.splice(0).map(lock => lock.close()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WriterLock', () => {
  it('allows only one host to acquire when two hosts observed the same stale lock', async () => {
    const path = await root()
    await writeFile(join(path, 'lock.json'), JSON.stringify({
      writerId: 'dead-writer',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    }))
    const firstRename = deferred()
    const secondRename = deferred()
    const firstAcquired = deferred()
    const releaseFirst = deferred()
    let renames = 0
    control.beforeRename = async () => {
      renames += 1
      if (renames === 1) {
        firstRename.resolve()
        await releaseFirst.promise
      } else if (renames === 2) {
        secondRename.resolve()
        await firstAcquired.promise
      }
    }

    const firstPromise = acquire(path).then(lock => {
      firstAcquired.resolve()
      return lock
    })
    await firstRename.promise
    const secondPromise = acquire(path)
    await secondRename.promise
    releaseFirst.resolve()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect([first.writable, second.writable].filter(Boolean)).toHaveLength(1)
  })

  it('recovers a quarantined lock left by a crashed takeover', async () => {
    const path = await root()
    const lockPath = join(path, 'lock.json')
    await writeFile(lockPath, JSON.stringify({
      writerId: 'dead-writer',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    }))
    await rename(lockPath, `${lockPath}.crash.stale`)

    const lock = await acquire(path)

    expect(lock.writable).toBe(true)
    expect((await readdir(path)).filter(name => name.endsWith('.stale'))).toEqual([])
  })

  it('cleans an orphaned quarantine instead of repeatedly displacing the current lock', async () => {
    const path = await root()
    const lockPath = join(path, 'lock.json')
    await writeFile(lockPath, JSON.stringify({
      writerId: 'previous-writer',
      heartbeatAt: new Date().toISOString(),
      state: 'released',
    }))
    await writeFile(`${lockPath}.crash.stale`, JSON.stringify({
      writerId: 'crashed-writer',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    }))
    const lock = await acquire(path, 10)
    lock.monitor(async () => {})

    await vi.waitFor(() => expect(lock.writable).toBe(true), { timeout: 500 })
    expect((await readdir(path)).filter(name => name.endsWith('.stale'))).toEqual([])
  })

  it('does not let an old heartbeat overwrite a replacement lock', async () => {
    const path = await root()
    const lockPath = join(path, 'lock.json')
    const writer = await acquire(path, 10)
    const heartbeatStarted = deferred()
    const heartbeatFinished = deferred()
    const finishHeartbeat = deferred()
    writer.monitor(async () => {})
    control.beforeHeartbeat = async () => {
      heartbeatStarted.resolve()
      await finishHeartbeat.promise
    }
    await heartbeatStarted.promise

    control.beforeHeartbeat = undefined
    const replacement = `${lockPath}.replacement`
    await writeFile(replacement, JSON.stringify({
      writerId: 'replacement-writer',
      heartbeatAt: new Date().toISOString(),
    }))
    let replacementPublished = true
    try {
      await rename(replacement, lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      replacementPublished = false
    }
    control.afterHeartbeat = () => { heartbeatFinished.resolve() }
    finishHeartbeat.resolve()
    await heartbeatFinished.promise

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      writerId: replacementPublished ? 'replacement-writer' : writer.writerId,
    })
  })

  it('continues heartbeating while an ownership transition is pending', async () => {
    const path = await root()
    const lockPath = join(path, 'lock.json')
    await writeFile(lockPath, JSON.stringify({
      writerId: 'previous-writer',
      heartbeatAt: new Date().toISOString(),
    }))
    const lock = await acquire(path, 10, 100)
    expect(lock.writable).toBe(false)
    const promoted = deferred()
    const finishPromotion = deferred()
    lock.monitor(async owned => {
      if (!owned) return
      promoted.resolve()
      await finishPromotion.promise
    })
    await promoted.promise
    const acquiredHeartbeat = JSON.parse(await readFile(lockPath, 'utf8')).heartbeatAt as string

    try {
      await vi.waitFor(() => {
        const current = JSON.parse(controlRead(lockPath)).heartbeatAt as string
        expect(Date.parse(current)).toBeGreaterThan(Date.parse(acquiredHeartbeat))
      }, { timeout: 500 })
    } finally {
      finishPromotion.resolve()
    }
  })
})

function controlRead(path: string): string {
  return readFileSync(path, 'utf8')
}

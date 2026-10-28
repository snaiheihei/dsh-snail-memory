import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleScheduler, WriterLifecycleRuntime } from '../../src/lifecycle/scheduler.js'
import { WriterLock } from '../../src/store/lock.js'
import { emptyState, MemoryStore } from '../../src/store/store.js'

const roots: string[] = []
const stores: MemoryStore[] = []

async function openStore(heartbeatMs = 48 * 3_600_000) {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-scheduler-'))
  roots.push(root)
  const store = await MemoryStore.open({ root, heartbeatMs })
  stores.push(store)
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, recursiveForce)))
})

const recursiveForce = { recursive: true, force: true }

describe('LifecycleScheduler', () => {
  it('debounces idle work and runs review immediately with one timer', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: 15,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()

    await scheduler.requestIdle('session-1')
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(runs).toEqual([])
    await scheduler.requestIdle('session-1')
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toEqual(['idle:session-1'])

    await scheduler.requestReview('session-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual(['idle:session-1', 'review:session-1'])
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })

  it('pauses during a read-only transition and resumes persisted work after promotion', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: 15,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()
    await scheduler.requestIdle('session-1')

    await scheduler.stop()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(runs).toEqual([])

    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()
    expect(runs).toEqual(['idle:session-1'])
    await scheduler.dispose()
  })

  it('persists a terminal intent received while paused', async () => {
    const store = await openStore()
    const scheduler = new LifecycleScheduler(store, { run: async () => {} })
    await scheduler.start()
    await scheduler.stop()

    await scheduler.requestDistill('session-1')

    expect(store.getMeta().pending['stop:session-1']).toBeDefined()
    await scheduler.dispose()
  })

  it('defers a read-only intent and persists it after lock promotion', async () => {
    const writer = await openStore()
    const root = writer.paths.root
    const reader = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(reader)
    const scheduler = new LifecycleScheduler(reader, { run: async () => {} })

    await scheduler.requestDistill('session-1')
    expect(reader.writable).toBe(false)
    await writer.close()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(reader.writable).toBe(true))
    await scheduler.start()

    expect(reader.getMeta().pending['stop:session-1']).toBeDefined()
    await scheduler.dispose()
  })

  it('defers an intent when writer fencing fails after the writable check', async () => {
    const store = await openStore(1_000)
    const scheduler = new LifecycleScheduler(store, { run: async () => {} })
    const assertOwner = WriterLock.prototype.assertOwner
    vi.spyOn(WriterLock.prototype, 'assertOwner').mockImplementationOnce(async function (this: WriterLock) {
      await writeFile(store.paths.lock, JSON.stringify({
        writerId: 'successor',
        heartbeatAt: new Date().toISOString(),
        state: 'active',
      }))
      await assertOwner.call(this)
    })

    await scheduler.requestDistill('session-1')
    expect(store.writable).toBe(false)
    await writeFile(store.paths.lock, JSON.stringify({
      writerId: 'successor',
      heartbeatAt: new Date().toISOString(),
      state: 'released',
    }))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(store.writable).toBe(true))
    await scheduler.start()

    expect(store.getMeta().pending['stop:session-1']).toBeDefined()
    await scheduler.dispose()
  })

  it('keeps an intent added while start is committing an earlier deferred snapshot', async () => {
    const state = emptyState()
    let writable = false
    let updates = 0
    let commit!: () => void
    const mayCommit = new Promise<void>(resolve => { commit = resolve })
    const store = {
      get writable() { return writable },
      getMeta: () => structuredClone(state.meta),
      updateMeta: async (update: Parameters<MemoryStore['updateMeta']>[0]) => {
        const draft = structuredClone(state.meta)
        update(draft)
        updates += 1
        if (updates === 1) await mayCommit
        state.meta = draft
        return structuredClone(draft)
      },
    } as unknown as MemoryStore
    const scheduler = new LifecycleScheduler(store, { run: async () => {} })
    await scheduler.requestDistill('session-before')
    writable = true
    const starting = scheduler.start()

    writable = false
    await scheduler.requestDistill('session-during')
    commit()
    await starting
    await scheduler.stop()
    writable = true
    await scheduler.start()

    expect(state.meta.pending['stop:session-during']).toBeDefined()
    await scheduler.dispose()
  })

  it('reschedules an existing idle intent when the delay changes', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: 15,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()
    await scheduler.requestIdle('session-1')

    scheduler.updateIdleDelayMinutes(5)
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toEqual(['idle:session-1'])
    await scheduler.dispose()
  })

  it('reschedules dirty consolidation when its delay changes', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 20,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()
    await scheduler.markDirty()
    expect(store.getMeta().nextConsolidationAt).toBe('2026-10-26T20:00:00.000Z')

    await scheduler.updateConsolidationCooldownHours(2)
    expect(store.getMeta().nextConsolidationAt).toBe('2026-10-26T02:00:00.000Z')
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate'])
    await scheduler.dispose()
  })

  it('persists consolidation schedule and retry state across restart', async () => {
    const store = await openStore()
    let failures = 1
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 6,
      run: async kind => {
        runs.push(kind)
        if (failures-- > 0) throw new Error('model unavailable')
      },
    })
    await scheduler.start()
    await scheduler.markDirty()
    expect(store.getMeta()).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-26T06:00:00.000Z' })

    await vi.advanceTimersByTimeAsync(6 * 3_600_000 - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate'])
    expect(store.getMeta().lastError).toBe('Memory consolidation failed')
    expect(store.getMeta().lastError).not.toContain('model unavailable')
    expect(store.getMeta().nextConsolidationAt).toBe('2026-10-26T12:00:00.000Z')

    await scheduler.dispose()
    const restarted = new LifecycleScheduler(store, { run: async kind => { runs.push(kind) } })
    await restarted.start()
    await vi.advanceTimersByTimeAsync(6 * 3_600_000)
    await restarted.drain()

    expect(runs).toEqual(['consolidate', 'consolidate'])
    expect(store.getMeta().dirty).toBe(false)
    expect(store.getMeta().lastError).toBeNull()
    await restarted.dispose()
  })

  it('runs retention on the persisted daily schedule and drains before dispose', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, { run: async kind => {
      runs.push(kind)
    } })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    const disposing = scheduler.dispose()
    await disposing

    expect(runs).toEqual(['retention'])
    expect(store.getMeta().nextRetentionAt).toBe('2026-10-28T00:00:00.000Z')
    await store.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('WriterLifecycleRuntime', () => {
  it('retries agent preparation and lifecycle startup while the host stays writable', async () => {
    let preparations = 0
    let starts = 0
    let stops = 0
    let errors = 0
    const runtime = new WriterLifecycleRuntime({
      retryMs: 1_000,
      prepare: async () => {
        preparations += 1
        if (preparations === 1) throw new Error('agent temporarily unavailable')
      },
      start: async () => {
        starts += 1
        if (starts === 1) throw new Error('state temporarily unavailable')
      },
      stop: async () => { stops += 1 },
      onError: () => { errors += 1 },
    })

    runtime.setWritable(true)
    await runtime.drain()
    expect({ preparations, starts, stops, errors }).toEqual({ preparations: 1, starts: 0, stops: 0, errors: 1 })

    await vi.advanceTimersByTimeAsync(1_000)
    await runtime.drain()
    expect({ preparations, starts, stops, errors }).toEqual({ preparations: 2, starts: 1, stops: 0, errors: 2 })

    await vi.advanceTimersByTimeAsync(1_000)
    await runtime.drain()
    expect({ preparations, starts, stops, errors }).toEqual({ preparations: 3, starts: 2, stops: 0, errors: 2 })

    runtime.setWritable(false)
    await runtime.drain()
    expect(stops).toBe(1)
    await runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending retry when writability is lost', async () => {
    let preparations = 0
    let starts = 0
    const runtime = new WriterLifecycleRuntime({
      retryMs: 1_000,
      prepare: async () => {
        preparations += 1
        if (preparations === 1) throw new Error('agent temporarily unavailable')
      },
      start: async () => { starts += 1 },
      stop: async () => {},
      onError: () => {},
    })

    runtime.setWritable(true)
    await runtime.drain()
    runtime.setWritable(false)
    await runtime.drain()
    await vi.advanceTimersByTimeAsync(2_000)
    await runtime.drain()
    expect({ preparations, starts }).toEqual({ preparations: 1, starts: 0 })

    runtime.setWritable(true)
    await runtime.drain()
    expect({ preparations, starts }).toEqual({ preparations: 2, starts: 1 })
    await runtime.dispose()
  })
})

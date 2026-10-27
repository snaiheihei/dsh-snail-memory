import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleScheduler } from '../../src/lifecycle/scheduler.js'
import { MemoryStore } from '../../src/store/store.js'

const roots: string[] = []
const stores: MemoryStore[] = []

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-scheduler-'))
  roots.push(root)
  const store = await MemoryStore.open({ root, heartbeatMs: 48 * 3_600_000 })
  stores.push(store)
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))
})

afterEach(async () => {
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

  it('persists consolidation schedule and retry state across restart', async () => {
    const store = await openStore()
    let failures = 1
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
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

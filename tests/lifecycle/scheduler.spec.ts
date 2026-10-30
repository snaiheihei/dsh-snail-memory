import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LifecycleActivityRecord } from '../../src/lifecycle/activity.js'
import { LifecycleScheduler } from '../../src/lifecycle/scheduler.js'
import { WriterLifecycleRuntime } from '../../src/lifecycle/writer-runtime.js'
import { WriterLock } from '../../src/store/lock.js'
import { emptyState } from '../../src/store/json.js'
import { MemoryStore } from '../../src/store/store.js'
import { workspaceId } from '../../src/store/types.js'

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

  it('keeps a newer same-kind intent when an older run succeeds', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const scheduler = new LifecycleScheduler(store, {
      run: async () => {
        markRunStarted()
        await runGate
      },
    })
    await scheduler.start()
    await scheduler.requestReview('session-1')
    const advancing = vi.advanceTimersByTimeAsync(0)
    await runStarted

    await scheduler.requestReview('session-1')
    const stopping = scheduler.stop()
    releaseRun()
    await advancing
    await stopping

    expect(store.getMeta().pending['review:session-1']).toBeDefined()
    await scheduler.dispose()
  })

  it.each(['succeeds', 'fails'])('keeps a refreshed idle intent when an older run %s', async outcome => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: 0,
      run: async () => {
        markRunStarted()
        await runGate
        if (outcome === 'fails') throw new Error('model unavailable')
      },
    })
    await scheduler.start()
    await scheduler.requestIdle('session-1')
    const advancing = vi.advanceTimersByTimeAsync(0)
    await runStarted

    await scheduler.requestIdle('session-1')
    const refreshed = store.getMeta().pending['idle:session-1']
    const stopping = scheduler.stop()
    releaseRun()
    await advancing
    await stopping

    expect(store.getMeta().pending['idle:session-1']).toEqual(refreshed)
    await scheduler.dispose()
  })

  it('does not let a failed review overwrite a newer idle intent', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const scheduler = new LifecycleScheduler(store, {
      run: async () => {
        markRunStarted()
        await runGate
        throw new Error('model unavailable')
      },
    })
    await scheduler.start()
    await scheduler.requestReview('session-1')
    const advancing = vi.advanceTimersByTimeAsync(0)
    await runStarted

    await scheduler.requestIdle('session-1')
    const idle = store.getMeta().pending['idle:session-1']
    const stopping = scheduler.stop()
    releaseRun()
    await advancing
    await stopping

    expect(store.getMeta().pending['review:session-1']).toBeUndefined()
    expect(store.getMeta().pending['idle:session-1']).toEqual(idle)
    await scheduler.dispose()
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
    await scheduler.markDirty('workspace-1')
    expect(store.getMeta().workspaceConsolidation['workspace-1']?.nextConsolidationAt).toBe('2026-10-26T20:00:00.000Z')

    await scheduler.updateConsolidationCooldownHours(2)
    expect(store.getMeta().workspaceConsolidation['workspace-1']?.nextConsolidationAt).toBe('2026-10-26T02:00:00.000Z')
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate:workspace-1'])
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
    await scheduler.markDirty('workspace-1')
    expect(store.getMeta().workspaceConsolidation['workspace-1']).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-26T06:00:00.000Z' })

    await vi.advanceTimersByTimeAsync(6 * 3_600_000 - 1)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate:workspace-1'])
    expect(store.getMeta().lastError).toBe('Memory consolidation failed')
    expect(store.getMeta().lastError).not.toContain('model unavailable')
    expect(store.getMeta().workspaceConsolidation['workspace-1']?.nextConsolidationAt).toBe('2026-10-26T12:00:00.000Z')

    await scheduler.dispose()
    const restarted = new LifecycleScheduler(store, { run: async kind => { runs.push(kind) } })
    await restarted.start()
    await vi.advanceTimersByTimeAsync(6 * 3_600_000)
    await restarted.drain()

    expect(runs).toEqual(['consolidate:workspace-1', 'consolidate:workspace-1'])
    expect(store.getMeta().workspaceConsolidation['workspace-1']?.dirty).toBe(false)
    expect(store.getMeta().lastError).toBeNull()
    await restarted.dispose()
  })

  it('schedules workspace and global consolidation independently and hot-updates only the global delay', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 20,
      globalConsolidationCooldownDays: 7,
      retentionSweepHours: 1_000,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()
    await scheduler.markDirty('workspace-1')
    await scheduler.markGlobalDirty()

    expect(store.getMeta()).toMatchObject({
      workspaceConsolidation: { 'workspace-1': { dirty: true, nextConsolidationAt: '2026-10-26T20:00:00.000Z' } },
      globalDirty: true,
      nextGlobalConsolidationAt: '2026-11-02T00:00:00.000Z',
    })
    await scheduler.updateGlobalConsolidationCooldownDays(2)
    expect(store.getMeta().workspaceConsolidation['workspace-1']?.nextConsolidationAt).toBe('2026-10-26T20:00:00.000Z')
    expect(store.getMeta().nextGlobalConsolidationAt).toBe('2026-10-28T00:00:00.000Z')

    await vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate:workspace-1'])
    expect(store.getMeta()).toMatchObject({ workspaceConsolidation: { 'workspace-1': { dirty: false } }, globalDirty: true })

    await vi.advanceTimersByTimeAsync(28 * 3_600_000)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate:workspace-1', 'global-consolidate'])
    expect(store.getMeta()).toMatchObject({
      workspaceConsolidation: { 'workspace-1': { dirty: false } },
      globalDirty: false,
      lastGlobalConsolidationAt: '2026-10-28T00:00:00.000Z',
      nextGlobalConsolidationAt: null,
    })
    await scheduler.dispose()
  })

  it('retries global consolidation without dirtying or rescheduling workspace consolidation', async () => {
    const store = await openStore()
    let failures = 1
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 20,
      globalConsolidationCooldownDays: 7,
      retentionSweepHours: 1_000,
      run: async kind => {
        runs.push(kind)
        if (kind === 'global-consolidate' && failures-- > 0) throw new Error('model unavailable')
      },
    })
    await scheduler.start()
    await scheduler.markGlobalDirty()
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000)
    await scheduler.drain()

    expect(runs).toEqual(['global-consolidate'])
    expect(store.getMeta()).toMatchObject({
      workspaceConsolidation: {},
      globalDirty: true,
      nextGlobalConsolidationAt: '2026-11-09T00:00:00.000Z',
      lastError: 'Global memory consolidation failed',
    })

    await scheduler.dispose()
    const restarted = new LifecycleScheduler(store, {
      globalConsolidationCooldownDays: 7,
      run: async kind => { runs.push(kind) },
    })
    await restarted.start()
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000)
    await restarted.drain()

    expect(runs).toEqual(['global-consolidate', 'global-consolidate'])
    expect(store.getMeta()).toMatchObject({ workspaceConsolidation: {}, globalDirty: false, lastError: null })
    await restarted.dispose()
  })

  it('keeps Global changes scheduled when they arrive during an older consolidation run', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const scheduler = new LifecycleScheduler(store, {
      globalConsolidationCooldownDays: 7,
      retentionSweepHours: 1_000,
      run: async kind => {
        if (kind !== 'global-consolidate') return
        markRunStarted()
        await runGate
      },
    })
    await scheduler.start()
    await scheduler.markGlobalDirty()
    const advancing = vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000)
    await runStarted

    await store.upsert({
      scope: { kind: 'global' },
      category: 'preference',
      summary: 'Promoted during consolidation',
      detail: 'This change still needs a later consolidation.',
      sourceRefs: [],
      lastVerifiedAt: '2026-11-02T00:00:00.000Z',
    })
    await scheduler.markGlobalDirty()
    releaseRun()
    await advancing
    await scheduler.drain()

    expect(store.getMeta()).toMatchObject({
      globalDirty: true,
      nextGlobalConsolidationAt: '2026-11-09T00:00:00.000Z',
    })
    await scheduler.dispose()
  })

  it('reschedules every dirty workspace independently when the cooldown changes', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 20,
      run: async kind => { runs.push(kind) },
    })
    await scheduler.start()
    await scheduler.markDirty('test_only')
    await scheduler.markDirty('dsh_memory')

    await scheduler.updateConsolidationCooldownHours(2)

    expect(store.getMeta().workspaceConsolidation).toMatchObject({
      test_only: { dirty: true, nextConsolidationAt: '2026-10-26T02:00:00.000Z' },
      dsh_memory: { dirty: true, nextConsolidationAt: '2026-10-26T02:00:00.000Z' },
    })
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)
    await scheduler.drain()
    expect(runs).toEqual(['consolidate:test_only', 'consolidate:dsh_memory'])
    await scheduler.dispose()
  })

  it('restores an overdue workspace retry after closing and reopening the store', async () => {
    const store = await openStore()
    const root = store.paths.root
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 6,
      run: async kind => {
        runs.push(kind)
        throw new Error('model unavailable')
      },
    })
    await scheduler.start()
    await scheduler.markDirty('test_only')
    await vi.advanceTimersByTimeAsync(6 * 3_600_000)
    await scheduler.drain()
    await scheduler.dispose()
    await store.close()

    const restored = await MemoryStore.open({ root, heartbeatMs: 48 * 3_600_000 })
    stores.push(restored)
    const restarted = new LifecycleScheduler(restored, {
      consolidationCooldownHours: 6,
      run: async kind => { runs.push(kind) },
    })
    await restarted.start()
    await vi.advanceTimersByTimeAsync(6 * 3_600_000)
    await restarted.drain()

    expect(runs).toEqual(['consolidate:test_only', 'consolidate:test_only'])
    expect(restored.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: false, nextConsolidationAt: null })
    await restarted.dispose()
  })

  it('discards a persisted workspace intent when its scope is already clean', async () => {
    const store = await openStore()
    const runs: string[] = []
    await store.updateMeta(meta => {
      meta.workspaceConsolidation = {
        test_only: { dirty: false, nextConsolidationAt: null, lastConsolidationAt: '2026-10-26T00:00:00.000Z' },
        dsh_memory: { dirty: true, nextConsolidationAt: '2026-10-26T00:00:00.000Z', lastConsolidationAt: null },
      }
      meta.pending['consolidate:test_only'] = {
        id: 'stale-clean-intent', kind: 'consolidate:test_only', createdAt: '2026-10-26T00:00:00.000Z',
      }
    })
    const scheduler = new LifecycleScheduler(store, {
      retentionSweepHours: 1_000,
      run: async kind => { runs.push(kind) },
    })

    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()

    expect(runs).toEqual(['consolidate:dsh_memory'])
    expect(store.getMeta().pending['consolidate:test_only']).toBeUndefined()
    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: false })
    await scheduler.dispose()
  })

  it('preserves a newer same-workspace schedule while allowing another workspace to finish', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      consolidationCooldownHours: 20,
      retentionSweepHours: 1_000,
      run: async kind => {
        runs.push(kind)
        if (kind === 'consolidate:test_only') {
          markRunStarted()
          await runGate
        } else {
          markRunStarted()
        }
      },
    })
    await scheduler.start()
    await scheduler.markDirty('test_only')
    await scheduler.markDirty('dsh_memory')
    const advancing = vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await runStarted

    vi.setSystemTime(new Date('2026-10-26T21:00:00.000Z'))
    await scheduler.markDirty('test_only')
    releaseRun()
    await advancing
    await scheduler.drain()

    expect(runs).toEqual(['consolidate:test_only', 'consolidate:dsh_memory'])
    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-27T17:00:00.000Z' })
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toMatchObject({ dirty: false, nextConsolidationAt: null })
    await scheduler.dispose()
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
  it('records one intent lifecycle with batch statistics and a shared intent id', async () => {
    const store = await openStore()
    const records: LifecycleActivityRecord[] = []
    const scheduler = new LifecycleScheduler(store, {
      activity: { record: record => { records.push(record) } },
      run: async () => {
        vi.setSystemTime(new Date('2026-10-26T00:00:00.125Z'))
        return {
          written: 2,
          batches: 1,
          processed: true,
          batchResults: [{ written: 2, rejected: 0, cursor: { lastEventSeq: 4, offset: 0 } }],
        }
      },
    })
    await scheduler.start()
    await scheduler.requestReview('session-1')
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()

    expect(records.map(record => record.event)).toEqual([
      'intent-created', 'run-started', 'batch-completed', 'run-succeeded',
    ])
    expect(new Set(records.map(record => record.intentId)).size).toBe(1)
    expect(records.at(-1)).toMatchObject({
      operation: 'review', sessionId: 'session-1', durationMs: 125, batches: 1, written: 2,
      cursor: { lastEventSeq: 4, offset: 0 },
    })
    expect(records[2]).toMatchObject({ event: 'batch-completed', batch: 1, written: 2 })
    await scheduler.dispose()
  })

  it('does not log every idle debounce refresh as a new intent', async () => {
    const store = await openStore()
    const records: LifecycleActivityRecord[] = []
    const scheduler = new LifecycleScheduler(store, {
      idleDelayMinutes: 15,
      activity: { record: record => { records.push(record) } },
      run: async () => ({ written: 0, batches: 0, processed: true }),
    })
    await scheduler.start()
    await scheduler.requestIdle('session-1')
    await scheduler.requestIdle('session-1')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await scheduler.drain()

    expect(records.filter(record => record.event === 'intent-created')).toHaveLength(1)
    expect(records.map(record => record.event)).toEqual(['intent-created', 'run-started', 'run-succeeded'])
    expect(new Set(records.map(record => record.intentId)).size).toBe(1)
    await scheduler.dispose()
  })

  it('records stable failure and retry metadata without exception text', async () => {
    const store = await openStore()
    const records: LifecycleActivityRecord[] = []
    const scheduler = new LifecycleScheduler(store, {
      activity: { record: record => { records.push(record) } },
      run: async () => { throw new Error('private provider diagnostic') },
    })
    await scheduler.start()
    await scheduler.requestReview('session-1')
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()

    expect(records.map(record => record.event)).toEqual([
      'intent-created', 'run-started', 'run-failed', 'retry-scheduled',
    ])
    expect(records.at(-2)).toMatchObject({ event: 'run-failed', error: 'operation-failed' })
    expect(records.at(-1)).toMatchObject({
      event: 'retry-scheduled',
      retryIntentId: store.getMeta().pending['idle:session-1']?.id,
      retryAt: '2026-10-26T01:00:00.000Z',
    })
    expect(JSON.stringify(records)).not.toContain('private provider diagnostic')
    await scheduler.dispose()
  })

  it('logs a detailed sanitized output failure for manual consolidation', async () => {
    const store = await openStore()
    const records: LifecycleActivityRecord[] = []
    const scheduler = new LifecycleScheduler(store, {
      activity: { record: record => { records.push(record) } },
      run: async () => {
        throw Object.assign(new Error('raw model response must not be logged'), {
          activityCategory: 'model-output-invalid-json',
        })
      },
    })
    await scheduler.start()
    const request = scheduler.requestConsolidation({ kind: 'workspace', workspaceId: workspaceId('test_only') })
    const assertion = expect(request).rejects.toMatchObject({ message: 'Memory consolidation failed' })
    await vi.advanceTimersByTimeAsync(0)
    await assertion

    expect(records.map(record => record.event)).toEqual([
      'intent-created', 'run-started', 'run-failed', 'retry-scheduled',
    ])
    expect(records.at(-2)).toMatchObject({
      operation: 'consolidate',
      workspaceId: 'test_only',
      event: 'run-failed',
      error: 'model-output-invalid-json',
    })
    expect(JSON.stringify(records)).not.toContain('raw model response')
    await scheduler.dispose()
  })

  it('logs a clean persisted workspace intent as skipped without executing it', async () => {
    const store = await openStore()
    const records: LifecycleActivityRecord[] = []
    const run = vi.fn(async () => ({ written: 0, batches: 0, processed: true }))
    await store.updateMeta(meta => {
      meta.workspaceConsolidation.test_only = {
        dirty: false, nextConsolidationAt: null, lastConsolidationAt: '2026-10-26T00:00:00.000Z',
      }
      meta.pending['consolidate:test_only'] = {
        id: 'clean-intent', kind: 'consolidate:test_only', createdAt: '2026-10-26T00:00:00.000Z',
      }
    })
    const scheduler = new LifecycleScheduler(store, {
      retentionSweepHours: 1_000,
      activity: { record: record => { records.push(record) } },
      run,
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()

    expect(run).not.toHaveBeenCalled()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'run-skipped', operation: 'consolidate', intentId: 'clean-intent',
      workspaceId: 'test_only', skipReason: 'workspace-clean',
    })
    await scheduler.dispose()
  })

  it('does not turn a successful run into a failure when its activity sink throws', async () => {
    const store = await openStore()
    const scheduler = new LifecycleScheduler(store, {
      activity: { record: () => { throw new Error('log write failed') } },
      run: async () => ({ written: 1, batches: 1, processed: true }),
    })
    await scheduler.start()
    await scheduler.requestReview('session-1')
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.drain()

    expect(store.getMeta().pending['review:session-1']).toBeUndefined()
    expect(store.getMeta().lastError).toBeNull()
    await scheduler.dispose()
  })

  it('runs manual workspace consolidation immediately even when the scope is clean', async () => {
    const store = await openStore()
    const runs: string[] = []
    const scheduler = new LifecycleScheduler(store, {
      run: async kind => {
        runs.push(kind)
        return { written: 2, batches: 0, processed: true }
      },
    })
    await scheduler.start()

    const request = scheduler.requestConsolidation({ kind: 'workspace', workspaceId: workspaceId('test_only') })
    await vi.advanceTimersByTimeAsync(0)

    await expect(request).resolves.toMatchObject({
      intentId: expect.any(String), written: 2, batches: 0, processed: true,
    })
    expect(runs).toEqual(['consolidate:test_only'])
    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({
      dirty: false,
      nextConsolidationAt: null,
      lastConsolidationAt: '2026-10-26T00:00:00.000Z',
    })
    expect(store.getMeta().pending['consolidate:test_only']).toBeUndefined()
    await scheduler.dispose()
  })

  it('shares one persistent intent and one run between duplicate manual requests', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const run = vi.fn(async () => {
      markRunStarted()
      await runGate
      return { written: 1, batches: 0, processed: true }
    })
    const scheduler = new LifecycleScheduler(store, { run })
    await scheduler.start()

    const first = scheduler.requestConsolidation({ kind: 'global' })
    const second = scheduler.requestConsolidation({ kind: 'global' })
    expect(second).toBe(first)
    const advancing = vi.advanceTimersByTimeAsync(0)
    await runStarted
    releaseRun()
    await advancing

    await expect(first).resolves.toMatchObject({ written: 1 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.getMeta().globalDirty).toBe(false)
    expect(store.getMeta().pending['global-consolidate']).toBeUndefined()
    await scheduler.dispose()
  })

  it('joins an active automatic consolidation without scheduling a duplicate run', async () => {
    const store = await openStore()
    let releaseRun!: () => void
    let markRunStarted!: () => void
    const runStarted = new Promise<void>(resolve => { markRunStarted = resolve })
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    const run = vi.fn(async () => {
      markRunStarted()
      await runGate
      return { written: 1, batches: 0, processed: true }
    })
    await store.updateMeta(meta => {
      meta.globalDirty = true
      meta.nextGlobalConsolidationAt = '2026-10-26T00:00:00.000Z'
    })
    const scheduler = new LifecycleScheduler(store, { run })
    await scheduler.start()
    const advancing = vi.advanceTimersByTimeAsync(0)
    await runStarted

    const request = scheduler.requestConsolidation({ kind: 'global' })
    expect(store.getMeta().nextGlobalConsolidationAt).toBe('2026-10-26T00:00:00.000Z')
    releaseRun()
    await advancing

    await expect(request).resolves.toMatchObject({ written: 1 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.getMeta().globalDirty).toBe(false)
    await scheduler.dispose()
  })

  it('rejects the manual request with a stable error after scheduling a retry', async () => {
    const store = await openStore()
    const scheduler = new LifecycleScheduler(store, {
      run: async () => { throw new Error('private provider diagnostic') },
    })
    await scheduler.start()

    const request = scheduler.requestConsolidation({ kind: 'global' })
    const assertion = expect(request).rejects.toMatchObject({ message: 'Global memory consolidation failed' })
    await vi.advanceTimersByTimeAsync(0)

    await assertion
    expect(store.getMeta().globalDirty).toBe(true)
    expect(store.getMeta().pending['global-consolidate']).toBeDefined()
    expect(store.getMeta().lastError).toBe('Global memory consolidation failed')
    await scheduler.dispose()
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

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MemoryClientStore } from '../../client/src/store.js'
import type { MemorySettings } from '../../src/contract.js'
import { deferred, ENTRY, FakeRpc, GLOBAL_SCOPE, memoryIndex, sessionState, WORKSPACE_SCOPE } from './fixtures.js'

const DEFAULT_RETENTION_DAYS = {
  'environment-fact': 30,
  'project-convention': 180,
  troubleshooting: 180,
  preference: 0,
  'long-term-decision': 0,
}

describe('MemoryClientStore', () => {
  it('restores enabled state from the Host with no local persistence', async () => {
    const rpc = new FakeRpc().on('getSessionState', () => sessionState('session-1', true))
    const store = new MemoryClientStore(rpc)

    expect(store.getSession('session-1')).toBeUndefined()
    await store.loadSession('session-1')
    expect(store.getSession('session-1')?.layers.global.enabled).toBe(true)
    expect(localStorage.length).toBe(0)
  })

  it('ignores an older same-session response that settles after a newer one', async () => {
    const older = deferred<ReturnType<typeof sessionState>>()
    const newer = deferred<ReturnType<typeof sessionState>>()
    let calls = 0
    const rpc = new FakeRpc().on('getSessionState', () => {
      calls += 1
      return calls === 1 ? older.promise : newer.promise
    })
    const store = new MemoryClientStore(rpc)

    const first = store.loadSession('session-1')
    const second = store.loadSession('session-1')
    newer.resolve(sessionState('session-1', true))
    await second
    older.resolve(sessionState('session-1', false))
    await first

    expect(store.getSession('session-1')?.layers.global.enabled).toBe(true)
  })

  it('deduplicates enable, refreshes Host state, and invalidates tracked queries on change', async () => {
    const enabled = deferred<ReturnType<typeof sessionState>>()
    const rpc = new FakeRpc()
      .on('enable', () => ({ status: 'enabled' }))
      .on('getSessionState', () => enabled.promise)
      .on('list', () => memoryIndex())
    const store = new MemoryClientStore(rpc)
    await store.loadIndex(GLOBAL_SCOPE)
    const before = rpc.count('list')

    const first = store.enable('session-1', 'global')
    const second = store.enable('session-1', 'global')
    expect(rpc.count('enable')).toBe(1)
    enabled.resolve(sessionState('session-1', true))
    await Promise.all([first, second])

    expect(store.getSession('session-1')?.layers.global.enabled).toBe(true)
    expect(rpc.count('list')).toBeGreaterThan(before)
  })

  it('refreshes tracked state on focus and removes its listener on cleanup', async () => {
    const target = new EventTarget()
    const add = vi.spyOn(target, 'addEventListener')
    const remove = vi.spyOn(target, 'removeEventListener')
    const rpc = new FakeRpc().on('getSessionState', () => sessionState())
    const store = new MemoryClientStore(rpc, { eventTarget: target })
    await store.loadSession('session-1')
    const stop = store.listen()
    const before = rpc.count('getSessionState')

    target.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(rpc.count('getSessionState')).toBe(before + 1))
    stop()
    target.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(rpc.count('getSessionState')).toBe(before + 1)
    expect(add).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('promotes a workspace memory and refreshes tracked indexes', async () => {
    const rpc = new FakeRpc()
      .on('list', ({ scope }) => memoryIndex(scope))
      .on('promote', () => ({ id: ENTRY.id, created: true }))
    const store = new MemoryClientStore(rpc)
    await store.loadIndex(GLOBAL_SCOPE)
    await store.loadIndex(WORKSPACE_SCOPE)
    const before = rpc.count('list')

    await expect(store.promote(WORKSPACE_SCOPE, ENTRY.id)).resolves.toEqual({ id: ENTRY.id, created: true })

    expect(rpc.calls.find(call => call.method === 'promote')?.payload).toEqual({ scope: WORKSPACE_SCOPE, id: ENTRY.id })
    expect(rpc.count('list')).toBe(before + 2)
  })

  it('consolidates the requested scope and refreshes its tracked index', async () => {
    const rpc = new FakeRpc()
      .on('list', ({ scope }) => memoryIndex(scope))
      .on('consolidate', () => ({ intentId: 'intent-1', written: 2 }))
    const store = new MemoryClientStore(rpc)
    await store.loadIndex(WORKSPACE_SCOPE)
    const before = rpc.count('list')

    await expect(store.consolidate(WORKSPACE_SCOPE)).resolves.toEqual({ intentId: 'intent-1', written: 2 })

    expect(rpc.calls.find(call => call.method === 'consolidate')?.payload).toEqual({ scope: WORKSPACE_SCOPE })
    expect(rpc.count('list')).toBe(before + 1)
  })

  it('does not let an older settings read overwrite a successful save', async () => {
    const pending = deferred<MemorySettings>()
    const updated = {
      reviewEveryUserTurns: 4,
      idleDelayMinutes: 2,
      consolidationCooldownHours: 8,
      globalConsolidationCooldownDays: 3,
      snapshotTokenBudget: 800,
      retentionDays: { ...DEFAULT_RETENTION_DAYS, troubleshooting: 90 },
    }
    const rpc = new FakeRpc()
      .on('getSettings', () => pending.promise)
      .on('updateSettings', () => updated)
    const store = new MemoryClientStore(rpc)
    const loading = store.loadSettings()

    await store.updateSettings(updated)
    pending.resolve({
      reviewEveryUserTurns: 15,
      idleDelayMinutes: 60,
      consolidationCooldownHours: 20,
      globalConsolidationCooldownDays: 7,
      snapshotTokenBudget: 1_200,
      retentionDays: DEFAULT_RETENTION_DAYS,
    })
    await loading

    expect(store.getSettings()).toEqual(updated)
  })

  it('does not publish late responses after disposal', async () => {
    const pending = deferred<ReturnType<typeof sessionState>>()
    const rpc = new FakeRpc().on('getSessionState', () => pending.promise)
    const store = new MemoryClientStore(rpc)
    const loading = store.loadSession('session-1')
    store.dispose()
    pending.resolve(sessionState('session-1', true))
    await loading

    expect(store.getSession('session-1')).toBeUndefined()
  })
})

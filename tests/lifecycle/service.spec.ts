import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryLifecycleService } from '../../src/lifecycle/service.js'
import { MemoryStore } from '../../src/store/store.js'
import type { MemoryScope } from '../../src/store/types.js'
import { workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []
const services: MemoryLifecycleService[] = []

async function setup(responses: Array<string | Error> = [], maintenance?: { runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> }) {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-lifecycle-'))
  roots.push(root)
  // Lifecycle tests advance fake time by hours; keep the real-time lock heartbeat out of that clock.
  const store = await MemoryStore.open({ root, heartbeatMs: 48 * 3_600_000 })
  stores.push(store)
  const prompts: string[] = []
  const model = {
    async prepareCall(config: { provider: string; model: string; maxTokens?: number }) {
      expect(config.provider).toBe('test')
      return {
        async *stream() {
          const response = responses.shift() ?? '{"candidates":[]}'
          if (response instanceof Error) throw response
          yield { type: 'text-delta' as const, index: 0, text: response }
        },
      }
    },
  }
  const changes: Array<{ kind: string; scope: MemoryScope }> = []
  const service = new MemoryLifecycleService(store, {
    model,
    ...(maintenance === undefined ? {} : { maintenance }),
    provider: 'test',
    modelName: 'aux',
    transcript: async () => 'User established a project convention to run focused tests.',
    onChange: change => { changes.push(change) },
  })
  services.push(service)
  return { store, service, prompts, changes, responses }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// These file-backed tests perform many real atomic writes while Vitest runs other suites in parallel.
describe('MemoryLifecycleService', { timeout: 15_000 }, () => {
  it('counts only completed user turns and respects the 9/10/11 boundary and duplicate notifications', async () => {
    const { service } = await setup(['{"candidates":[]}'])
    await service.start()

    for (let turn = 1; turn <= 9; turn += 1) {
      await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: `turn-${turn}`, source: { kind: 'user' } } })
      await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: `turn-${turn}`, status: 'completed' } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(0)

    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-10', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-10', status: 'completed' } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-10', status: 'completed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)
    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-10', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-10', status: 'completed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)

    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-11', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-11', status: 'error' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)
  })

  it('handles out-of-order completion and ignores injection/runtime sources', async () => {
    const { service } = await setup(['{"candidates":[]}'])
    await service.start()
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-1', status: 'completed' } })
    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-1', source: { kind: 'snail-memory' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(0)

    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-1', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-1', status: 'completed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(0)
    for (let turn = 2; turn <= 10; turn += 1) {
      await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: `turn-${turn}`, source: { kind: 'user' } } })
      await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: `turn-${turn}`, status: 'completed' } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)
  })

  it('persists immediate explicit operations, broadcasts changes, and never changes Session state', async () => {
    const { service, store, changes } = await setup()
    const scope: MemoryScope = { kind: 'global' }
    const before = store.getSessionState('session-1')

    const remembered = await service.remember({
      scope,
      category: 'preference',
      summary: 'Prefer concise answers',
      detail: 'Use concise answers.',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    const corrected = await service.correct({
      ...remembered,
      summary: 'Prefer short answers',
      detail: 'Use short answers.',
    })
    const removed = await service.forget(scope, remembered.id)

    expect(corrected.summary).toBe('Prefer short answers')
    expect(removed).toBe(true)
    expect(store.list(scope).entries).toEqual([])
    expect(store.getSessionState('session-1')).toEqual(before)
    expect(changes.map(change => change.kind)).toEqual(['remember', 'correct', 'forget'])
  })

  it('distills only into the verified workspace and commits retries idempotently', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store, changes } = await setup([
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
    ])
    await store.updateSessionState('session-1', state => { state.workspaceId = scope.workspaceId })

    expect((await service.runIntent('review:session-1')).written).toBe(1)
    expect((await service.runIntent('review:session-1')).written).toBe(0)
    expect(store.list(scope).entries).toHaveLength(1)
    expect(store.list(scope).entries[0]?.revision).toBe(1)
    expect(store.list({ kind: 'global' }).entries).toEqual([])
    expect(changes.map(change => change.kind)).toEqual(['distill'])
  })

  it('rejects secret candidates and preserves dirty retry state on model failure', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store } = await setup([
      '{"candidates":[{"category":"environment-fact","summary":"Credential","detail":"token = abcdefghijkl"}]}',
      'not-json',
    ])
    await store.updateSessionState('session-1', state => { state.workspaceId = scope.workspaceId })

    expect((await service.runIntent('review:session-1')).written).toBe(0)
    await expect(service.runIntent('review:session-1')).rejects.toThrow(/json/i)
    expect(store.getMeta().dirty).toBe(true)
    expect(store.getMeta().lastError).toBe('Session distillation failed')
  })

  it('debounces idle distillation from the latest turn activity', async () => {
    const { service, store } = await setup()
    await service.start()
    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-1', source: { kind: 'user' } } })
    await vi.advanceTimersByTimeAsync(14 * 60_000)

    await service.handleSessionEvent('session-1', { type: 'turn/start', data: { turnId: 'turn-1' } })
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    await service.handleSessionEvent('session-1', { type: 'tool/result', data: { turnId: 'turn-1' } })
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(store.getMeta().pending['idle:session-1']).toBeDefined()

    await vi.advanceTimersByTimeAsync(60_000)
    await service.dispose()
    expect(store.getMeta().lastError).toBeNull()
    expect(store.getMeta().pending['idle:session-1']).toBeUndefined()
  })

  it('consolidates conflicts only within their existing scope', async () => {
    const globalScope: MemoryScope = { kind: 'global' }
    const workspaceScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store, responses } = await setup([
      '{"candidates":[{"id":"global-id","category":"long-term-decision","summary":"New global decision","detail":"Corrected global detail.","sourceRefs":[{"sessionId":"session-1"}]}]}',
      '{"candidates":[{"id":"global-id","category":"long-term-decision","summary":"Cross scope","detail":"Must not cross scopes.","sourceRefs":[{"sessionId":"session-1"}]}]}',
    ])
    const global = await store.upsert({ scope: globalScope, category: 'long-term-decision', summary: 'Old global decision', detail: 'Old global detail.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    const workspace = await store.upsert({ scope: workspaceScope, category: 'project-convention', summary: 'Workspace convention', detail: 'Workspace detail.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await store.remove(globalScope, global.id)
    const target = await store.upsert({ scope: globalScope, category: 'long-term-decision', summary: 'Old global decision', detail: 'Old global detail.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    responsesWithIds(responses, target.id, workspace.id)

    await service.consolidate()

    expect((await store.read(globalScope, target.id))?.summary).toBe('New global decision')
    expect((await store.read(workspaceScope, workspace.id))?.summary).toBe('Workspace convention')
    expect(store.list(workspaceScope).entries).toHaveLength(1)
  })

  it('runs lifecycle work through the injected maintenance host', async () => {
    let calls = 0
    const { service } = await setup([], { runMaintenance: async task => { calls += 1; return task(new AbortController().signal) } })

    await service.runIntent('review:session-1')

    expect(calls).toBe(1)
  })

  it('expires facts and conventions by verification age but retains preferences and decisions', async () => {
    const { service, store, changes } = await setup()
    const scope: MemoryScope = { kind: 'global' }
    await store.upsert({ scope, category: 'environment-fact', summary: 'Old environment', detail: 'Old environment.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-09-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'project-convention', summary: 'Old convention', detail: 'Old convention.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'preference', summary: 'Durable preference', detail: 'Durable preference.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'long-term-decision', summary: 'Durable decision', detail: 'Durable decision.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })

    await service.retentionSweep()

    expect(store.list(scope).entries.map(entry => entry.category).sort()).toEqual(['long-term-decision', 'preference'])
    expect(changes.map(change => change.kind)).toEqual(['retention'])
  })
})

function responsesWithIds(responses: Array<string | Error>, globalId: string, _workspaceId: string) {
  responses[0] = String(responses[0]).replace('global-id', globalId)
  responses[1] = String(responses[1]).replace('global-id', globalId)
  void _workspaceId
}

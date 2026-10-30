import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryLifecycleService } from '../../src/lifecycle/service.js'
import { MemoryStore } from '../../src/store/store.js'
import type { TranscriptEvent } from '../../src/runtime.js'
import type { MemoryScope, WorkspaceId } from '../../src/store/types.js'
import { workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []
const services: MemoryLifecycleService[] = []

async function setup(
  responses: Array<string | Error> = [],
  maintenance?: { runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> },
  beforeResponse?: () => Promise<void>,
  resolveWorkspaceId?: (sessionId: string) => WorkspaceId | undefined,
  runMaintenance?: <T>(sessionId: string, task: (signal?: AbortSignal) => Promise<T>) => Promise<T>,
) {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-lifecycle-'))
  roots.push(root)
  // Lifecycle tests advance fake time by hours; keep the real-time lock heartbeat out of that clock.
  const store = await MemoryStore.open({ root, heartbeatMs: 48 * 3_600_000 })
  stores.push(store)
  const prompts: string[] = []
  const activity = { active: 0, maxActive: 0 }
  const model = {
    async prepareCall(config: { provider: string; model: string; maxTokens?: number }) {
      expect(config.provider).toBe('test')
      return {
        async *stream(options: { messages: readonly { content: readonly { text: string }[] }[] }) {
          prompts.push(options.messages.flatMap(message => message.content.map(block => block.text)).join('\n'))
          activity.active += 1
          activity.maxActive = Math.max(activity.maxActive, activity.active)
          try {
            await beforeResponse?.()
            const response = responses.shift() ?? '{"candidates":[]}'
            if (response instanceof Error) throw response
            yield { type: 'text-delta' as const, index: 0, text: response }
          } finally {
            activity.active -= 1
          }
        },
      }
    },
  }
  const changes: Array<{ kind: string; scope: MemoryScope }> = []
  const events: TranscriptEvent[] = [{
    seq: 1,
    type: 'user/message',
    data: { turnId: 'turn-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'User established a project convention to run focused tests.' }] },
  }]
  const service = new MemoryLifecycleService(store, {
    model,
    ...(maintenance === undefined ? {} : { maintenance }),
    ...(runMaintenance === undefined ? {} : { runMaintenance }),
    provider: 'test',
    modelName: 'aux',
    transcriptEvents: async () => events,
    ...(resolveWorkspaceId === undefined ? {} : { resolveWorkspaceId }),
    onChange: change => { changes.push(change) },
  })
  services.push(service)
  return { store, service, prompts, activity, changes, responses, events }
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
  it('counts only completed user turns and respects the 14/15/16 boundary and duplicate notifications', async () => {
    const { service } = await setup(['{"candidates":[]}'])
    await service.start()

    for (let turn = 1; turn <= 14; turn += 1) {
      await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: `turn-${turn}`, source: { kind: 'user' } } })
      await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: `turn-${turn}`, status: 'completed' } })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(0)

    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-15', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-15', status: 'completed' } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-15', status: 'completed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)
    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-15', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-15', status: 'completed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(service.reviewCount).toBe(1)

    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-16', source: { kind: 'user' } } })
    await service.handleSessionEvent('session-1', { type: 'agent/turn', data: { turnId: 'turn-16', status: 'error' } })
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
    for (let turn = 2; turn <= 15; turn += 1) {
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
    expect(store.getMeta().globalDirty).toBe(false)
    expect(store.getMeta().nextGlobalConsolidationAt).toBeNull()
    expect(changes.map(change => change.kind)).toEqual(['distill'])
  })

  it('resolves and persists a workspace attached after agent creation before distilling', async () => {
    const owner = workspaceId('workspace-late')
    const { service, store } = await setup([
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
    ], undefined, undefined, () => owner)

    await expect(service.runIntent('idle:session-1')).resolves.toEqual({ written: 1 })

    expect(store.getSessionState('session-1').workspaceId).toBe(owner)
    expect(store.list({ kind: 'workspace', workspaceId: owner }).entries).toHaveLength(1)
  })

  it('does not replace an existing workspace owner during late resolution', async () => {
    const original = workspaceId('workspace-original')
    const successor = workspaceId('workspace-successor')
    let resolutions = 0
    const { service, store } = await setup([
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
    ], undefined, undefined, () => { resolutions += 1; return successor })
    await store.updateSessionState('session-1', state => { state.workspaceId = original })

    await expect(service.runIntent('review:session-1')).resolves.toEqual({ written: 1 })

    expect(resolutions).toBe(0)
    expect(store.getSessionState('session-1').workspaceId).toBe(original)
    expect(store.list({ kind: 'workspace', workspaceId: original }).entries).toHaveLength(1)
    expect(store.list({ kind: 'workspace', workspaceId: successor }).entries).toEqual([])
  })

  it('keeps an unowned session a clean no-op when late resolution finds no workspace', async () => {
    const { service, store, responses } = await setup([
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
    ], undefined, undefined, () => undefined)

    await expect(service.runIntent('idle:session-1')).resolves.toEqual({ written: 0 })

    expect(responses).toHaveLength(1)
    expect(store.getSessionState('session-1').workspaceId).toBeUndefined()
    expect(store.getSessionState('session-1').distillationCursor).toBeUndefined()
    expect(store.getMeta().lastError).toBeNull()
  })

  it('reports an unowned session as a structured skip', async () => {
    const { service } = await setup([], undefined, undefined, () => undefined)

    await expect(service.runIntentDetailed('idle:session-1')).resolves.toEqual({
      written: 0,
      batches: 0,
      processed: false,
      batchResults: [],
      skipReason: 'workspace-unassigned',
    })
  })

  it('reports each processed distillation batch with its cursor and final skip reason', async () => {
    const owner = workspaceId('workspace-1')
    const { service, store } = await setup([
      '{"candidates":[{"category":"project-convention","summary":"Run focused tests","detail":"Run focused tests first."}]}',
    ])
    await store.updateSessionState('session-1', state => { state.workspaceId = owner })

    await expect(service.runIntentDetailed('review:session-1')).resolves.toEqual({
      written: 1,
      batches: 1,
      processed: true,
      batchResults: [{ written: 1, rejected: 0, cursor: { lastEventSeq: 1, offset: 0 } }],
    })
    await expect(service.runIntentDetailed('review:session-1')).resolves.toEqual({
      written: 0,
      batches: 0,
      processed: false,
      batchResults: [],
      skipReason: 'no-new-events',
    })
  })

  it('rejects secret candidates and does not invent consolidation work on model failure', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store, events } = await setup([
      '{"candidates":[{"category":"environment-fact","summary":"Credential","detail":"token = abcdefghijkl"}]}',
      'not-json',
    ])
    await store.updateSessionState('session-1', state => { state.workspaceId = scope.workspaceId })

    expect((await service.runIntent('review:session-1')).written).toBe(0)
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 1 })
    events.push({ seq: 2, type: 'user/message', data: { turnId: 'turn-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'A second completed turn.' }] } })
    await expect(service.runIntent('review:session-1')).rejects.toThrow(/json/i)
    expect(store.getMeta().workspaceConsolidation).toEqual({})
    expect(store.getMeta().lastError).toBe('Session distillation failed')
  })

  it('debounces idle distillation from the latest turn activity', async () => {
    const { service, store } = await setup()
    await service.start()
    await service.handleSessionEvent('session-1', { type: 'user/message', data: { turnId: 'turn-1', source: { kind: 'user' } } })
    await vi.advanceTimersByTimeAsync(59 * 60_000)

    await service.handleSessionEvent('session-1', { type: 'turn/start', data: { turnId: 'turn-1' } })
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    await service.handleSessionEvent('session-1', { type: 'tool/result', data: { turnId: 'turn-1' } })
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(store.getMeta().pending['idle:session-1']).toBeDefined()

    await vi.advanceTimersByTimeAsync(60_000)
    await service.dispose()
    expect(store.getMeta().lastError).toBeNull()
    expect(store.getMeta().pending['idle:session-1']).toBeUndefined()
  })

  it('consolidates only global entries for the global intent without clearing workspace dirty state', async () => {
    const globalScope: MemoryScope = { kind: 'global' }
    const workspaceScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store, responses } = await setup([
      '{"candidates":[{"id":"global-id","category":"long-term-decision","summary":"New global decision","detail":"Corrected global detail.","sourceRefs":[{"sessionId":"session-1"}]}]}',
    ])
    const target = await store.upsert({ scope: globalScope, category: 'long-term-decision', summary: 'Old global decision', detail: 'Old global detail.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    const workspace = await store.upsert({ scope: workspaceScope, category: 'project-convention', summary: 'Workspace convention', detail: 'Workspace detail.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    responsesWithIds(responses, target.id, workspace.id)

    expect((await service.runIntent('global-consolidate')).written).toBe(1)

    expect((await store.read(globalScope, target.id))?.summary).toBe('New global decision')
    expect((await store.read(workspaceScope, workspace.id))?.summary).toBe('Workspace convention')
    expect(store.getMeta()).toMatchObject({
      workspaceConsolidation: { 'workspace-1': { dirty: true } },
      globalDirty: false,
      lastGlobalConsolidationAt: '2026-10-26T00:00:00.000Z',
      nextGlobalConsolidationAt: null,
    })
  })

  it('derives consolidated source refs and ignores supersedes outside the input snapshot', async () => {
    const scope: MemoryScope = { kind: 'global' }
    let releaseModel!: () => void
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const { service, store, responses } = await setup([], undefined, async () => {
      markModelStarted()
      await modelGate
    })
    const target = await store.upsert({
      scope, category: 'project-convention', summary: 'Old convention', detail: 'Old target detail.',
      sourceRefs: [{ sessionId: 'session-target', eventSeqs: [3] }], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    const merged = await store.upsert({
      scope, category: 'project-convention', summary: 'Merged convention', detail: 'Old merged detail.',
      sourceRefs: [{ sessionId: 'session-merged', eventSeqs: [8, 9] }], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    const running = service.runIntent('global-consolidate')
    await modelStarted
    const late = await store.upsert({
      scope, category: 'preference', summary: 'Created during consolidation', detail: 'Must survive the old candidate.',
      sourceRefs: [{ sessionId: 'session-late' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    responses.push(JSON.stringify({ candidates: [{
      id: target.id, category: 'project-convention', summary: 'Consolidated convention', detail: 'New consolidated detail.',
      sourceRefs: [{ sessionId: 'model-forged-session' }], supersedes: [merged.id, late.id],
    }] }))
    releaseModel()

    await expect(running).resolves.toEqual({ written: 1 })
    expect((await store.read(scope, target.id))?.sourceRefs).toEqual([
      { sessionId: 'session-target', eventSeqs: [3] },
      { sessionId: 'session-merged', eventSeqs: [8, 9] },
    ])
    expect(await store.read(scope, merged.id)).toBeNull()
    expect((await store.read(scope, late.id))?.summary).toBe('Created during consolidation')
  })

  it('limits candidate ids, supersedes, and source refs to the truncated model input', async () => {
    const scope: MemoryScope = { kind: 'global' }
    const { service, store, responses } = await setup()
    const excluded = await store.upsert({
      scope, category: 'project-convention', summary: 'Excluded convention', detail: 'x'.repeat(64_000),
      sourceRefs: [{ sessionId: 'session-excluded' }], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    vi.setSystemTime(new Date('2026-10-26T00:01:00.000Z'))
    const target = await store.upsert({
      scope, category: 'project-convention', summary: 'Included convention', detail: 'Included detail.',
      sourceRefs: [{ sessionId: 'session-target' }], lastVerifiedAt: '2026-10-26T00:01:00.000Z',
    })
    responses.push(JSON.stringify({ candidates: [
      {
        id: target.id, category: 'project-convention', summary: 'Consolidated convention',
        detail: 'New consolidated detail.', supersedes: [excluded.id],
      },
      {
        id: excluded.id, category: 'project-convention', summary: 'Overwritten excluded convention',
        detail: 'Must not be written.',
      },
    ] }))

    await expect(service.runIntent('global-consolidate')).resolves.toEqual({ written: 1 })
    expect((await store.read(scope, target.id))?.sourceRefs).toEqual([{ sessionId: 'session-target' }])
    expect((await store.read(scope, excluded.id))?.summary).toBe('Excluded convention')
  })

  it('does not supersede a memory corrected while consolidation is waiting for the model', async () => {
    const scope: MemoryScope = { kind: 'global' }
    let releaseModel!: () => void
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const { service, store, responses } = await setup([], undefined, async () => {
      markModelStarted()
      await modelGate
    })
    const target = await store.upsert({
      scope, category: 'project-convention', summary: 'Target convention', detail: 'Target detail.',
      sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    const superseded = await store.upsert({
      scope, category: 'project-convention', summary: 'Superseded convention', detail: 'Original detail.',
      sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    const running = service.runIntent('global-consolidate')
    await modelStarted
    const corrected = await service.correct({
      ...superseded,
      detail: 'Corrected during consolidation.',
    })
    responses.push(JSON.stringify({ candidates: [{
      id: target.id, category: 'project-convention', summary: 'Consolidated convention',
      detail: 'Stale consolidated detail.', supersedes: [superseded.id],
    }] }))
    releaseModel()

    await expect(running).resolves.toEqual({ written: 0 })
    expect((await store.read(scope, target.id))?.summary).toBe('Target convention')
    expect(await store.read(scope, superseded.id)).toMatchObject({
      detail: 'Corrected during consolidation.',
      revision: corrected.revision,
    })
  })

  it('does not recreate a Global memory deleted while consolidation is waiting for the model', async () => {
    const globalScope: MemoryScope = { kind: 'global' }
    let releaseModel!: () => void
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const { service, store } = await setup([
      '{"candidates":[{"category":"preference","summary":"Prefer concise answers","detail":"Stale model result."}]}',
    ], undefined, async () => {
      markModelStarted()
      await modelGate
    })
    const target = await store.upsert({
      scope: globalScope,
      category: 'preference',
      summary: 'Prefer concise answers',
      detail: 'Use concise answers.',
      sourceRefs: [],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    const running = service.runIntent('global-consolidate')
    await modelStarted
    expect(await store.remove(globalScope, target.id)).toBe(true)
    releaseModel()

    await expect(running).resolves.toEqual({ written: 0 })
    expect(store.list(globalScope).entries).toEqual([])
  })

  it('preserves a Promote schedule created while Global consolidation is waiting for the model', async () => {
    const globalScope: MemoryScope = { kind: 'global' }
    const workspaceScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    let releaseModel!: () => void
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const { service, store } = await setup(['{"candidates":[]}'], undefined, async () => {
      markModelStarted()
      await modelGate
    })
    await store.upsert({
      scope: globalScope,
      category: 'long-term-decision',
      summary: 'Existing global decision',
      detail: 'Existing global detail.',
      sourceRefs: [],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    const source = await store.upsert({
      scope: workspaceScope,
      category: 'preference',
      summary: 'Prefer concise answers',
      detail: 'Use concise answers.',
      sourceRefs: [],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    const running = service.runIntent('global-consolidate')
    await modelStarted
    const promoted = await service.promote(workspaceScope, source.id)
    releaseModel()

    await expect(running).resolves.toEqual({ written: 0 })
    expect(promoted.created).toBe(true)
    expect(store.getMeta()).toMatchObject({
      globalDirty: true,
      nextGlobalConsolidationAt: '2026-11-02T00:00:00.000Z',
    })
  })

  it('promotes with global-only scheduling and no Session cursor changes', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const { service, store, changes } = await setup()
    const source = await store.upsert({
      scope,
      category: 'preference',
      summary: 'Prefer concise answers',
      detail: 'Use concise answers.',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await store.updateSessionState('session-1', state => {
      state.workspaceId = scope.workspaceId
      state.distillationCursor = { lastEventSeq: 9, offset: 0, updatedAt: '2026-10-25T00:00:00.000Z' }
    })
    const before = store.getSessionState('session-1')
    await store.updateMeta(meta => {
      meta.workspaceConsolidation = {}
      meta.globalDirty = false
      meta.nextGlobalConsolidationAt = null
    })

    const promoted = await service.promote(scope, source.id)
    const duplicate = await service.promote(scope, source.id)

    expect(promoted.created).toBe(true)
    expect(duplicate).toEqual({ id: promoted.id, created: false })
    expect(store.getMeta()).toMatchObject({
      workspaceConsolidation: {},
      globalDirty: true,
      nextGlobalConsolidationAt: '2026-11-02T00:00:00.000Z',
    })
    expect(store.getSessionState('session-1')).toEqual(before)
    expect(changes).toEqual([{ kind: 'promote', scope: { kind: 'global' }, ids: [promoted.id] }])
  })

  it('runs lifecycle work through the injected maintenance host', async () => {
    let calls = 0
    const { service } = await setup([], { runMaintenance: async task => { calls += 1; return task(new AbortController().signal) } })

    await service.runIntent('review:session-1')

    expect(calls).toBe(1)
  })

  it('expires workspace facts and conventions but retains preferences, decisions, and legacy global entries', async () => {
    const { service, store, changes } = await setup()
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const legacyScope: MemoryScope = { kind: 'global' }
    const legacy = await store.upsert({ scope: legacyScope, category: 'environment-fact', summary: 'Legacy global', detail: 'Preserved without aggregation.', sourceRefs: [], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'environment-fact', summary: 'Old environment', detail: 'Old environment.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-09-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'project-convention', summary: 'Old convention', detail: 'Old convention.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2026-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'preference', summary: 'Durable preference', detail: 'Durable preference.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'long-term-decision', summary: 'Durable decision', detail: 'Durable decision.', sourceRefs: [{ sessionId: 'session-1' }], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })
    const read = vi.spyOn(store, 'read')

    await service.retentionSweep()

    expect(read).not.toHaveBeenCalled()
    expect(store.list(scope).entries.map(entry => entry.category).sort()).toEqual(['long-term-decision', 'preference'])
    expect((await store.read(legacyScope, legacy.id))?.summary).toBe('Legacy global')
    expect(changes.map(change => change.kind)).toEqual(['retention'])
  })

  it('consolidates only dirty test_only and never reads or sends clean dsh_memory', async () => {
    const testScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const cleanScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('dsh_memory') }
    const { service, store, prompts } = await setup()
    await store.upsert({ scope: testScope, category: 'project-convention', summary: 'Test convention', detail: 'Only test_only detail.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    const clean = await store.upsert({ scope: cleanScope, category: 'project-convention', summary: 'Clean convention', detail: 'Clean dsh_memory detail must stay unread.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await store.updateMeta(meta => {
      meta.workspaceConsolidation = {
        test_only: { dirty: true, nextConsolidationAt: '2026-10-26T00:00:00.000Z', lastConsolidationAt: null },
        dsh_memory: { dirty: false, nextConsolidationAt: null, lastConsolidationAt: '2026-10-25T00:00:00.000Z' },
      }
    })
    const read = vi.spyOn(store, 'read')

    await service.start()
    await vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await service.stop()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('workspace:test_only')
    expect(prompts[0]).toContain('Only test_only detail.')
    expect(prompts[0]).not.toContain('Clean dsh_memory detail')
    expect(prompts[0]).not.toContain('"sourceRefs"')
    expect(prompts[0]).not.toContain('"revision"')
    expect(read).not.toHaveBeenCalledWith(cleanScope, clean.id)
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toMatchObject({ dirty: false, nextConsolidationAt: null })
  })

  it('serializes two dirty workspaces without putting either workspace entries in the other prompt', async () => {
    const firstScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const secondScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('dsh_memory') }
    const { service, prompts, activity } = await setup()

    await service.remember({ scope: firstScope, category: 'project-convention', summary: 'First convention', detail: 'FIRST_WORKSPACE_ONLY_DETAIL', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await service.remember({ scope: secondScope, category: 'project-convention', summary: 'Second convention', detail: 'SECOND_WORKSPACE_ONLY_DETAIL', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await service.start()
    await vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    await service.stop()

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('workspace:test_only')
    expect(prompts[0]).toContain('FIRST_WORKSPACE_ONLY_DETAIL')
    expect(prompts[0]).not.toContain('SECOND_WORKSPACE_ONLY_DETAIL')
    expect(prompts[1]).toContain('workspace:dsh_memory')
    expect(prompts[1]).toContain('SECOND_WORKSPACE_ONLY_DETAIL')
    expect(prompts[1]).not.toContain('FIRST_WORKSPACE_ONLY_DETAIL')
    expect(activity.maxActive).toBe(1)
  })

  it('retries only the failed workspace and does not repeat a successful scope', async () => {
    const failedScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const successfulScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('dsh_memory') }
    const { service, store, prompts } = await setup([new Error('model unavailable'), '{"candidates":[]}'])
    await service.remember({ scope: failedScope, category: 'project-convention', summary: 'Retry convention', detail: 'Retry this scope.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await service.remember({ scope: successfulScope, category: 'project-convention', summary: 'Successful convention', detail: 'Succeed once.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })

    await service.start()
    await vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    await service.stop()

    expect(prompts).toHaveLength(2)
    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: true })
    expect(store.getMeta().workspaceConsolidation.test_only?.nextConsolidationAt).not.toBe('2026-10-26T20:00:00.000Z')
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toMatchObject({ dirty: false, nextConsolidationAt: null })

    await service.start()
    await vi.advanceTimersByTimeAsync(20 * 3_600_000)
    await vi.waitFor(() => expect(prompts).toHaveLength(3))
    await service.stop()

    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('workspace:test_only')
    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: false, nextConsolidationAt: null })
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toMatchObject({ dirty: false, nextConsolidationAt: null })
  })

  it('keeps same-scope writes dirty during model wait without rescheduling another scope', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const otherScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('dsh_memory') }
    let releaseModel!: () => void
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const { service, store } = await setup(['{"candidates":[]}'], undefined, async () => {
      markModelStarted()
      await modelGate
    })
    await service.remember({ scope, category: 'project-convention', summary: 'Original convention', detail: 'Original detail.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    await service.remember({ scope: otherScope, category: 'project-convention', summary: 'Other convention', detail: 'Other detail.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })

    const running = service.runIntent('consolidate:test_only')
    await modelStarted
    vi.setSystemTime(new Date('2026-10-26T01:00:00.000Z'))
    await service.remember({ scope, category: 'preference', summary: 'Late preference', detail: 'Keep this scope dirty.', sourceRefs: [], lastVerifiedAt: '2026-10-26T01:00:00.000Z' })
    releaseModel()
    await running

    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-26T21:00:00.000Z' })
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-26T20:00:00.000Z' })
  })

  it('marks retention consolidation only for workspaces with actual deletions', async () => {
    const expiredScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const retainedScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('dsh_memory') }
    const { service, store } = await setup()
    await store.upsert({ scope: expiredScope, category: 'environment-fact', summary: 'Expired environment', detail: 'Delete this entry.', sourceRefs: [], lastVerifiedAt: '2026-09-01T00:00:00.000Z' })
    await store.upsert({ scope: retainedScope, category: 'preference', summary: 'Retained preference', detail: 'Keep this entry.', sourceRefs: [], lastVerifiedAt: '2026-09-01T00:00:00.000Z' })
    await store.updateMeta(meta => { meta.workspaceConsolidation = {} })

    await service.retentionSweep()

    expect(store.getMeta().workspaceConsolidation.test_only).toMatchObject({ dirty: true, nextConsolidationAt: '2026-10-26T20:00:00.000Z' })
    expect(store.getMeta().workspaceConsolidation.dsh_memory).toBeUndefined()
  })

  it('gives consolidation the complete JSON contract and requests only changed candidates', async () => {
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('test_only') }
    const { service, store, prompts } = await setup()
    await store.upsert({
      scope,
      category: 'project-convention',
      summary: 'Test convention',
      detail: 'Only test_only detail.',
      sourceRefs: [],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    await service.runIntent('consolidate:test_only')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/only JSON/i)
    expect(prompts[0]).toContain('"candidates"')
    expect(prompts[0]).toContain('"category"')
    expect(prompts[0]).toContain('"summary"')
    expect(prompts[0]).toContain('"detail"')
    expect(prompts[0]).toContain('preference, project-convention, environment-fact, troubleshooting, long-term-decision')
    expect(prompts[0]).toMatch(/changed/i)
    expect(prompts[0]).toMatch(/unchanged/i)
  })

  it('decodes workspace intent ids without routing the suffix to Session maintenance', async () => {
    const owner = workspaceId('workspace with spaces')
    const scope: MemoryScope = { kind: 'workspace', workspaceId: owner }
    const maintenanceSessions: string[] = []
    const { service, store, prompts } = await setup([], undefined, undefined, undefined, async (sessionId, task) => {
      maintenanceSessions.push(sessionId)
      return task()
    })
    await store.upsert({ scope, category: 'project-convention', summary: 'Encoded convention', detail: 'Encoded workspace detail.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })

    await service.runIntent(`consolidate:${encodeURIComponent(owner)}`)

    expect(maintenanceSessions).toEqual([''])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(`workspace:${owner}`)
  })
})

function responsesWithIds(responses: Array<string | Error>, globalId: string, _workspaceId: string) {
  responses[0] = String(responses[0]).replace('global-id', globalId)
  responses[1] = String(responses[1]).replace('global-id', globalId)
  void _workspaceId
}

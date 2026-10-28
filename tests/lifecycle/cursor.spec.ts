import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryLifecycleService } from '../../src/lifecycle/service.js'
import type { TranscriptEvent } from '../../src/runtime.js'
import { MemoryStore } from '../../src/store/store.js'
import { workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []
const services: MemoryLifecycleService[] = []

function event(seq: number, text: string, turnId = `turn-${seq}`): TranscriptEvent {
  return {
    seq,
    type: 'user/message',
    data: { turnId, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function candidate(summary: string): string {
  return JSON.stringify({ candidates: [{ category: 'project-convention', summary, detail: `${summary} detail` }] })
}

async function openService(
  root: string,
  events: Record<string, TranscriptEvent[]>,
  responses: Array<string | Error>,
  prompts: string[],
  routed = true,
) {
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  const service = new MemoryLifecycleService(store, {
    model: {
      async prepareCall() {
        return {
          stream: (options: { messages: readonly { content: readonly { text: string }[] }[] }) => ({
            async *[Symbol.asyncIterator]() {
              prompts.push(options.messages[0]!.content[0]!.text)
              const response = responses.shift() ?? '{"candidates":[]}'
              if (response instanceof Error) throw response
              yield { type: 'text-delta', text: response }
            },
          }),
        }
      },
    },
    ...(routed ? { provider: 'test', modelName: 'aux' } : {}),
    transcriptEvents: sessionId => events[sessionId] ?? [],
  })
  services.push(service)
  return { store, service }
}

async function setup(events: Record<string, TranscriptEvent[]>, responses: Array<string | Error> = [], routed = true) {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-cursor-'))
  roots.push(root)
  const prompts: string[] = []
  const opened = await openService(root, events, responses, prompts, routed)
  return { root, events, responses, prompts, ...opened }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('session distillation cursor', { timeout: 15_000 }, () => {
  it('shares sequential progress across Review, Idle, and Stop without repeating ranges', async () => {
    const events = { 'session-1': [event(1, 'first range')] }
    const { service, store, prompts } = await setup(events, [candidate('First'), candidate('Second'), candidate('Third')])
    await store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })

    await service.runIntent('review:session-1')
    events['session-1']!.push(event(2, 'second range'))
    await service.runIntent('idle:session-1')
    events['session-1']!.push(event(3, 'third range'))
    await service.runIntent('stop:session-1')

    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('first range')
    expect(prompts[1]).toContain('second range')
    expect(prompts[1]).not.toContain('first range')
    expect(prompts[2]).toContain('third range')
    expect(prompts[2]).not.toContain('second range')
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 3, offset: 0 })
  })

  it('advances after an empty candidate batch without changing scope revision, dirty state, or snapshots', async () => {
    const { service, store } = await setup({ 'session-1': [event(1, 'nothing durable')] })
    await store.updateSessionState('session-1', state => {
      state.workspaceId = workspaceId('workspace-1')
      state.layers.workspace.desired.push({ injectionId: 'existing', revision: 7, snapshot: 'existing snapshot', createdAt: '2026-10-27T00:00:00.000Z', automatic: false })
    })
    const scope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    const revision = store.list(scope).revision
    const desired = store.getSessionState('session-1').layers.workspace.desired

    await service.runIntent('review:session-1')

    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 1, offset: 0 })
    expect(store.list(scope).revision).toBe(revision)
    expect(store.getMeta().dirty).toBe(false)
    expect(store.getSessionState('session-1').layers.workspace.desired).toEqual(desired)
  })

  it('does not advance for missing routes, request failures, or unparseable output', async () => {
    const missingRoute = await setup({ 'session-1': [event(1, 'route')] }, [], false)
    await missingRoute.store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })
    await expect(missingRoute.service.runIntent('review:session-1')).rejects.toThrow(/route/i)
    expect(missingRoute.store.getSessionState('session-1').distillationCursor).toBeUndefined()

    const failed = await setup({ 'session-2': [event(1, 'failure')] }, [new Error('cancelled'), 'not-json', '{"candidates":[]}'])
    await failed.store.updateSessionState('session-2', state => { state.workspaceId = workspaceId('workspace-1') })
    await expect(failed.service.runIntent('review:session-2')).rejects.toThrow('cancelled')
    expect(failed.store.getSessionState('session-2').distillationCursor).toBeUndefined()
    await expect(failed.service.runIntent('review:session-2')).rejects.toThrow(/json/i)
    expect(failed.store.getSessionState('session-2').distillationCursor).toBeUndefined()
    await failed.service.runIntent('review:session-2')
    expect(failed.store.getSessionState('session-2').distillationCursor).toMatchObject({ lastEventSeq: 1 })
  })

  it('resumes persisted progress after reopening the store', async () => {
    const events = { 'session-1': [event(1, 'before restart')] }
    const responses = [candidate('Before'), candidate('After')]
    const prompts: string[] = []
    const first = await setup(events, responses)
    await first.store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })
    await first.service.runIntent('review:session-1')
    await first.service.dispose()
    await first.store.close()

    events['session-1']!.push(event(2, 'after restart'))
    const second = await openService(first.root, events, responses, prompts)
    await second.service.runIntent('review:session-1')

    expect(prompts.at(-1)).toContain('after restart')
    expect(prompts.at(-1)).not.toContain('before restart')
    expect(second.store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 2 })
  })

  it('retries the same batch when memory committed but the cursor did not, without duplicate entries', async () => {
    const { service, store } = await setup({ 'session-1': [event(1, 'crash window')] }, [candidate('Atomic'), candidate('Atomic')])
    const scope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    await store.updateSessionState('session-1', state => { state.workspaceId = scope.workspaceId })
    vi.spyOn(store, 'updateSessionState').mockRejectedValueOnce(new Error('cursor write failed'))

    await expect(service.runIntent('review:session-1')).rejects.toThrow('cursor write failed')
    expect(store.list(scope).entries).toHaveLength(1)
    expect(store.getSessionState('session-1').distillationCursor).toBeUndefined()

    await service.runIntent('review:session-1')

    expect(store.list(scope).entries).toHaveLength(1)
    expect(store.list(scope).entries[0]?.revision).toBe(1)
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 1 })
  })

  it('uses bounded Idle catch-up and eventually reaches a long-session tail', async () => {
    const events = {
      'session-1': [
        event(1, `first-${'a'.repeat(20_000)}`),
        event(2, `middle-${'b'.repeat(20_000)}`),
        event(3, `later-${'c'.repeat(20_000)}`),
        event(4, `fourth-${'d'.repeat(20_000)}`),
        event(5, `fifth-${'e'.repeat(20_000)}`),
        event(6, `penultimate-${'f'.repeat(20_000)}`),
        event(7, `tail-${'g'.repeat(20_000)}`),
      ],
    }
    const { service, store, prompts } = await setup(events)
    await store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })

    await service.runIntent('review:session-1')
    await service.runIntent('idle:session-1')
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 5 })
    expect(prompts).toHaveLength(3)

    await service.runIntent('stop:session-1')

    expect(prompts.at(-1)).toContain('tail-')
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 7, offset: 0 })
  })

  it('keeps cursor and memory writes isolated by session and workspace', async () => {
    const events = { 'session-1': [event(1, 'one')], 'session-2': [event(1, 'two')] }
    const { service, store } = await setup(events, [candidate('One'), candidate('Two')])
    await store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })
    await store.updateSessionState('session-2', state => { state.workspaceId = workspaceId('workspace-2') })

    await service.runIntent('review:session-1')
    await service.runIntent('review:session-2')

    expect(store.list({ kind: 'workspace', workspaceId: workspaceId('workspace-1') }).entries.map(entry => entry.summary)).toEqual(['One'])
    expect(store.list({ kind: 'workspace', workspaceId: workspaceId('workspace-2') }).entries.map(entry => entry.summary)).toEqual(['Two'])
    expect(store.getSessionState('session-1').distillationCursor).toMatchObject({ lastEventSeq: 1 })
    expect(store.getSessionState('session-2').distillationCursor).toMatchObject({ lastEventSeq: 1 })
  })

  it('merges source references when a later batch yields the same memory', async () => {
    const events = { 'session-1': [event(1, 'one')], 'session-2': [event(2, 'two')] }
    const { service, store } = await setup(events, [candidate('Shared'), candidate('Shared')])
    const scope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    await store.updateSessionState('session-1', state => { state.workspaceId = scope.workspaceId })
    await store.updateSessionState('session-2', state => { state.workspaceId = scope.workspaceId })
    await store.upsert({
      scope,
      category: 'project-convention',
      summary: 'Shared',
      detail: 'Shared detail',
      sourceRefs: [{ sessionId: 'legacy', eventSeqs: [10] }, { sessionId: 'legacy', eventSeqs: [11] }],
      lastVerifiedAt: '2026-10-27T00:00:00.000Z',
    })

    await service.runIntent('review:session-1')
    await service.runIntent('review:session-2')

    const entry = await store.read(scope, store.list(scope).entries[0]!.id)
    expect(store.list(scope).entries).toHaveLength(1)
    expect(entry?.sourceRefs).toEqual([
      { sessionId: 'legacy', eventSeqs: [10, 11] },
      { sessionId: 'session-1', eventSeqs: [1] },
      { sessionId: 'session-2', eventSeqs: [2] },
    ])
  })

  it('leaves every cursor unchanged and does not redistill after deleting one or all memories', async () => {
    const events = { 'session-1': [event(1, 'one')], 'session-2': [event(1, 'two')] }
    const { service, store, prompts } = await setup(events, [candidate('One'), candidate('Two')])
    const firstScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    const secondScope = { kind: 'workspace', workspaceId: workspaceId('workspace-2') } as const
    await store.updateSessionState('session-1', state => { state.workspaceId = firstScope.workspaceId })
    await store.updateSessionState('session-2', state => { state.workspaceId = secondScope.workspaceId })
    await service.runIntent('review:session-1')
    await service.runIntent('review:session-2')
    const before = [store.getSessionState('session-1').distillationCursor, store.getSessionState('session-2').distillationCursor]

    await service.forget(firstScope, store.list(firstScope).entries[0]!.id)
    expect([store.getSessionState('session-1').distillationCursor, store.getSessionState('session-2').distillationCursor]).toEqual(before)
    await service.forget(secondScope, store.list(secondScope).entries[0]!.id)
    expect(store.list({ kind: 'global' }).entries).toEqual([])
    expect([store.getSessionState('session-1').distillationCursor, store.getSessionState('session-2').distillationCursor]).toEqual(before)

    await service.runIntent('review:session-1')
    await service.runIntent('idle:session-1')
    await service.runIntent('stop:session-1')
    await service.runIntent('review:session-2')

    expect(prompts).toHaveLength(2)
    expect(store.list({ kind: 'global' }).entries).toEqual([])
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryContextService } from '../../src/context/service.js'
import { MemoryStore } from '../../src/store/store.js'
import { memoryId, workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-context-'))
  roots.push(root)
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  const context = new MemoryContextService(store, {
    now: () => new Date('2026-10-26T00:00:00.000Z'),
  })
  const messages: UserMessage[] = []
  const agent = {
    session: { id: 'session-1' },
    inject(message: UserMessage) { messages.push(message) },
  }
  return { root, store, context, agent, messages }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemoryContextService', () => {
  it('selects at most one layer, disables both, and restores only the selected layer', async () => {
    const { context, agent, messages } = await setup()
    const id = workspaceId('workspace-1')
    await context.enable(agent, 'workspace', id)
    await context.enable(agent, 'global')

    expect(context.getSessionState(agent.session.id).layers.workspace.enabled).toBe(false)
    expect(context.getSessionState(agent.session.id).layers.global.enabled).toBe(true)
    const restarted = new MemoryContextService(context.store, {})
    const restored: UserMessage[] = []
    await restarted.restore({ session: agent.session, inject: message => { restored.push(message) } })
    expect(restored).toHaveLength(1)
    expect(restored[0]?.content[0]).toMatchObject({ text: expect.stringContaining('/ global /') })

    await context.disable(agent.session.id)
    expect(context.getSessionState(agent.session.id).layers.global.enabled).toBe(false)
    const disabled: UserMessage[] = []
    await restarted.restore({ session: agent.session, inject: message => { disabled.push(message) } })
    expect(disabled).toEqual([])
    expect(messages).toHaveLength(2)
  })

  it('renders global snapshots from all workspaces instead of legacy global entries', async () => {
    const { store, context, agent } = await setup()
    const first = workspaceId('workspace-1')
    const second = workspaceId('workspace-2')
    for (const [id, summary] of [[first, 'First project rule'], [second, 'Second project rule']] as const) {
      await store.upsert({
        scope: { kind: 'workspace', workspaceId: id }, category: 'project-convention',
        summary, detail: summary, sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
      })
    }
    await store.upsert({
      scope: { kind: 'global' }, category: 'preference', summary: 'Legacy global preference',
      detail: 'Legacy global preference', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    await context.enable(agent, 'global')
    const snapshot = context.getSessionState(agent.session.id).layers.global.desired[0]?.snapshot
    expect(snapshot).toContain('First project rule')
    expect(snapshot).toContain('Second project rule')
    expect(snapshot).toContain('workspace-1')
    expect(snapshot).toContain('workspace-2')
    expect(snapshot).not.toContain('Legacy global preference')
  })

  it('defaults to disabled and automatically queues each layer only once', async () => {
    const { store, context, agent, messages } = await setup()

    expect(context.getSessionState('session-1').layers.global.enabled).toBe(false)
    await context.enable(agent, 'global')
    await context.enable(agent, 'global')

    const state = context.getSessionState('session-1')
    expect(state.layers.global.enabled).toBe(true)
    expect(state.layers.global.desired).toHaveLength(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.source).toEqual({ kind: 'snail-memory' })
    await expect(context.refresh(agent, 'global')).resolves.toMatchObject({ status: 'up-to-date' })
    expect(store.getSessionState('session-1').layers.global.desired).toHaveLength(1)
  })

  it('counts tokens only after the matching Session commit and deduplicates notifications', async () => {
    const { context, agent, messages } = await setup()
    await context.enable(agent, 'global')
    const desired = context.getSessionState('session-1').layers.global.desired[0]!
    const message = messages[0]!

    expect(context.getSessionState('session-1').layers.global.committed).toEqual([])
    await context.handleSessionEvent('session-1', {
      type: 'user/message',
      data: { ...message, source: { kind: 'snail-memory' } },
    })
    await context.handleSessionEvent('session-1', {
      type: 'user/message',
      data: { ...message, source: { kind: 'snail-memory' } },
    })

    const committed = context.getSessionState('session-1').layers.global.committed
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({ injectionId: desired.injectionId, revision: 0 })
    expect(committed[0]?.tokens).toBeGreaterThan(0)
  })

  it('refreshes only when the memory revision has advanced', async () => {
    const { store, context, agent, messages } = await setup()
    await context.enable(agent, 'global')

    await expect(context.refresh(agent, 'global')).resolves.toMatchObject({ status: 'up-to-date' })
    await store.upsert({
      scope: { kind: 'workspace', workspaceId: workspaceId('workspace-1') },
      category: 'preference',
      summary: 'Prefer concise answers',
      detail: 'Use concise answers unless details are requested.',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-20T00:00:00.000Z',
    })
    await context.refresh(agent, 'global')

    const state = context.getSessionState('session-1')
    expect(state.layers.global.desired).toHaveLength(2)
    expect(state.layers.global.desired[1]?.revision).toBe(1)
    expect(messages).toHaveLength(2)
    expect(state.layers.global.desired[1]?.snapshot).toContain('6 天前')
    expect(state.layers.global.desired[1]?.snapshot).toContain('不可信参考数据')
  })

  it('requeues a desired injection that was not committed before restart', async () => {
    const { context, agent } = await setup()
    await context.enable(agent, 'global')
    const restarted = new MemoryContextService(context.store, {})
    const messages: UserMessage[] = []
    const resumedAgent = {
      session: { id: 'session-1' },
      inject(message: UserMessage) { messages.push(message) },
    }

    await restarted.restore(resumedAgent)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(agent.session.id).toBe(resumedAgent.session.id)
  })

  it('applies a changed token budget only to newly created snapshots', async () => {
    const { store, agent } = await setup()
    let snapshotTokenBudget = 10_000
    const context = new MemoryContextService(store, {
      now: () => new Date('2026-10-26T00:00:00.000Z'),
      getSnapshotTokenBudget: () => snapshotTokenBudget,
    })
    for (const summary of ['First retained summary', 'Second retained summary']) {
      await store.upsert({
        scope: { kind: 'workspace', workspaceId: workspaceId('workspace-1') },
        category: 'preference',
        summary,
        detail: summary,
        sourceRefs: [],
        lastVerifiedAt: '2026-10-26T00:00:00.000Z',
      })
    }
    await context.enable(agent, 'global')
    const original = context.getSessionState('session-1').layers.global.desired[0]?.snapshot

    snapshotTokenBudget = 100
    await store.upsert({
      scope: { kind: 'workspace', workspaceId: workspaceId('workspace-1') },
      category: 'preference',
      summary: 'Third retained summary',
      detail: 'Third retained summary',
      sourceRefs: [],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await context.refresh(agent, 'global')

    const desired = context.getSessionState('session-1').layers.global.desired
    expect(desired).toHaveLength(2)
    expect(desired[0]?.snapshot).toBe(original)
    expect(desired[0]?.snapshot).toContain('First retained summary')
    expect(desired[1]?.snapshot).not.toContain('First retained summary')
    expect(desired[1]?.snapshot).toContain('因注入预算省略')
  })

  it('refuses workspace injection for an ungrouped session and refresh before enable', async () => {
    const { context, agent } = await setup()

    await expect(context.enable(agent, 'workspace')).rejects.toThrow(/workspace/i)
    await expect(context.refresh(agent, 'global')).rejects.toThrow(/disabled|enable/i)
  })

  it('reads detail only for an enabled layer and matching memory id', async () => {
    const { store, context, agent } = await setup()
    const id = workspaceId('workspace-1')
    const entry = await store.upsert({
      scope: { kind: 'workspace', workspaceId: id },
      category: 'long-term-decision',
      summary: 'Keep Session append-only',
      detail: 'Never rewrite a committed memory snapshot.',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    await expect(context.readDetail('session-1', 'global', memoryId('missing'), id)).resolves.toBeNull()
    await expect(context.readDetail('session-1', 'global', entry.id, id)).resolves.toBeNull()
    await context.enable(agent, 'global')
    expect((await context.readDetail('session-1', 'global', entry.id))?.detail).toBeUndefined()
    expect((await context.readDetail('session-1', 'global', entry.id, id))?.detail).toBe('Never rewrite a committed memory snapshot.')
  })

  it('uses the attached workspace id for workspace memory', async () => {
    const { store, context, agent } = await setup()
    const id = workspaceId('workspace-1')
    await store.upsert({
      scope: { kind: 'workspace', workspaceId: id },
      category: 'project-convention',
      summary: 'Use focused tests',
      detail: 'Run the package test first.',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    await context.enable(agent, 'workspace', id)

    expect(context.getSessionState('session-1').workspaceId).toBe(id)
    expect(context.getSessionState('session-1').layers.workspace.desired[0]?.revision).toBe(1)
  })
})

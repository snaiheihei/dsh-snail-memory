import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryContextService, type InjectionAgent, type SessionEventLike } from '../../src/context/service.js'
import { snapshotMetadata } from '../../src/context/snapshot.js'
import { MemoryStore } from '../../src/store/store.js'
import { memoryId, workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []

function fakeAgent(sessionId = 'session-1') {
  const injected: UserMessage[] = []
  const events: SessionEventLike[] = []
  let nextTurn: UserMessage[] = []
  let nextStep: UserMessage[] = []
  const pending = () => [...nextStep, ...nextTurn]
  const agent: InjectionAgent = {
    session: { id: sessionId, snapshotEvents: () => events },
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      remove(messageId) {
        const before = nextTurn.length + nextStep.length
        nextTurn = nextTurn.filter(message => message.id !== messageId)
        nextStep = nextStep.filter(message => message.id !== messageId)
        return nextTurn.length + nextStep.length !== before
      },
      replace(messageId, replacement) {
        for (const target of ['next-turn', 'next-step'] as const) {
          const messages = target === 'next-turn' ? nextTurn : nextStep
          const index = messages.findIndex(message => message.id === messageId)
          if (index < 0) continue
          messages[index] = replacement
          return true
        }
        return false
      },
    },
    inject(message) {
      injected.push(message)
      nextTurn.push(message)
    },
  }
  return {
    agent,
    injected,
    pending,
    claim() {
      const claimed = pending()
      nextTurn = []
      nextStep = []
      return claimed
    },
    clearPending() {
      nextTurn = []
      nextStep = []
    },
    record(message: UserMessage) {
      events.push({ type: 'user/message', data: message })
    },
  }
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function snailMessages(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => snapshotMetadata(message) !== null)
}

async function preStep(
  context: MemoryContextService,
  agent: InjectionAgent,
  messages: UserMessage[],
  turn = 1,
  downstreamMessages = messages,
) {
  return context.handlePreStep(agent, { messages, turn, step: 1 }, async () => ({
    kind: 'enter', messages: downstreamMessages,
  }))
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-context-'))
  roots.push(root)
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  const context = new MemoryContextService(store, {
    now: () => new Date('2026-10-26T00:00:00.000Z'),
  })
  const runtime = fakeAgent()
  return { root, store, context, ...runtime }
}

async function addGlobalMemory(store: MemoryStore, summary: string) {
  return store.upsert({
    scope: { kind: 'workspace', workspaceId: workspaceId('workspace-1') },
    category: 'preference',
    summary,
    detail: summary,
    sourceRefs: [{ sessionId: 'session-1' }],
    lastVerifiedAt: '2026-10-20T00:00:00.000Z',
  })
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemoryContextService single-snapshot protocol', () => {
  it.each([
    ['workspace', 'global'],
    ['global', 'workspace'],
  ] as const)('switching %s to %s leaves one pending and one committed snapshot', async (first, second) => {
    const { context, agent, pending, claim, record } = await setup()
    const id = workspaceId('workspace-1')
    await context.enable(agent, first, id)
    await context.enable(agent, second, id)

    const queued = snailMessages(pending())
    expect(queued).toHaveLength(1)
    expect(snapshotMetadata(queued[0]!)?.layer).toBe(second)
    expect(context.getSessionState('session-1').activeDesired).toMatchObject({ layer: second })

    const decision = await preStep(context, agent, [...claim(), userMessage('continue')])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const admitted = snailMessages(decision.messages)
    expect(admitted).toHaveLength(1)
    record(admitted[0]!)
    await context.handleSessionEvent('session-1', { type: 'user/message', data: admitted[0]! })
    const state = context.getSessionState('session-1')
    expect(state.layers[first].committed).toEqual([])
    expect(state.layers[second].committed).toHaveLength(1)
    expect(state.activeDesired).toBeNull()
  })

  it('coalesces multiple revision-advancing refreshes into the latest active generation', async () => {
    const { store, context, agent, pending } = await setup()
    await context.enable(agent, 'global')
    await addGlobalMemory(store, 'First revision')
    await context.refresh(agent, 'global')
    await addGlobalMemory(store, 'Second revision')
    await context.refresh(agent, 'global')

    const state = context.getSessionState('session-1')
    const queued = snailMessages(pending())
    expect(state.layers.global.desired).toHaveLength(3)
    expect(state.activeDesired).toMatchObject({ layer: 'global', injectionId: state.layers.global.desired[2]!.injectionId })
    expect(queued).toHaveLength(1)
    expect(snapshotMetadata(queued[0]!)?.revision).toBe(2)
    expect(queued[0]?.content[0]).toMatchObject({ text: expect.stringContaining('Second revision') })
    expect(state.layers.global.committed).toEqual([])
  })

  it('keeps repeated enable and up-to-date refresh idempotent', async () => {
    const { context, agent, injected, pending } = await setup()
    await context.enable(agent, 'global')
    await context.enable(agent, 'global')
    await expect(context.refresh(agent, 'global')).resolves.toMatchObject({ status: 'up-to-date' })

    expect(context.getSessionState('session-1').layers.global.desired).toHaveLength(1)
    expect(injected).toHaveLength(1)
    expect(snailMessages(pending())).toHaveLength(1)
  })

  it('uses the current revision instead of a stale automatic desired when switching back', async () => {
    const { store, context, agent, pending } = await setup()
    const id = workspaceId('workspace-1')
    await context.enable(agent, 'global')
    const original = context.getSessionState('session-1').activeDesired
    await context.enable(agent, 'workspace', id)
    await addGlobalMemory(store, 'Current global revision')
    await context.enable(agent, 'global')

    const state = context.getSessionState('session-1')
    expect(state.activeDesired).not.toEqual(original)
    expect(state.activeDesired?.layer).toBe('global')
    expect(state.layers.global.desired).toHaveLength(2)
    expect(snapshotMetadata(snailMessages(pending())[0]!)?.revision).toBe(1)
  })

  it('disable withdraws the uncommitted snapshot and restore adds nothing', async () => {
    const { context, agent, pending } = await setup()
    await context.enable(agent, 'global')
    await context.disable(agent)

    expect(context.getSessionState('session-1').activeDesired).toBeNull()
    expect(snailMessages(pending())).toEqual([])
    const restarted = new MemoryContextService(context.store, {})
    await restarted.restore(agent)
    expect(snailMessages(pending())).toEqual([])
  })

  it('filters a stale claimed snapshot after a layer switch without touching user input', async () => {
    const { context, agent, claim, pending } = await setup()
    const id = workspaceId('workspace-1')
    await context.enable(agent, 'global')
    const [stale] = claim()
    await context.enable(agent, 'workspace', id)
    const prompt = userMessage('ordinary prompt')

    const decision = await preStep(context, agent, [stale!, prompt])
    expect(decision).toEqual({ kind: 'enter', messages: [prompt] })
    await expect(context.handleSessionEvent('session-1', { type: 'user/message', data: stale! })).resolves.toBe(false)
    expect(context.getSessionState('session-1').layers.global.committed).toEqual([])
    expect(snapshotMetadata(snailMessages(pending())[0]!)?.layer).toBe('workspace')
  })

  it('commits the admitted generation after refresh and defers the new generation to a later turn', async () => {
    const { store, context, agent, claim, pending, record } = await setup()
    await context.enable(agent, 'global')
    const [admitted] = claim()
    const first = await preStep(context, agent, [admitted!, userMessage('first prompt')], 1)
    await addGlobalMemory(store, 'New memory after admission')
    await context.refresh(agent, 'global')
    const refreshed = context.getSessionState('session-1').activeDesired

    record(admitted!)
    await expect(context.handleSessionEvent('session-1', { type: 'user/message', data: admitted! })).resolves.toBe(true)
    expect(context.getSessionState('session-1').layers.global.committed).toHaveLength(1)
    expect(context.getSessionState('session-1').layers.global.committed[0]?.injectionId)
      .toBe(snapshotMetadata(admitted!)?.injectionId)
    expect(context.getSessionState('session-1').activeDesired).toEqual(refreshed)
    expect(snailMessages(pending())).toHaveLength(1)

    const [next] = claim()
    const sameTurn = await preStep(context, agent, [next!, userMessage('same-turn steering')], 1)
    expect(sameTurn.kind).toBe('enter')
    if (sameTurn.kind !== 'enter') return
    expect(snailMessages(sameTurn.messages)).toEqual([])
    expect(snailMessages(pending())).toEqual([])
    // The Host restores deferred active state when the agent becomes idle.
    await context.restore(agent)
    expect(snailMessages(pending())).toHaveLength(1)

    const [deferred] = claim()
    const second = await preStep(context, agent, [deferred!, userMessage('second prompt')], 2)
    expect(second.kind).toBe('enter')
    if (second.kind !== 'enter') return
    expect(snailMessages(second.messages)).toHaveLength(1)
    record(deferred!)
    await context.handleSessionEvent('session-1', { type: 'user/message', data: deferred! })
    expect(context.getSessionState('session-1').layers.global.committed).toHaveLength(2)
    expect(first.kind).toBe('enter')
  })

  it('admits one Snail snapshot per turn while preserving downstream messages', async () => {
    const { context, agent, claim, record } = await setup()
    await context.enable(agent, 'global')
    const [snapshot] = claim()
    const prompt = userMessage('ordinary prompt')
    const downstream = userMessage('downstream context')

    const decision = await preStep(context, agent, [snapshot!, prompt], 1, [snapshot!, snapshot!, prompt, downstream])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(snailMessages(decision.messages)).toHaveLength(1)
    expect(decision.messages.filter(message => !snapshotMetadata(message))).toEqual([prompt, downstream])

    const secondStep = await preStep(context, agent, [snapshot!, prompt], 1)
    expect(secondStep).toEqual({ kind: 'enter', messages: [prompt] })
    record(snapshot!)
    await context.handleSessionEvent('session-1', { type: 'user/message', data: snapshot! })
    await context.handleSessionEvent('session-1', { type: 'user/message', data: snapshot! })
    const committed = context.getSessionState('session-1').layers.global.committed
    expect(committed).toHaveLength(1)
    expect(committed[0]?.tokens).toBeGreaterThan(0)
  })

  it('preserves a downstream reject decision without admitting a snapshot', async () => {
    const { context, agent, claim } = await setup()
    await context.enable(agent, 'global')
    const [snapshot] = claim()
    const decision = await context.handlePreStep(agent, { messages: [snapshot!], turn: 1, step: 1 }, async () => ({ kind: 'reject' }))

    expect(decision).toEqual({ kind: 'reject' })
    await expect(context.handleSessionEvent('session-1', { type: 'user/message', data: snapshot! })).resolves.toBe(false)
  })

  it('restores at most one pending generation without duplicating an existing Inbox item', async () => {
    const { context, agent, injected, pending } = await setup()
    await context.enable(agent, 'global')
    const restarted = new MemoryContextService(context.store, {})

    await restarted.restore(agent)
    await restarted.restore(agent)

    expect(snailMessages(pending())).toHaveLength(1)
    expect(injected).toHaveLength(1)
  })

  it('reconciles Session history before restore across the commit persistence crash window', async () => {
    const { context, agent, clearPending, record } = await setup()
    await context.enable(agent, 'global')
    const [snapshot] = snailMessages(agent.inbox.nextTurn)
    clearPending()
    record(snapshot!)

    const restarted = new MemoryContextService(context.store, {})
    const resumed = fakeAgent()
    resumed.record(snapshot!)
    await restarted.restore(resumed.agent)

    expect(restarted.getSessionState('session-1').layers.global.committed).toHaveLength(1)
    expect(snailMessages(resumed.pending())).toEqual([])
    expect(resumed.injected).toEqual([])
  })

  it('uses Session history to suppress duplicate restore even while the store is read-only', async () => {
    const { root, context, agent } = await setup()
    await context.enable(agent, 'global')
    const [snapshot] = snailMessages(agent.inbox.nextTurn)
    const secondary = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(secondary)
    expect(secondary.writable).toBe(false)
    const restarted = new MemoryContextService(secondary, {})
    const resumed = fakeAgent()
    resumed.record(snapshot!)

    await expect(restarted.restore(resumed.agent)).resolves.toBeUndefined()
    expect(snailMessages(resumed.pending())).toEqual([])
    expect(resumed.injected).toEqual([])
  })
})

describe('MemoryContextService snapshots and detail reads', () => {
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
    const active = context.getSessionState('session-1').activeDesired
    const snapshot = context.getSessionState('session-1').layers.global.desired
      .find(item => item.injectionId === active?.injectionId)?.snapshot
    expect(snapshot).toContain('First project rule')
    expect(snapshot).toContain('Second project rule')
    expect(snapshot).toContain('workspace-1')
    expect(snapshot).toContain('workspace-2')
    expect(snapshot).not.toContain('Legacy global preference')
  })

  it('applies a changed token budget only to newly created snapshots', async () => {
    const { store, agent } = await setup()
    let snapshotTokenBudget = 10_000
    const context = new MemoryContextService(store, {
      now: () => new Date('2026-10-26T00:00:00.000Z'),
      getSnapshotTokenBudget: () => snapshotTokenBudget,
    })
    for (const summary of ['First retained summary', 'Second retained summary']) {
      await addGlobalMemory(store, summary)
    }
    await context.enable(agent, 'global')
    const original = context.getSessionState('session-1').layers.global.desired[0]?.snapshot

    snapshotTokenBudget = 100
    await addGlobalMemory(store, 'Third retained summary')
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

  it('uses an explicit workspace as the recall selection without changing the Session owner', async () => {
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

    expect(context.getSessionState('session-1').workspaceId).toBeUndefined()
    expect(context.getSessionState('session-1').selectedWorkspaceId).toBe(id)
    expect(context.getSessionState('session-1').layers.workspace.desired[0]?.revision).toBe(1)
  })

  it('switches between workspaces with one active snapshot and an unchanged distillation owner', async () => {
    const { store, context, agent, pending } = await setup()
    const first = workspaceId('workspace-1')
    const second = workspaceId('workspace-2')
    await store.updateSessionState('session-1', state => { state.workspaceId = first })
    for (const [id, summary] of [[first, 'First project memory'], [second, 'Second project memory']] as const) {
      await store.upsert({
        scope: { kind: 'workspace', workspaceId: id }, category: 'project-convention',
        summary, detail: summary, sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
      })
    }

    await context.enable(agent, 'workspace', first)
    await context.enable(agent, 'workspace', second)

    const state = context.getSessionState('session-1')
    expect(state.workspaceId).toBe(first)
    expect(state.selectedWorkspaceId).toBe(second)
    const queued = snailMessages(pending())
    expect(queued).toHaveLength(1)
    expect(queued[0]?.content[0]).toMatchObject({ text: expect.stringContaining('Second project memory') })
    await expect(context.enable(agent, 'workspace', second)).resolves.toMatchObject({ status: 'already-enabled' })
    expect(context.getSessionState('session-1').layers.workspace.desired).toHaveLength(2)
  })

  it('refreshes against the selected workspace revision instead of another workspace revision', async () => {
    const { store, context, agent } = await setup()
    const first = workspaceId('workspace-1')
    const second = workspaceId('workspace-2')
    const write = async (workspaceId: typeof first, summary: string) => store.upsert({
      scope: { kind: 'workspace', workspaceId }, category: 'project-convention',
      summary, detail: summary, sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await write(first, 'First project revision one')
    await write(first, 'First project revision two')
    await write(second, 'Second project revision one')
    await context.enable(agent, 'workspace', first)
    await context.enable(agent, 'workspace', second)
    await write(second, 'Second project revision two')

    await expect(context.refresh(agent, 'workspace')).resolves.toMatchObject({ status: 'refreshed' })
    const desired = context.getSessionState('session-1').layers.workspace.desired
    expect(desired.at(-1)).toMatchObject({ revision: 2, workspaceId: second })
  })

  it('treats legacy workspace desired as owned by the Session workspace during refresh', async () => {
    const { store, context, agent } = await setup()
    const owner = workspaceId('workspace-1')
    await store.updateSessionState('session-1', state => { state.workspaceId = owner })
    await store.upsert({
      scope: { kind: 'workspace', workspaceId: owner }, category: 'project-convention',
      summary: 'Legacy revision', detail: 'Legacy revision', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await context.enable(agent, 'workspace', owner)
    await store.updateSessionState('session-1', state => {
      Reflect.deleteProperty(state, 'selectedWorkspaceId')
      Reflect.deleteProperty(state.layers.workspace.desired[0]!, 'workspaceId')
    })

    await expect(context.refresh(agent, 'workspace')).resolves.toMatchObject({ status: 'up-to-date' })
    expect(context.getSessionState('session-1').layers.workspace.desired).toHaveLength(1)
  })
})

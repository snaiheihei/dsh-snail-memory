import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryContextService } from '../../src/context/service.js'
import { MemoryController } from '../../src/api/controller.js'
import { MemorySettingsStore } from '../../src/lifecycle/settings.js'
import { MemoryStore } from '../../src/store/store.js'
import { memoryId, workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []
const DEFAULT_RETENTION_DAYS = {
  'environment-fact': 30,
  'project-convention': 180,
  troubleshooting: 180,
  preference: 0,
  'long-term-decision': 0,
}

async function open(root: string) {
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000, now: () => new Date('2026-10-26T00:00:00.000Z') })
  stores.push(store)
  return store
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-api-'))
  roots.push(root)
  const store = await open(root)
  const context = new MemoryContextService(store, {})
  const messages: UserMessage[] = []
  const agent = { session: { id: 'session-1' }, inject(message: UserMessage) { messages.push(message) } }
  const controller = new MemoryController(store, context, {
    resolveSession(sessionId) {
      return sessionId === 'session-1' ? { agent, workspaceId: workspaceId('workspace-1') } : undefined
    },
    isWorkspace: id => id === 'workspace-1',
    now: () => new Date('2026-10-26T00:00:00.000Z'),
  })
  return { root, store, context, controller, agent, messages }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemoryController', () => {
  it('enables and refreshes a live session through the shared context service', async () => {
    const { store, controller, messages } = await setup()

    await expect(controller.call('enable', { sessionId: 'session-1', layer: 'workspace' })).resolves.toMatchObject({ status: 'enabled' })
    expect(messages).toHaveLength(1)
    expect(store.getSessionState('session-1').workspaceId).toBe('workspace-1')
    await expect(controller.call('refresh', { sessionId: 'session-1', layer: 'workspace' })).resolves.toMatchObject({ status: 'up-to-date' })
  })

  it('returns durable session state with pending rather than acknowledged token counts', async () => {
    const { controller } = await setup()
    await controller.call('enable', { sessionId: 'session-1', layer: 'global' })

    const state = await controller.call('getSessionState', { sessionId: 'session-1' })
    expect(state.layers.global.enabled).toBe(true)
    expect(state.layers.global.pending).toBe(1)
    expect(state.layers.global.committedTokens).toBe(0)
    expect(state.workspaceId).toBe('workspace-1')
  })

  it('sanitizes explicit memories and writes corrections immediately', async () => {
    const { controller, store } = await setup()
    const remembered = await controller.call('remember', {
      scope: { kind: 'global' }, category: 'preference', summary: 'api_key="sk-abcdefghijklmnop1234"', detail: 'Keep answers concise.',
    })
    expect(remembered.summary).toContain('[REDACTED')
    expect(store.list({ kind: 'global' }).revision).toBe(1)

    const corrected = await controller.call('correct', {
      id: remembered.id, scope: { kind: 'global' }, category: 'preference', summary: 'Prefer detail', detail: 'Include tradeoffs.',
    })
    expect(corrected.id).toBe(remembered.id)
    expect(corrected.createdAt).toBe(remembered.createdAt)
    expect(store.list({ kind: 'global' }).revision).toBe(2)
  })

  it('forgets only a memory and preserves all session injection history', async () => {
    const { controller, store } = await setup()
    await controller.call('enable', { sessionId: 'session-1', layer: 'global' })
    const before = store.getSessionState('session-1')
    const entry = await controller.call('remember', {
      scope: { kind: 'global' }, category: 'long-term-decision', summary: 'Append only', detail: 'Never rewrite history.',
    })

    await expect(controller.call('remove', { scope: { kind: 'global' }, id: entry.id })).resolves.toEqual({ removed: true })
    await expect(controller.call('remove', { scope: { kind: 'global' }, id: entry.id })).resolves.toEqual({ removed: false })
    await expect(store.read({ kind: 'global' }, entry.id)).resolves.toBeNull()
    expect(store.getSessionState('session-1')).toEqual(before)
  })

  it('sanitizes lazy detail read failures at the controller boundary', async () => {
    const { controller, store } = await setup()
    const entry = await controller.call('remember', {
      scope: { kind: 'global' }, category: 'long-term-decision', summary: 'Safe read error', detail: 'Detail',
    })
    await writeFile(store.paths.detailRecord(entry.id, entry.revision), '{not json')

    await expect(controller.call('read', { scope: { kind: 'global' }, id: entry.id })).rejects.toMatchObject({
      code: 'internal',
      message: 'Snail Memory could not complete the operation.',
    })
  })

  it('rejects missing sessions, unknown workspaces, and reads of missing entries', async () => {
    const { controller } = await setup()

    await expect(controller.call('enable', { sessionId: 'missing', layer: 'global' })).rejects.toMatchObject({ code: 'session-not-found' })
    await expect(controller.call('list', { scope: { kind: 'workspace', workspaceId: workspaceId('unknown') } })).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(controller.call('read', { scope: { kind: 'global' }, id: memoryId('missing') })).rejects.toMatchObject({ code: 'memory-not-found' })
  })

  it('uses the lifecycle write path so explicit changes enter maintenance scheduling', async () => {
    const { store, context } = await setup()
    const calls: string[] = []
    const lifecycle = {
      async remember(input: Parameters<MemoryStore['upsert']>[0]) { calls.push('remember'); return store.upsert(input) },
      async correct(input: Parameters<MemoryStore['upsert']>[0] & { id: ReturnType<typeof memoryId> }) { calls.push('correct'); return store.upsert(input) },
      async forget(scope: Parameters<MemoryStore['remove']>[0], id: Parameters<MemoryStore['remove']>[1]) { calls.push('forget'); return store.remove(scope, id) },
    }
    const controller = new MemoryController(store, context, {
      resolveSession: () => undefined,
      lifecycle,
    })
    const entry = await controller.call('remember', { scope: { kind: 'global' }, category: 'preference', summary: 'Remember', detail: 'Now' })
    await controller.call('correct', { id: entry.id, scope: { kind: 'global' }, category: 'preference', summary: 'Correct', detail: 'Now' })
    await controller.call('remove', { scope: { kind: 'global' }, id: entry.id })

    expect(calls).toEqual(['remember', 'correct', 'forget'])
  })

  it('lists every registered workspace and reads and updates lifecycle settings', async () => {
    const { store, context } = await setup()
    const settings = await MemorySettingsStore.open(store)
    const controller = new MemoryController(store, context, {
      resolveSession: () => undefined,
      settings: { getSettings: () => settings.get(), updateSettings: input => settings.update(input) },
      listWorkspaces: () => [
        { id: workspaceId('workspace-1'), title: 'First project' },
        { id: workspaceId('workspace-2'), title: 'No memories yet' },
      ],
    })

    await expect(controller.call('listWorkspaces', {})).resolves.toEqual([
      { id: 'workspace-1', title: 'First project' },
      { id: 'workspace-2', title: 'No memories yet' },
    ])
    await expect(controller.call('getSettings', {})).resolves.toEqual({
      reviewEveryUserTurns: 15,
      idleDelayMinutes: 60,
      consolidationCooldownHours: 20,
      snapshotTokenBudget: 1_200,
      retentionDays: DEFAULT_RETENTION_DAYS,
    })
    await expect(controller.call('updateSettings', {
      reviewEveryUserTurns: 4,
      idleDelayMinutes: 2,
      consolidationCooldownHours: 8,
      snapshotTokenBudget: 800,
      retentionDays: { ...DEFAULT_RETENTION_DAYS, 'project-convention': 90 },
    })).resolves.toEqual({
      reviewEveryUserTurns: 4,
      idleDelayMinutes: 2,
      consolidationCooldownHours: 8,
      snapshotTokenBudget: 800,
      retentionDays: { ...DEFAULT_RETENTION_DAYS, 'project-convention': 90 },
    })
  })

  it('keeps reads available on a secondary read-only host but rejects writes', async () => {
    const { root, store } = await setup()
    await store.upsert({ scope: { kind: 'global' }, category: 'preference', summary: 'Readable', detail: 'Still available.', sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z' })
    const secondary = await open(root)
    const settings = await MemorySettingsStore.open(secondary)
    const controller = new MemoryController(secondary, new MemoryContextService(secondary, {}), {
      resolveSession: () => undefined,
      isWorkspace: () => true,
      settings: { getSettings: () => settings.get(), updateSettings: input => settings.update(input) },
    })

    await expect(controller.call('list', { scope: { kind: 'global' } })).resolves.toMatchObject({ entries: [{ summary: 'Readable' }] })
    await expect(controller.call('remember', {
      scope: { kind: 'global' }, category: 'preference', summary: 'No write', detail: 'Rejected.',
    })).rejects.toMatchObject({ code: 'read-only' })
    await expect(controller.call('updateSettings', {
      reviewEveryUserTurns: 2,
      idleDelayMinutes: 1,
      consolidationCooldownHours: 3,
      snapshotTokenBudget: 600,
      retentionDays: DEFAULT_RETENTION_DAYS,
    })).rejects.toMatchObject({ code: 'read-only' })
    expect((await controller.call('status', {})).writable).toBe(false)
  })
})

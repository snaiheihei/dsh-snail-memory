// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryPage } from '../../client/src/MemoryPage.js'
import { MemoryClientStore } from '../../client/src/store.js'
import type { WorkspaceId } from '../../src/store/types.js'
import { deferred, ENTRY, FakeRpc, GLOBAL_SCOPE, memoryIndex, sessionState, t, WORKSPACE_SCOPE } from './fixtures.js'

afterEach(cleanup)

const DEFAULT_RETENTION_DAYS = {
  'environment-fact': 30,
  'project-convention': 180,
  troubleshooting: 180,
  preference: 0,
  'long-term-decision': 0,
}

function readyRpc() {
  return new FakeRpc()
    .on('getSessionState', () => sessionState('session-1', true))
    .on('list', ({ scope }) => memoryIndex(scope))
    .on('read', () => ENTRY)
    .on('remove', () => ({ removed: true }))
    .on('promote', () => ({ id: ENTRY.id, created: true }))
    .on('consolidate', () => ({ intentId: 'intent-1', written: 2 }))
    .on('listWorkspaces', () => [
      { id: 'workspace-1' as WorkspaceId, title: 'First project' },
      { id: 'workspace-2' as WorkspaceId, title: 'Second project' },
    ])
    .on('getSettings', () => ({
      reviewEveryUserTurns: 15,
      idleDelayMinutes: 60,
      consolidationCooldownHours: 20,
      globalConsolidationCooldownDays: 7,
      snapshotTokenBudget: 1_200,
      retentionDays: DEFAULT_RETENTION_DAYS,
    }))
    .on('updateSettings', settings => settings)
}

describe('MemoryPage', () => {
  it('shows three tabs, Host counts, references, latest committed snapshot, and estimated session tokens', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    expect(screen.getByRole('tab', { name: 'Global memory index' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Workspaces' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('false')
    await waitFor(() => expect(document.querySelector('[data-snail="memory-count"]')?.textContent).toBe('1'))
    expect(document.querySelector('[data-snail="session-tokens"]')?.textContent).toBe('20')
    expect(document.querySelector('[data-snail="session-revision"]')?.textContent).toBe('1')
    expect(screen.getByText('Use pnpm workspaces')).toBeTruthy()
    expect(within(screen.getByRole('list')).getByText('Project convention')).toBeTruthy()
    expect(screen.getByText('Rank: 0 · Updated: 2026-01-02 11:04 · revision 2')).toBeTruthy()
    expect(screen.queryByText(/Sources:/)).toBeNull()
    expect(screen.getByRole('button', { name: 'View details for Use pnpm workspaces' }).textContent).toBe('Detail')
    expect(screen.queryByText('Workspace references')).toBeNull()
    expect(screen.queryByText(/provider exact usage/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    expect(screen.getByRole('tab', { name: 'Workspaces' }).getAttribute('aria-selected')).toBe('true')
    const select = await screen.findByRole('combobox', { name: 'Workspace' })
    expect((select as HTMLSelectElement).value).toBe('workspace-1')
    expect(screen.getByRole('option', { name: 'Second project' })).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-snail="memory-count"]')?.textContent).toBe('1'))

    fireEvent.change(select, { target: { value: 'workspace-2' } })
    await waitFor(() => expect(rpc.calls.some(call => call.method === 'list'
      && JSON.stringify(call.payload).includes('workspace-2'))).toBe(true))
  })

  it('requires confirmation and reports the real result of global consolidation', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate global memory' }))
    expect(screen.getByText(/Consolidate global memory now\?/)).toBeTruthy()
    expect(rpc.count('consolidate')).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm consolidation' }))

    expect(await screen.findByText('Consolidation completed: 2 memories written.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'consolidate')?.payload).toEqual({ scope: GLOBAL_SCOPE })
  })

  it('consolidates only the selected workspace after confirmation', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    const select = await screen.findByRole('combobox', { name: 'Workspace' })
    fireEvent.change(select, { target: { value: 'workspace-2' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate workspace memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm consolidation' }))

    expect(await screen.findByText('Consolidation completed: 2 memories written.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'consolidate')?.payload).toEqual({
      scope: { kind: 'workspace', workspaceId: 'workspace-2' },
    })
  })

  it('does not publish a stale consolidation result after switching tabs', async () => {
    const consolidation = deferred<{ intentId: string; written: number }>()
    const rpc = readyRpc().on('consolidate', () => consolidation.promise)
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate global memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm consolidation' }))
    await waitFor(() => expect(rpc.count('consolidate')).toBe(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    await screen.findByRole('combobox', { name: 'Workspace' })

    await act(async () => {
      consolidation.resolve({ intentId: 'intent-1', written: 2 })
      await consolidation.promise
    })

    expect(screen.queryByText(/Consolidation completed:/)).toBeNull()
  })

  it('sorts a copied index by rank, updated time and id, and shows rank in list and details', async () => {
    const entries = [
      { ...ENTRY, id: 'memory-c' as typeof ENTRY.id, summary: 'Newer low rank', rank: 1, updatedAt: '2026-01-04T00:00:00.000Z' },
      { ...ENTRY, id: 'memory-d' as typeof ENTRY.id, summary: 'Same rank B', rank: 2, updatedAt: '2026-01-03T00:00:00.000Z' },
      { ...ENTRY, id: 'memory-b' as typeof ENTRY.id, summary: 'Older high rank', rank: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...ENTRY, id: 'memory-a' as typeof ENTRY.id, summary: 'Same rank A', rank: 2, updatedAt: '2026-01-03T00:00:00.000Z' },
    ]
    const rpc = readyRpc()
      .on('list', ({ scope }) => ({ ...memoryIndex(scope), entries: entries.map(entry => ({ ...entry, scope })) }))
      .on('read', ({ id }) => entries.find(entry => entry.id === id)!)
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    await screen.findByRole('button', { name: 'View details for Same rank A' })
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
      'Same rank A', 'Same rank B', 'Older high rank', 'Newer low rank',
    ])
    expect(entries.map(entry => entry.summary)).toEqual([
      'Newer low rank', 'Same rank B', 'Older high rank', 'Same rank A',
    ])
    expect(screen.getAllByText(/Rank: [12]/)).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'View details for Same rank A' }))
    const dialog = await screen.findByRole('dialog', { name: 'Same rank A' })
    expect(within(dialog).getByText('Rank')).toBeTruthy()
    expect(document.querySelector('[data-snail="detail-rank"]')?.textContent).toBe('2')
  })

  it('shows an empty state when the Host has no registered workspaces', async () => {
    const base = sessionState()
    const rpc = new FakeRpc()
      .on('getSessionState', () => ({ sessionId: base.sessionId, layers: base.layers }))
      .on('list', () => memoryIndex())
      .on('listWorkspaces', () => [])
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Workspaces' }))
    expect(await screen.findByText('No workspaces are registered yet.')).toBeTruthy()
    expect(rpc.calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('reads and deletes an independent global memory without touching a source workspace', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    expect(await screen.findByRole('dialog', { name: 'Use pnpm workspaces' })).toBeTruthy()
    expect(screen.getByText(ENTRY.detail)).toBeTruthy()
    expect(document.querySelector('[data-snail="detail-updated"]')?.textContent).toBe('2026-01-02 11:04:05 +08:00')
    expect(rpc.calls.find(call => call.method === 'read')?.payload).toEqual({ scope: GLOBAL_SCOPE, id: ENTRY.id })
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    expect(await screen.findByText('Memory deleted. Conversation history was not deleted; injected snapshots remain.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'remove')?.payload).toEqual({ scope: GLOBAL_SCOPE, id: ENTRY.id })
  })

  it('opens details in a modal overlay and supports Escape and outside dismissal', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    const trigger = await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Use pnpm workspaces' })

    expect(dialog.parentElement?.classList.contains('snail-memory-detail-backdrop')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Use pnpm workspaces' })).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    const reopened = await screen.findByRole('dialog', { name: 'Use pnpm workspaces' })
    fireEvent.pointerDown(reopened)
    expect(screen.getByRole('dialog', { name: 'Use pnpm workspaces' })).toBeTruthy()
    fireEvent.pointerDown(reopened.parentElement!)
    expect(screen.queryByRole('dialog', { name: 'Use pnpm workspaces' })).toBeNull()
  })

  it('corrects a workspace memory from its detail dialog and reloads the index', async () => {
    const rpc = readyRpc().on('correct', ({ scope, id, category, summary, detail }) => ({
      ...ENTRY, id, scope, category, summary, detail, revision: 3, updatedAt: '2026-01-03T00:00:00.000Z',
    }))
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), { target: { value: '  Use the pnpm workspace protocol  ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'Every package keeps a workspace dependency.' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'environment-fact' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Memory updated.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'correct')?.payload).toEqual({
      scope: WORKSPACE_SCOPE,
      id: ENTRY.id,
      category: 'environment-fact',
      summary: 'Use the pnpm workspace protocol',
      detail: 'Every package keeps a workspace dependency.',
      sessionId: 'session-1',
    })
    expect(await screen.findByRole('dialog', { name: 'Use the pnpm workspace protocol' })).toBeTruthy()
    await waitFor(() => expect(rpc.count('list')).toBeGreaterThanOrEqual(2))
  })

  it('refuses a whitespace-only correction without calling the Host', async () => {
    const rpc = readyRpc().on('correct', () => ENTRY)
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('A summary and a body are both required.')).toBeTruthy()
    expect(rpc.count('correct')).toBe(0)
  })

  it('filters the list by category and restores the whole list', async () => {
    const entries = [
      { ...ENTRY, id: 'memory-a' as typeof ENTRY.id, summary: 'Prefer terse answers', category: 'preference' as const },
      { ...ENTRY, id: 'memory-b' as typeof ENTRY.id, summary: 'Use pnpm workspaces', category: 'project-convention' as const },
      { ...ENTRY, id: 'memory-c' as typeof ENTRY.id, summary: 'Node runs on port 3080', category: 'environment-fact' as const },
    ]
    const rpc = readyRpc()
      .on('list', ({ scope }) => ({ ...memoryIndex(scope), entries: entries.map(entry => ({ ...entry, scope })) }))
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    await screen.findByRole('button', { name: 'View details for Prefer terse answers' })
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3)
    expect(document.querySelector('[data-snail="memory-count"]')?.textContent).toBe('3')

    fireEvent.click(screen.getByRole('button', { name: 'Preference 1' }))
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['Prefer terse answers'])
    expect(document.querySelector('[data-snail="memory-count"]')?.textContent).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'All 3' }))
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3)
  })

  it('adds a memory by hand from the global index tab', async () => {
    const rpc = readyRpc().on('remember', ({ scope, category, summary, detail }) => ({
      ...ENTRY, id: 'memory-new' as typeof ENTRY.id, scope, category, summary, detail, revision: 4,
    }))
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    await screen.findByText('Active memories')

    fireEvent.click(screen.getByRole('button', { name: 'New memory' }))
    const dialog = await screen.findByRole('dialog', { name: 'New memory' })
    expect(within(dialog).getByText(/global memory is promoted/)).toBeTruthy()
    const scopeSelect = within(dialog).getByRole('combobox', { name: 'Save to' })
    await waitFor(() => expect(within(scopeSelect).getAllByRole('option')).toHaveLength(2))

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Summary' }), { target: { value: 'Prefer short answers' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Body' }), { target: { value: 'Answer in two sentences unless asked for detail.' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Category' }), { target: { value: 'preference' } })
    fireEvent.change(scopeSelect, { target: { value: 'workspace-2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add memory' }))

    expect(await screen.findByText('Memory added.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'remember')?.payload).toEqual({
      scope: { kind: 'workspace', workspaceId: 'workspace-2' },
      category: 'preference',
      summary: 'Prefer short answers',
      detail: 'Answer in two sentences unless asked for detail.',
      sessionId: 'session-1',
    })
    expect(screen.getByRole('tab', { name: 'Workspaces' }).getAttribute('aria-selected')).toBe('true')
  })

  it('refuses a whitespace-only new memory without calling the Host', async () => {
    const rpc = readyRpc().on('remember', () => ENTRY)
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    await screen.findByText('Active memories')

    fireEvent.click(screen.getByRole('button', { name: 'New memory' }))
    const dialog = await screen.findByRole('dialog', { name: 'New memory' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Summary' }), { target: { value: '  ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Body' }), { target: { value: 'Body text' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add memory' }))

    expect(await within(dialog).findByText('A summary and a body are both required.')).toBeTruthy()
    expect(rpc.count('remember')).toBe(0)
  })

  it('promotes a workspace memory from its detail dialog', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Promote to global memory' }))

    expect(await screen.findByText('Memory promoted to global memory.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'promote')?.payload).toEqual({ scope: WORKSPACE_SCOPE, id: ENTRY.id })
    expect(rpc.count('remove')).toBe(0)
  })

  it('requires confirmation before deleting a workspace memory', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete memory' }))
    expect(screen.getByText('Delete this memory? Conversation history and already injected snapshots will be kept.')).toBeTruthy()
    expect(rpc.count('remove')).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(await screen.findByText('Memory deleted. Conversation history was not deleted; injected snapshots remain.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'remove')?.payload).toEqual({ scope: WORKSPACE_SCOPE, id: ENTRY.id })
    await waitFor(() => expect(rpc.count('list')).toBeGreaterThanOrEqual(3))
    expect(rpc.calls.every(call => !String(call.method).toLowerCase().includes('sessiondelete'))).toBe(true)
  })

  it('can cancel deletion without calling the Host mutation', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(rpc.count('remove')).toBe(0)
    expect(screen.getByRole('dialog', { name: 'Use pnpm workspaces' })).toBeTruthy()
  })

  it('shows an empty current-session token estimate without inventing a workspace', async () => {
    const rpc = new FakeRpc().on('list', () => memoryIndex())
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage store={store} t={t} />)

    await waitFor(() => expect(document.querySelector('[data-snail="session-tokens"]')?.textContent).toBe('0'))
    expect(document.querySelector('[data-snail="session-revision"]')?.textContent).toBe('—')
    expect(rpc.count('getSessionState')).toBe(0)
    expect(rpc.calls.filter(call => call.method === 'list')).toHaveLength(1)
    expect(WORKSPACE_SCOPE.kind).toBe('workspace')
  })

  it('loads lifecycle settings from the Host and saves adjusted values', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    const review = await screen.findByRole('spinbutton', { name: 'Review every N real user turns' })
    const idle = screen.getByRole('spinbutton', { name: 'Idle distillation delay (minutes)' })
    const dirty = screen.getByRole('spinbutton', { name: 'Dirty consolidation delay (hours)' })
    const globalDirty = screen.getByRole('spinbutton', { name: 'Global dirty consolidation delay (days)' })
    const snapshotBudget = screen.getByRole('spinbutton', { name: 'Snapshot token budget (estimated tokens)' })
    const environment = screen.getByRole('spinbutton', { name: 'Environment fact retention (days)' })
    const convention = screen.getByRole('spinbutton', { name: 'Project convention retention (days)' })
    const troubleshooting = screen.getByRole('spinbutton', { name: 'Troubleshooting retention (days)' })
    const preference = screen.getByRole('spinbutton', { name: 'Preference retention (days)' })
    const decision = screen.getByRole('spinbutton', { name: 'Long-term decision retention (days)' })
    expect((review as HTMLInputElement).value).toBe('15')
    expect((idle as HTMLInputElement).value).toBe('60')
    expect((dirty as HTMLInputElement).value).toBe('20')
    expect((globalDirty as HTMLInputElement).value).toBe('7')
    expect((snapshotBudget as HTMLInputElement).value).toBe('1200')
    expect((environment as HTMLInputElement).value).toBe('30')
    expect((convention as HTMLInputElement).value).toBe('180')
    expect((troubleshooting as HTMLInputElement).value).toBe('180')
    expect((preference as HTMLInputElement).value).toBe('0')
    expect((decision as HTMLInputElement).value).toBe('0')

    fireEvent.change(review, { target: { value: '4' } })
    fireEvent.change(idle, { target: { value: '2.5' } })
    fireEvent.change(dirty, { target: { value: '8' } })
    fireEvent.change(globalDirty, { target: { value: '3' } })
    fireEvent.change(snapshotBudget, { target: { value: '800' } })
    fireEvent.change(environment, { target: { value: '45' } })
    fireEvent.change(convention, { target: { value: '90' } })
    fireEvent.change(troubleshooting, { target: { value: '120' } })
    fireEvent.change(preference, { target: { value: '365' } })
    fireEvent.change(decision, { target: { value: '730' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(await screen.findByText('Settings saved.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'updateSettings')?.payload).toEqual({
      reviewEveryUserTurns: 4,
      idleDelayMinutes: 2.5,
      consolidationCooldownHours: 8,
      globalConsolidationCooldownDays: 3,
      snapshotTokenBudget: 800,
      retentionDays: {
        'environment-fact': 45,
        'project-convention': 90,
        troubleshooting: 120,
        preference: 365,
        'long-term-decision': 730,
      },
    })
  })
})

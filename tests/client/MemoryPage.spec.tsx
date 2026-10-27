// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryPage } from '../../client/src/MemoryPage.js'
import { MemoryClientStore } from '../../client/src/store.js'
import type { WorkspaceId } from '../../src/store/types.js'
import { ENTRY, FakeRpc, memoryIndex, sessionState, t, WORKSPACE_SCOPE } from './fixtures.js'

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
    .on('listWorkspaces', () => [
      { id: 'workspace-1' as WorkspaceId, title: 'First project' },
      { id: 'workspace-2' as WorkspaceId, title: 'Second project' },
    ])
    .on('getSettings', () => ({
      reviewEveryUserTurns: 15,
      idleDelayMinutes: 60,
      consolidationCooldownHours: 20,
      snapshotTokenBudget: 1_200,
      retentionDays: DEFAULT_RETENTION_DAYS,
    }))
    .on('updateSettings', settings => settings)
}

describe('MemoryPage', () => {
  it('shows three tabs, Host counts, references, latest snapshot, and estimated session tokens', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    expect(screen.getByRole('tab', { name: 'Global memory index' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Workspaces' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('false')
    expect(await screen.findByText('1 active memory')).toBeTruthy()
    expect(screen.getByText('Estimated injected tokens: 20')).toBeTruthy()
    expect(screen.getByText('Latest snapshot: revision 2')).toBeTruthy()
    expect(screen.getByText('Use pnpm workspaces')).toBeTruthy()
    expect(screen.getByText('Project convention')).toBeTruthy()
    expect(screen.getByText('Sources: session-1 (events 3, 4)')).toBeTruthy()
    expect(screen.getByText('Workspace references')).toBeTruthy()
    expect(screen.getByText('3 entries · revision 7')).toBeTruthy()
    expect(screen.queryByText(/provider exact usage/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Workspaces' }))
    expect(screen.getByRole('tab', { name: 'Workspaces' }).getAttribute('aria-selected')).toBe('true')
    const select = await screen.findByRole('combobox', { name: 'Workspace' })
    expect((select as HTMLSelectElement).value).toBe('workspace-1')
    expect(screen.getByRole('option', { name: 'Second project' })).toBeTruthy()
    expect(await screen.findByText('1 active memory')).toBeTruthy()

    fireEvent.change(select, { target: { value: 'workspace-2' } })
    await waitFor(() => expect(rpc.calls.some(call => call.method === 'list'
      && JSON.stringify(call.payload).includes('workspace-2'))).toBe(true))
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

  it('reads global aggregate details from their source workspace without offering deletion', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    expect(await screen.findByRole('dialog', { name: 'Use pnpm workspaces' })).toBeTruthy()
    expect(screen.getByText(ENTRY.detail)).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'read')?.payload).toEqual({ scope: WORKSPACE_SCOPE, id: ENTRY.id })
    expect(screen.queryByRole('button', { name: 'Delete memory' })).toBeNull()
    expect(rpc.count('remove')).toBe(0)
  })

  it('requires confirmation before deleting a workspace memory only', async () => {
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

    expect(await screen.findByText('Estimated injected tokens: 0')).toBeTruthy()
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
    const snapshotBudget = screen.getByRole('spinbutton', { name: 'Snapshot token budget (estimated tokens)' })
    const environment = screen.getByRole('spinbutton', { name: 'Environment fact retention (days)' })
    const convention = screen.getByRole('spinbutton', { name: 'Project convention retention (days)' })
    const troubleshooting = screen.getByRole('spinbutton', { name: 'Troubleshooting retention (days)' })
    const preference = screen.getByRole('spinbutton', { name: 'Preference retention (days)' })
    const decision = screen.getByRole('spinbutton', { name: 'Long-term decision retention (days)' })
    expect((review as HTMLInputElement).value).toBe('15')
    expect((idle as HTMLInputElement).value).toBe('60')
    expect((dirty as HTMLInputElement).value).toBe('20')
    expect((snapshotBudget as HTMLInputElement).value).toBe('1200')
    expect((environment as HTMLInputElement).value).toBe('30')
    expect((convention as HTMLInputElement).value).toBe('180')
    expect((troubleshooting as HTMLInputElement).value).toBe('180')
    expect((preference as HTMLInputElement).value).toBe('0')
    expect((decision as HTMLInputElement).value).toBe('0')

    fireEvent.change(review, { target: { value: '4' } })
    fireEvent.change(idle, { target: { value: '2.5' } })
    fireEvent.change(dirty, { target: { value: '8' } })
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

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryPage } from '../../client/src/MemoryPage.js'
import { MemoryClientStore } from '../../client/src/store.js'
import { ENTRY, FakeRpc, GLOBAL_SCOPE, memoryIndex, sessionState, t, WORKSPACE_SCOPE } from './fixtures.js'

afterEach(cleanup)

function readyRpc() {
  return new FakeRpc()
    .on('getSessionState', () => sessionState('session-1', true))
    .on('list', ({ scope }) => memoryIndex(scope))
    .on('read', () => ENTRY)
    .on('remove', () => ({ removed: true }))
}

describe('MemoryPage', () => {
  it('shows both tabs, Host counts, references, latest snapshot, and estimated session tokens', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    expect(screen.getByRole('tab', { name: 'Global memory index' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Current workspace index' }).getAttribute('aria-selected')).toBe('false')
    expect(await screen.findByText('1 active memory')).toBeTruthy()
    expect(screen.getByText('Estimated injected tokens: 20')).toBeTruthy()
    expect(screen.getByText('Latest snapshot: revision 2')).toBeTruthy()
    expect(screen.getByText('Use pnpm workspaces')).toBeTruthy()
    expect(screen.getByText('Project convention')).toBeTruthy()
    expect(screen.getByText('Sources: session-1 (events 3, 4)')).toBeTruthy()
    expect(screen.getByText('Workspace references')).toBeTruthy()
    expect(screen.getByText('3 entries · revision 7')).toBeTruthy()
    expect(screen.queryByText(/provider exact usage/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Current workspace index' }))
    expect(screen.getByRole('tab', { name: 'Current workspace index' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText('1 active memory')).toBeTruthy()
    expect(rpc.calls.some(call => call.method === 'list' && JSON.stringify(call.payload).includes('workspace-1'))).toBe(true)
  })

  it('shows a workspace empty state without querying an Ungrouped workspace', async () => {
    const base = sessionState()
    const rpc = new FakeRpc()
      .on('getSessionState', () => ({ sessionId: base.sessionId, layers: base.layers }))
      .on('list', () => memoryIndex())
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Current workspace index' }))
    expect(await screen.findByText('No current workspace. Workspace memory is unavailable for an Ungrouped session.')).toBeTruthy()
    expect(rpc.calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('loads detail and requires confirmation before deleting only the memory entry', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: 'View details for Use pnpm workspaces' }))
    expect(await screen.findByRole('dialog', { name: 'Use pnpm workspaces' })).toBeTruthy()
    expect(screen.getByText(ENTRY.detail)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }))
    expect(screen.getByText('Delete this memory? Conversation history and already injected snapshots will be kept.')).toBeTruthy()
    expect(rpc.count('remove')).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(await screen.findByText('Memory deleted. Conversation history was not deleted; injected snapshots remain.')).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'remove')?.payload).toEqual({ scope: GLOBAL_SCOPE, id: ENTRY.id })
    await waitFor(() => expect(rpc.count('list')).toBeGreaterThanOrEqual(3))
    expect(rpc.calls.every(call => !String(call.method).toLowerCase().includes('sessiondelete'))).toBe(true)
  })

  it('can cancel deletion without calling the Host mutation', async () => {
    const rpc = readyRpc()
    const store = new MemoryClientStore(rpc)
    render(<MemoryPage sessionId="session-1" store={store} t={t} />)
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
})

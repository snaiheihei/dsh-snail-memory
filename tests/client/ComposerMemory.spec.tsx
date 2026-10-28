// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerMemory } from '../../client/src/ComposerMemory.js'
import { MemoryClientStore } from '../../client/src/store.js'
import { deferred, FakeRpc, sessionState, t, WORKSPACE } from './fixtures.js'

afterEach(cleanup)

function registeredWorkspaces() {
  return [
    { id: WORKSPACE, title: 'Current project' },
    { id: 'workspace-2' as typeof WORKSPACE, title: 'Other project' },
  ]
}

describe('ComposerMemory', () => {
  it('uses one compact trigger and a three-row popup backed by the workspace registry', async () => {
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState())
      .on('listWorkspaces', () => registeredWorkspaces())
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)

    expect(screen.queryByRole('radio')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Memory' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Memory' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByRole('group', { name: 'Global memory' })).toBeTruthy()
    expect(within(dialog).getByRole('group', { name: 'Workspace memory' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', true)
    const select = await within(dialog).findByRole('combobox', { name: 'Workspaces' })
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Current project', 'Other project'])
    expect(select).toHaveProperty('value', WORKSPACE)
  })

  it('enables and disables global memory from its capsule while restoring Host state', async () => {
    let selected: 'disabled' | 'global' | 'workspace' = 'disabled'
    const rpc = new FakeRpc()
      .on('getSessionState', () => {
        const state = sessionState('session-1', selected === 'global')
        return { ...state, layers: { ...state.layers, workspace: { ...state.layers.workspace, enabled: selected === 'workspace' } } }
      })
      .on('listWorkspaces', () => registeredWorkspaces())
      .on('enable', ({ layer }) => { selected = layer; return { status: 'enabled' as const } })
      .on('disable', () => { selected = 'disabled'; return { status: 'disabled' as const } })
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const row = screen.getByRole('group', { name: 'Global memory' })
    const enable = await within(row).findByRole('button', { name: 'Enable' })
    await waitFor(() => expect(enable).toHaveProperty('disabled', false))

    fireEvent.click(enable)
    expect((await within(row).findByRole('button', { name: 'Enabled' })).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(row).getByRole('button', { name: 'Enabled' }))
    await within(row).findByRole('button', { name: 'Enable' })
    expect(rpc.calls.filter(call => call.method === 'enable').map(call => call.payload)).toEqual([
      { sessionId: 'session-1', layer: 'global' },
    ])
    expect(rpc.count('disable')).toBe(1)
    expect(localStorage.length).toBe(0)
  })

  it('deduplicates enable gestures and keeps busy feedback in the target row', async () => {
    const operation = deferred<{ status: 'enabled' }>()
    let enabled = false
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState('session-1', enabled))
      .on('listWorkspaces', () => registeredWorkspaces())
      .on('enable', () => { enabled = true; return operation.promise })
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const row = screen.getByRole('group', { name: 'Global memory' })
    const enable = await within(row).findByRole('button', { name: 'Enable' })
    await waitFor(() => expect(enable).toHaveProperty('disabled', false))

    fireEvent.click(enable)
    fireEvent.click(enable)
    expect(rpc.count('enable')).toBe(1)
    expect(within(row).getByText('Enabling global memory…')).toBeTruthy()
    operation.resolve({ status: 'enabled' })
    expect(await within(row).findByRole('button', { name: 'Enabled' })).toBeTruthy()
    expect(rpc.count('getSessionState')).toBeGreaterThanOrEqual(2)
  })

  it('selects registered workspaces but only enables the current Session workspace', async () => {
    let workspaceEnabled = false
    const rpc = new FakeRpc()
      .on('getSessionState', () => {
        const state = sessionState()
        return { ...state, layers: { ...state.layers, workspace: { ...state.layers.workspace, enabled: workspaceEnabled } } }
      })
      .on('listWorkspaces', () => registeredWorkspaces())
      .on('enable', () => { workspaceEnabled = true; return { status: 'enabled' as const } })
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const row = screen.getByRole('group', { name: 'Workspace memory' })
    const select = await within(row).findByRole('combobox', { name: 'Workspaces' })
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', false))

    fireEvent.change(select, { target: { value: 'workspace-2' } })
    expect(select).toHaveProperty('value', 'workspace-2')
    expect(within(row).getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', true)
    expect(within(row).getByText('Select the current Session workspace to enable it.')).toBeTruthy()
    fireEvent.change(select, { target: { value: WORKSPACE } })
    fireEvent.click(within(row).getByRole('button', { name: 'Enable' }))
    expect(await within(row).findByRole('button', { name: 'Enabled' })).toBeTruthy()
    expect(rpc.calls.find(call => call.method === 'enable')?.payload).toEqual({ sessionId: 'session-1', layer: 'workspace' })
  })

  it('refreshes only the enabled layer and reports up-to-date without claiming a commit', async () => {
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState('session-1', true))
      .on('listWorkspaces', () => registeredWorkspaces())
      .on('refresh', () => ({ status: 'up-to-date' as const }))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const refresh = await screen.findByRole('button', { name: 'Refresh' })
    await waitFor(() => expect(refresh).toHaveProperty('disabled', false))

    fireEvent.click(refresh)
    expect(await screen.findByText('Global memory is already up to date.')).toBeTruthy()
    expect(screen.queryByText(/committed/i)).toBeNull()
    expect(rpc.calls.find(call => call.method === 'refresh')?.payload).toEqual({ sessionId: 'session-1', layer: 'global' })
  })

  it('shows queued and error feedback in the affected row', async () => {
    const base = sessionState('session-1', true)
    const state = { ...base, layers: { ...base.layers, global: { ...base.layers.global, pending: 2 } } }
    const rpc = new FakeRpc()
      .on('getSessionState', () => state)
      .on('listWorkspaces', () => registeredWorkspaces())
      .on('refresh', () => Promise.reject(new Error('Host unavailable')))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const globalRow = screen.getByRole('group', { name: 'Global memory' })

    expect(await within(globalRow).findByText('2 global snapshots queued')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Host unavailable')
  })

  it('explains Ungrouped, empty registry, loading, and registry failures without a separate notice panel', async () => {
    const base = sessionState()
    const ungrouped = { sessionId: base.sessionId, layers: base.layers }
    const rpc = new FakeRpc()
      .on('getSessionState', () => ungrouped)
      .on('listWorkspaces', () => Promise.reject(new Error('Registry unavailable')))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    const row = screen.getByRole('group', { name: 'Workspace memory' })

    expect(await within(row).findByText('Workspace memory is unavailable for an Ungrouped session.')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', true)
    expect((await within(row).findByRole('alert')).textContent).toContain('Registry unavailable')
    expect(screen.queryByRole('button', { name: 'Refresh workspace memory' })).toBeNull()
  })

  it('closes on Escape and outside click and restores trigger focus', async () => {
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState())
      .on('listWorkspaces', () => registeredWorkspaces())
    const store = new MemoryClientStore(rpc)
    render(<><button type="button">Outside</button><ComposerMemory sessionId="session-1" store={store} t={t} /></>)
    const trigger = screen.getByRole('button', { name: 'Memory' })
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: 'Memory' })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Memory' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: 'Memory' })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog', { name: 'Memory' })).toBeNull()
  })

  it('does not let an old session response overwrite the newly selected session', async () => {
    const oldResponse = deferred<ReturnType<typeof sessionState>>()
    const newResponse = deferred<ReturnType<typeof sessionState>>()
    const rpc = new FakeRpc()
      .on('getSessionState', ({ sessionId }) => sessionId === 'old' ? oldResponse.promise : newResponse.promise)
      .on('listWorkspaces', () => registeredWorkspaces())
    const store = new MemoryClientStore(rpc)
    const view = render(<ComposerMemory sessionId="old" store={store} t={t} />)
    view.rerender(<ComposerMemory sessionId="new" store={store} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))
    newResponse.resolve(sessionState('new', true))
    expect(await screen.findByRole('button', { name: 'Enabled' })).toBeTruthy()
    oldResponse.resolve(sessionState('old', false))
    await Promise.resolve()

    expect(screen.getByRole('button', { name: 'Enabled' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false)
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerMemory } from '../../client/src/ComposerMemory.js'
import { MemoryClientStore } from '../../client/src/store.js'
import { deferred, FakeRpc, sessionState, t } from './fixtures.js'

afterEach(cleanup)

describe('ComposerMemory', () => {
  it('offers disabled, workspace, and global as one Host-backed selection', async () => {
    let selected: 'disabled' | 'global' | 'workspace' = 'disabled'
    const rpc = new FakeRpc()
      .on('getSessionState', () => {
        const state = sessionState('session-1', selected === 'global')
        return { ...state, layers: { ...state.layers, workspace: { ...state.layers.workspace, enabled: selected === 'workspace' } } }
      })
      .on('enable', ({ layer }) => { selected = layer; return { status: 'enabled' as const } })
      .on('disable', () => { selected = 'disabled'; return { status: 'disabled' as const } })
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)

    const global = await screen.findByRole('radio', { name: 'Enable global memory' })
    fireEvent.click(global)
    await waitFor(() => expect(global).toHaveProperty('checked', true))
    fireEvent.click(screen.getByRole('radio', { name: 'Enable workspace memory' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Enable workspace memory' })).toHaveProperty('checked', true))
    fireEvent.click(screen.getByRole('radio', { name: 'Disable memory' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Disable memory' })).toHaveProperty('checked', true))
    expect(rpc.calls.filter(call => call.method === 'enable').map(call => call.payload)).toEqual([
      { sessionId: 'session-1', layer: 'global' },
      { sessionId: 'session-1', layer: 'workspace' },
    ])
    expect(rpc.count('disable')).toBe(1)
  })

  it('starts disabled and restores the Host-selected radio without local persistence', async () => {
    const rpc = new FakeRpc().on('getSessionState', () => sessionState('session-1', true))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)

    expect(screen.getByRole('radio', { name: 'Enable global memory' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: 'Disable memory' })).toHaveProperty('checked', true)
    expect(await screen.findByRole('radio', { name: 'Enable global memory', checked: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh global memory' })).toHaveProperty('disabled', false)
    expect(localStorage.length).toBe(0)
  })

  it('deduplicates repeated enable gestures and refreshes Host state afterward', async () => {
    const operation = deferred<{ status: 'enabled' }>()
    let enabled = false
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState('session-1', enabled))
      .on('enable', () => { enabled = true; return operation.promise })
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    const enable = await screen.findByRole('radio', { name: 'Enable global memory' })
    await waitFor(() => expect(enable).toHaveProperty('disabled', false))

    fireEvent.click(enable)
    fireEvent.click(enable)
    expect(rpc.count('enable')).toBe(1)
    expect(screen.getByText('Enabling global memory…')).toBeTruthy()
    operation.resolve({ status: 'enabled' })
    expect(await screen.findByRole('radio', { name: 'Enable global memory', checked: true })).toBeTruthy()
    expect(rpc.count('getSessionState')).toBeGreaterThanOrEqual(2)
  })

  it('allows refresh only after enable and reports an unchanged revision', async () => {
    const rpc = new FakeRpc()
      .on('getSessionState', () => sessionState('session-1', true))
      .on('refresh', () => ({ status: 'up-to-date' as const }))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)
    const refresh = await screen.findByRole('button', { name: 'Refresh global memory' })
    await waitFor(() => expect(refresh).toHaveProperty('disabled', false))

    fireEvent.click(refresh)
    expect(await screen.findByText('Global memory is already up to date.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Enable global memory' })).toHaveProperty('checked', true)
  })

  it('explains Ungrouped workspace state and exposes queued and error feedback', async () => {
    const base = sessionState()
    const ungrouped = { sessionId: base.sessionId, layers: base.layers }
    const rpc = new FakeRpc()
      .on('getSessionState', () => ungrouped)
      .on('enable', () => Promise.reject(new Error('Host unavailable')))
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)

    expect(await screen.findByText('Workspace memory is unavailable for an Ungrouped session.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Enable workspace memory' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Refresh workspace memory' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Enable global memory' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Host unavailable')
  })

  it('shows queued snapshot feedback from Host state', async () => {
    const base = sessionState('session-1', true)
    const state = { ...base, layers: { ...base.layers, global: { ...base.layers.global, pending: 2 } } }
    const rpc = new FakeRpc().on('getSessionState', () => state)
    const store = new MemoryClientStore(rpc)
    render(<ComposerMemory sessionId="session-1" store={store} t={t} />)

    expect(await screen.findByText('2 global snapshots queued')).toBeTruthy()
  })

  it('does not let an old session response overwrite the newly selected session', async () => {
    const oldResponse = deferred<ReturnType<typeof sessionState>>()
    const newResponse = deferred<ReturnType<typeof sessionState>>()
    const rpc = new FakeRpc().on('getSessionState', ({ sessionId }) => sessionId === 'old' ? oldResponse.promise : newResponse.promise)
    const store = new MemoryClientStore(rpc)
    const view = render(<ComposerMemory sessionId="old" store={store} t={t} />)
    view.rerender(<ComposerMemory sessionId="new" store={store} t={t} />)
    newResponse.resolve(sessionState('new', true))
    expect(await screen.findByRole('radio', { name: 'Enable global memory', checked: true })).toBeTruthy()
    oldResponse.resolve(sessionState('old', false))
    await Promise.resolve()

    expect(screen.getByRole('radio', { name: 'Enable global memory' })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: 'Enable workspace memory' })).toHaveProperty('checked', false)
  })
})

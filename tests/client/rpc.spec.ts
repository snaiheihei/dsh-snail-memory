import { describe, expect, it, vi } from 'vitest'
import { createMemoryRpc, MemoryRpcError } from '../../client/src/rpc.js'
import { sessionState } from './fixtures.js'

describe('memory RPC', () => {
  it('posts typed JSON to the method route with the protocol header', async () => {
    const state = sessionState()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, value: state }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const rpc = createMemoryRpc(fetcher)

    await expect(rpc.call('getSessionState', { sessionId: 'session-1' })).resolves.toEqual(state)
    expect(fetcher).toHaveBeenCalledWith('/snail-memory/rpc/getSessionState', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-snail-memory': '1' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
  })

  it('surfaces safe Host errors even when the HTTP status is not 200', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: 'memory-not-found', message: 'The memory entry does not exist.' },
    }), { status: 404, headers: { 'content-type': 'application/json' } }))
    const rpc = createMemoryRpc(fetcher)

    const failure = await rpc.call('remove', { scope: { kind: 'global' }, id: 'missing' as never }).catch(error => error)
    expect(failure).toBeInstanceOf(MemoryRpcError)
    expect(failure).toMatchObject({ code: 'memory-not-found', status: 404 })
  })

  it('rejects malformed success envelopes instead of treating them as Host state', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ value: {} }), { status: 200 }))
    const rpc = createMemoryRpc(fetcher)

    await expect(rpc.call('list', { scope: { kind: 'global' } })).rejects.toMatchObject({ code: 'invalid-response' })
  })
})

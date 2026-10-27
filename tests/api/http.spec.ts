import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createRpcHandler, type RpcDispatcher, type RpcRequest, type RpcResponse } from '../../src/api/http.js'
import type { RpcMethod, RpcPayload } from '../../src/contract.js'

function setup(call: (method: RpcMethod, payload: RpcPayload) => Promise<unknown> = async () => ({ entries: [] })) {
  const handler = createRpcHandler({ call } as unknown as RpcDispatcher, { maxBodyBytes: 128 })
  return { handler, call }
}

async function request(
  handler: (req: RpcRequest, res: RpcResponse) => Promise<void>,
  options: {
    method?: string
    url?: string
    headers?: Record<string, string>
    body?: string
  } = {},
) {
  const body = options.body ?? JSON.stringify({ scope: { kind: 'global' } })
  const req = Readable.from([body]) as unknown as RpcRequest
  req.method = options.method ?? 'POST'
  req.url = options.url ?? '/snail-memory/rpc/list'
  req.headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-snail-memory': '1',
    ...options.headers,
  }
  let responseBody = ''
  const res: RpcResponse & { headers: Record<string, string> } = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(chunk?: string) { responseBody += chunk ?? '' },
  }
  await handler(req, res)
  return { status: res.statusCode, body: responseBody ? JSON.parse(responseBody) as Record<string, unknown> : undefined }
}

describe('Snail Memory HTTP RPC', () => {
  it('dispatches a whitelisted POST method and returns its result envelope', async () => {
    const { handler } = setup(async (method, payload) => ({ method, payload }))
    const response = await request(handler)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, value: { method: 'list' } })
  })

  it('rejects unknown methods and non-POST transport without entering the controller', async () => {
    let calls = 0
    const { handler } = setup(async () => { calls += 1; return {} })

    expect((await request(handler, { url: '/snail-memory/rpc/dropSession' })).status).toBe(404)
    expect((await request(handler, { method: 'GET' })).status).toBe(405)
    expect(calls).toBe(0)
  })

  it('requires JSON and the custom same-origin header', async () => {
    const { handler } = setup()

    expect((await request(handler, { headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await request(handler, { headers: { 'x-snail-memory': '' } })).status).toBe(403)
  })

  it('bounds the request body and rejects malformed JSON', async () => {
    const { handler } = setup()

    expect((await request(handler, { body: 'x'.repeat(129) })).status).toBe(413)
    expect((await request(handler, { body: '{' })).status).toBe(400)
  })

  it('validates payload shape before dispatch and returns no stack or internal path', async () => {
    let calls = 0
    const { handler } = setup(async () => { calls += 1; throw new Error('C:\\private\\state.v1.json exploded') })

    const invalid = await request(handler, { url: '/snail-memory/rpc/enable', body: JSON.stringify({ sessionId: '', layer: 'other' }) })
    expect(invalid.status).toBe(400)
    expect(invalid.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(calls).toBe(0)

    const failure = await request(handler)
    expect(failure.status).toBe(500)
    expect(JSON.stringify(failure.body)).not.toContain('private')
    expect(JSON.stringify(failure.body)).not.toContain('exploded')
  })
})

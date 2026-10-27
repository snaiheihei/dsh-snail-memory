import { RPC_METHODS, RPC_ROUTE_PREFIX, type RpcMethod, type RpcPayload, type RpcResult, type RpcValue } from '../contract.js'
import { MemoryApiError, safeError } from './errors.js'
import { validatePayload } from './validate.js'

export interface RpcDispatcher {
  call(method: RpcMethod, payload: RpcPayload): Promise<RpcValue>
}
export interface RpcRequest extends AsyncIterable<Uint8Array | string> {
  method?: string | undefined
  url?: string | undefined
  headers: Record<string, string | string[] | undefined>
}
export interface RpcResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(chunk?: string): void
}

function write(res: RpcResponse, status: number, result: RpcResult<unknown>): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(result))
}

async function body(req: RpcRequest, max: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > max) throw new MemoryApiError('body-too-large', 'Request body is too large.', 413)
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createRpcHandler(dispatcher: RpcDispatcher, options: { maxBodyBytes?: number } = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 65_536
  return async function handleRpc(req: RpcRequest, res: RpcResponse): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', 'http://snail-memory.local').pathname
      const methodName = pathname.startsWith(`${RPC_ROUTE_PREFIX}/`) ? pathname.slice(RPC_ROUTE_PREFIX.length + 1) : ''
      if (!(RPC_METHODS as readonly string[]).includes(methodName)) throw new MemoryApiError('not-found', 'Unknown Snail Memory RPC method.', 404)
      if (req.method !== 'POST') throw new MemoryApiError('method-not-allowed', 'Only POST is supported.', 405)
      const contentType = Array.isArray(req.headers['content-type']) ? req.headers['content-type'][0] : req.headers['content-type']
      if (!contentType?.toLowerCase().startsWith('application/json')) throw new MemoryApiError('unsupported-media-type', 'Expected application/json.', 415)
      if (req.headers['x-snail-memory'] !== '1') throw new MemoryApiError('forbidden', 'Missing Snail Memory request header.', 403)
      const raw = await body(req, maxBodyBytes)
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { throw new MemoryApiError('invalid-request', 'Malformed JSON request.') }
      const method = methodName as RpcMethod
      const value = await dispatcher.call(method, validatePayload(method, payload))
      write(res, 200, { ok: true, value })
    } catch (error) {
      const safe = safeError(error)
      write(res, safe.status, { ok: false, error: { code: safe.code, message: safe.message } })
    }
  }
}

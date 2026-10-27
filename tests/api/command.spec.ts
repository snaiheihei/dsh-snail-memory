import { describe, expect, it } from 'vitest'
import { executeMemoryCommand } from '../../src/api/command.js'
import type { MemoryController } from '../../src/api/controller.js'
import type { RpcMethod, RpcPayload } from '../../src/contract.js'

function controller(call: (method: RpcMethod, payload: RpcPayload) => Promise<unknown>, attached = true): MemoryController {
  return { call, workspaceForSession: () => attached ? 'workspace-1' : undefined } as unknown as MemoryController
}

describe('/memory command', () => {
  it('uses one controller for remember, correct, forget, and status', async () => {
    const calls: unknown[] = []
    const service = controller(async (method, payload) => {
      calls.push([method, payload])
      if (method === 'read') return { id: 'memory-1', category: 'preference' }
      if (method === 'status') return { writable: true, dirty: false }
      if (method === 'remove') return { removed: true }
      return { id: 'memory-1', summary: 'saved' }
    })

    await expect(executeMemoryCommand(service, ' remember workspace Prefer concise answers', 'session-1')).resolves.toMatchObject({ kind: 'success' })
    await expect(executeMemoryCommand(service, ' correct workspace memory-1 Prefer examples', 'session-1')).resolves.toMatchObject({ kind: 'success' })
    await expect(executeMemoryCommand(service, ' forget workspace memory-1', 'session-1')).resolves.toMatchObject({ kind: 'success' })
    await expect(executeMemoryCommand(service, ' status', 'session-1')).resolves.toMatchObject({ kind: 'success' })

    const scope = { kind: 'workspace', workspaceId: 'workspace-1' }
    expect(calls).toEqual([
      ['remember', expect.objectContaining({ scope, category: 'project-convention', summary: 'Prefer concise answers', sessionId: 'session-1' })],
      ['read', { scope, id: 'memory-1' }],
      ['correct', expect.objectContaining({ id: 'memory-1', scope, category: 'preference', summary: 'Prefer examples', sessionId: 'session-1' })],
      ['remove', { scope, id: 'memory-1' }],
      ['status', {}],
    ])
  })

  it('requires an attached workspace for workspace writes', async () => {
    const service = controller(async () => ({}), false)
    const result = await executeMemoryCommand(service, ' remember workspace Use pnpm', 'session-1')

    expect(result).toMatchObject({ kind: 'error', text: expect.stringMatching(/workspace/i) })
  })

  it('rejects independent global mutations without calling the service', async () => {
    let calls = 0
    const service = controller(async () => { calls += 1; return {} })

    for (const input of ['remember global Prefer concise answers', 'correct global memory-1 Prefer examples', 'forget global memory-1']) {
      expect(await executeMemoryCommand(service, input, 'session-1')).toMatchObject({ kind: 'error', text: expect.stringMatching(/read-only aggregate/i) })
    }
    expect(calls).toBe(0)
  })

  it('returns usage for malformed grammar without calling the service', async () => {
    let calls = 0
    const service = controller(async () => { calls += 1; return {} })

    expect(await executeMemoryCommand(service, ' forget global', 'session-1')).toMatchObject({ kind: 'error', text: expect.stringMatching(/Usage/) })
    expect(await executeMemoryCommand(service, ' unknown', 'session-1')).toMatchObject({ kind: 'error' })
    expect(calls).toBe(0)
  })

  it('turns business failures into a safe command error', async () => {
    const service = controller(async () => { throw Object.assign(new Error('secret path must not leak'), { code: 'read-only' }) })
    const result = await executeMemoryCommand(service, ' status', 'session-1')

    expect(result).toEqual({ kind: 'error', text: 'Snail Memory is read-only on this host.' })
  })
})

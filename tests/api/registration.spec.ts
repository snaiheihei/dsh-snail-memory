import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { registerMemoryApi } from '../../src/api/index.js'
import type { MemoryController } from '../../src/api/controller.js'

describe('memory API registration', () => {
  it('registers one prefix route and one command, then disposes both', async () => {
    let route: WebRoute | undefined
    let command: CommandDefinition | undefined
    let routeDisposed = 0
    let commandDisposed = 0
    const controller = { call: async () => ({ writable: true, workspaceConsolidation: {} }) } as unknown as MemoryController
    const ctx = {
      webServer: {
        register(value: WebRoute) { route = value; return () => { routeDisposed += 1 } },
      },
      commands: {
        register(value: CommandDefinition) { command = value; return () => { commandDisposed += 1 } },
      },
    } as unknown as Context

    const dispose = registerMemoryApi(ctx, controller)
    expect(route).toMatchObject({ kind: 'prefix', path: '/snail-memory/rpc' })
    expect(command).toMatchObject({ name: 'memory', recordInput: false })
    const invocation = { rawInput: ' status', agent: { session: { id: 'session-1' } } } as CommandInvocation
    await expect(command!.handler(invocation)).resolves.toMatchObject({ kind: 'success' })

    dispose()
    dispose()
    expect(routeDisposed).toBe(1)
    expect(commandDisposed).toBe(1)
  })
})

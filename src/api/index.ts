import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RPC_ROUTE_PREFIX } from '../contract.js'
import type { MemoryController } from './controller.js'
import { executeMemoryCommand } from './command.js'
import { createRpcHandler } from './http.js'

export function registerMemoryApi(ctx: Context, controller: MemoryController): () => void {
  const handler = createRpcHandler(controller)
  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: RPC_ROUTE_PREFIX, handler })
  const disposeCommand = ctx.commands.register({
    name: 'memory',
    description: 'Remember, correct, forget, or inspect Snail Memory',
    input: { hint: 'status | remember <global|workspace> <text> | correct <global|workspace> <id> <text> | forget <global|workspace> <id>' },
    recordInput: false,
    handler: invocation => executeMemoryCommand(controller, invocation.rawInput, invocation.agent.session.id),
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeCommand()
    disposeRoute()
  }
}

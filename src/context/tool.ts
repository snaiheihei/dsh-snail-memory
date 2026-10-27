import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryId, type MemoryLayer } from '../store/types.js'
import type { MemoryContextService } from './service.js'

export function registerMemoryReadTool(ctx: Context, memories: MemoryContextService): () => void {
  return ctx.tools.register(defineTool({
    name: 'snail_memory_read',
    description: 'Read one Snail Memory detail by id. The target layer must already be enabled for this Session.',
    parameters: {
      layer: { type: 'string', required: true, enum: ['global', 'workspace'], description: 'Enabled memory layer.' },
      memory_id: { type: 'string', required: true, description: 'Memory id from the injected index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          summary: { type: 'string' },
          detail: { type: 'string' },
          lastVerifiedAt: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `${value.summary ?? ''}\nLast verified: ${value.lastVerifiedAt ?? ''}\n\n${value.detail ?? ''}`
          : 'Memory not found, forgotten, or not enabled for this Session.',
      }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (!sessionId) return { found: false }
      const entry = memories.readDetail(sessionId, args.layer as MemoryLayer, memoryId(args.memory_id))
      return entry
        ? { found: true, summary: entry.summary, detail: entry.detail, lastVerifiedAt: entry.lastVerifiedAt }
        : { found: false }
    },
  }))
}

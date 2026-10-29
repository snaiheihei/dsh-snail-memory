import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { chunkMemoryDetail } from '../store/chunks.js'
import { memoryId, type MemoryFeedbackOutcome, type MemoryLayer } from '../store/types.js'
import type { MemoryContextService } from './service.js'
import { estimateTokens } from './snapshot.js'

export function createMemoryReadTool(memories: MemoryContextService) {
  return defineTool({
    name: 'snail_memory_read',
    description: 'Read Snail Memory by id. Large memories return a chunk manifest; pass chunk_id to read one chunk. The target layer must already be enabled for this Session.',
    parameters: {
      layer: { type: 'string', required: true, enum: ['global', 'workspace'], description: 'Enabled memory layer.' },
      memory_id: { type: 'string', required: true, description: 'Parent memory id from the injected index.' },
      chunk_id: { type: 'string', description: 'Optional chunk id from a large memory manifest, for example part-001.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          summary: { type: 'string' },
          detail: { type: 'string' },
          chunkId: { type: 'string' },
          lastVerifiedAt: { type: 'string' },
          chunks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                characters: { type: 'integer', required: true },
                estimatedTokens: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `${value.summary ?? ''}\nLast verified: ${value.lastVerifiedAt ?? ''}\n\n${value.chunks
              ? `Chunks (call again with chunk_id):\n${value.chunks.map(chunk => `- ${chunk.id}: ${chunk.characters} characters, ~${chunk.estimatedTokens} tokens`).join('\n')}`
              : value.detail ?? ''}`
          : 'Memory or chunk not found, forgotten, or not enabled for this Session.',
      }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (!sessionId) return { found: false }
      const entry = await memories.readDetail(
        sessionId,
        args.layer as MemoryLayer,
        memoryId(args.memory_id),
      )
      if (!entry) return { found: false }
      const chunks = chunkMemoryDetail(entry.detail)
      if (chunks.length === 0) {
        return args.chunk_id !== undefined
          ? { found: false }
          : { found: true, summary: entry.summary, detail: entry.detail, lastVerifiedAt: entry.lastVerifiedAt }
      }
      if (args.chunk_id !== undefined) {
        const chunk = chunks.find(candidate => candidate.id === args.chunk_id)
        return chunk
          ? { found: true, summary: entry.summary, detail: chunk.text, chunkId: chunk.id, lastVerifiedAt: entry.lastVerifiedAt }
          : { found: false }
      }
      return {
        found: true,
        summary: entry.summary,
        lastVerifiedAt: entry.lastVerifiedAt,
        chunks: chunks.map(chunk => ({
          id: chunk.id,
          index: chunk.index,
          characters: chunk.text.length,
          estimatedTokens: estimateTokens(chunk.text),
        })),
      }
    },
  })
}

export function createMemoryFeedbackTool(memories: MemoryContextService) {
  return defineTool({
    name: 'snail_memory_feedback',
    description: 'Record one usage feedback for a memory from a committed snapshot. Use helpful only when the memory was actually applied; use unhelpful or incorrect for a concrete negative observation. Do not score merely because a snapshot was injected or read.',
    parameters: {
      layer: { type: 'string', required: true, enum: ['global', 'workspace'], description: 'Enabled memory layer containing the committed snapshot.' },
      memory_id: { type: 'string', required: true, description: 'Memory id actually rendered in the committed snapshot.' },
      outcome: { type: 'string', required: true, enum: ['helpful', 'unhelpful', 'incorrect'], description: 'Usage feedback; the plugin maps this to rank +1 or -1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['recorded', 'duplicate', 'disabled', 'not-injected', 'not-found'] },
          rank: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'recorded'
          ? `Feedback recorded. Current rank: ${value.rank ?? 0}.`
          : value.status === 'duplicate'
            ? `Feedback was already recorded for this memory and snapshot. Current rank: ${value.rank ?? 0}.`
            : value.status === 'disabled'
              ? 'The selected memory layer is not enabled for this Session.'
              : value.status === 'not-injected'
                ? 'The memory was not present in a committed snapshot for this Session.'
                : 'Memory not found in the selected layer.',
      }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (!sessionId) return { status: 'disabled' as const }
      return memories.recordFeedback(
        sessionId,
        args.layer as MemoryLayer,
        memoryId(args.memory_id),
        args.outcome as MemoryFeedbackOutcome,
      )
    },
  })
}

export function registerMemoryReadTool(ctx: Context, memories: MemoryContextService): () => void {
  return ctx.tools.register(createMemoryReadTool(memories))
}

export function registerMemoryFeedbackTool(ctx: Context, memories: MemoryContextService): () => void {
  return ctx.tools.register(createMemoryFeedbackTool(memories))
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryReadTool } from '../../src/context/tool.js'
import { MemoryContextService } from '../../src/context/service.js'
import { MemoryStore } from '../../src/store/store.js'

const roots: string[] = []
const stores: MemoryStore[] = []

interface ReadResult {
  readonly found: boolean
  readonly summary?: string
  readonly detail?: string
  readonly chunkId?: string
  readonly chunks?: readonly { readonly id: string; readonly index: number; readonly characters: number; readonly estimatedTokens: number }[]
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-tool-'))
  roots.push(root)
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  const context = new MemoryContextService(store, {})
  const agent = {
    session: { id: 'session-1', snapshotEvents: () => [] },
    inbox: { nextTurn: [], nextStep: [], remove: () => false, replace: () => false },
    inject() {},
  }
  const tool = createMemoryReadTool(context)
  const exec = { agent } as unknown as ToolRunContext
  return { store, context, agent, tool, exec }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('snail_memory_read', () => {
  it('reads an independent global entry by id without a source workspace', async () => {
    const { store, context, agent, tool, exec } = await setup()
    const entry = await store.upsert({
      scope: { kind: 'global' },
      category: 'project-convention', summary: 'Global detail', detail: 'Complete global detail',
      sourceRefs: [], lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await context.enable(agent, 'global')

    expect(await tool.execute({ layer: 'global', memory_id: entry.id }, exec))
      .toMatchObject({ found: true, detail: 'Complete global detail' })
  })

  it('keeps small detail reads compatible and rejects chunk ids for them', async () => {
    const { store, context, agent, tool, exec } = await setup()
    const entry = await store.upsert({
      scope: { kind: 'global' },
      category: 'preference',
      summary: 'Small memory',
      detail: 'Complete small detail',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })
    await context.enable(agent, 'global')

    const result = await tool.execute({ layer: 'global', memory_id: entry.id }, exec) as ReadResult
    const withChunk = await tool.execute({ layer: 'global', memory_id: entry.id, chunk_id: 'part-001' }, exec) as ReadResult
    const withEmptyChunk = await tool.execute({ layer: 'global', memory_id: entry.id, chunk_id: '' }, exec) as ReadResult

    expect(result).toMatchObject({ found: true, detail: 'Complete small detail' })
    expect(withChunk).toEqual({ found: false })
    expect(withEmptyChunk).toEqual({ found: false })
  })

  it('returns only a chunk manifest by default and only the selected chunk on demand', async () => {
    const { store, context, agent, tool, exec } = await setup()
    const detail = `${'a'.repeat(4_000)}${'b'.repeat(4_000)}${'c'.repeat(500)}`
    const entry = await store.upsert({
      scope: { kind: 'global' },
      category: 'long-term-decision',
      summary: 'Large memory',
      detail,
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    expect(await tool.execute({ layer: 'global', memory_id: entry.id }, exec)).toEqual({ found: false })
    await context.enable(agent, 'global')
    const manifest = await tool.execute({ layer: 'global', memory_id: entry.id }, exec) as ReadResult
    const manifestText = tool.output.render(
      { layer: 'global', memory_id: entry.id },
      manifest as unknown as Parameters<typeof tool.output.render>[1],
    ).map(block => block.type === 'text' ? block.text : '').join('\n')

    expect(manifest.found).toBe(true)
    expect(manifest.detail).toBeUndefined()
    expect(manifest.chunks?.map(chunk => chunk.id)).toEqual(['part-001', 'part-002', 'part-003'])
    expect(manifest.chunks?.every(chunk => chunk.characters <= 4_000 && chunk.estimatedTokens > 0)).toBe(true)
    expect(manifestText).toContain('part-001')
    expect(manifestText).not.toContain('a'.repeat(100))

    const selected = await tool.execute({ layer: 'global', memory_id: entry.id, chunk_id: 'part-002' }, exec) as ReadResult
    expect(selected).toMatchObject({ found: true, chunkId: 'part-002', detail: 'b'.repeat(4_000) })
    expect(selected.chunks).toBeUndefined()
    expect(selected.detail).not.toContain('a')
    expect(selected.detail).not.toContain('c')
    expect(await tool.execute({ layer: 'global', memory_id: entry.id, chunk_id: 'part-999' }, exec)).toEqual({ found: false })
  })
})

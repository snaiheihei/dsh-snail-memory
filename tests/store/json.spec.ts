import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState, readState, writeJsonAtomic } from '../../src/store/json.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []

afterEach(async () => {
  vi.mocked(rename).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('writeJsonAtomic', () => {
  it('retries a transient Windows EPERM without losing the new state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-json-'))
    roots.push(root)
    const path = join(root, 'state.v1.json')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('temporarily locked'), { code: 'EPERM' }))

    await writeJsonAtomic(path, { formatVersion: 1, revision: 1 })

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ formatVersion: 1, revision: 1 })
    expect(rename).toHaveBeenCalledTimes(2)
  })
})

describe('readState', () => {
  it('assigns a stable intent ID to legacy pending records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-json-'))
    roots.push(root)
    const path = join(root, 'state.v2.json')
    const state = emptyState()
    const createdAt = '2026-10-26T00:00:00.000Z'
    await writeJsonAtomic(path, {
      ...state,
      meta: {
        ...state.meta,
        pending: { 'review:session-1': { kind: 'review:session-1', createdAt } },
      },
    })

    const restored = await readState(path)

    expect(restored?.meta.pending['review:session-1']).toEqual({
      id: 'legacy:review:session-1:2026-10-26T00:00:00.000Z',
      kind: 'review:session-1',
      createdAt,
    })
  })

  it('conservatively migrates shared dirty state and pending consolidation to every known workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-json-'))
    roots.push(root)
    const path = join(root, 'state.v2.json')
    const state = emptyState()
    state.workspaces = {
      test_only: { createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' },
      dsh_memory: { createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' },
    }
    await writeJsonAtomic(path, {
      ...state,
      meta: {
        ...state.meta,
        dirty: true,
        nextConsolidationAt: '2026-10-26T06:00:00.000Z',
        lastConsolidationAt: '2026-10-25T06:00:00.000Z',
        pending: {
          consolidate: { id: 'legacy-consolidate', kind: 'consolidate', createdAt: '2026-10-26T06:00:00.000Z' },
        },
      },
    })

    const restored = await readState(path)

    expect(restored?.formatVersion).toBe(2)
    expect(restored?.meta.workspaceConsolidation).toEqual({
      test_only: { dirty: true, nextConsolidationAt: '2026-10-26T06:00:00.000Z', lastConsolidationAt: '2026-10-25T06:00:00.000Z' },
      dsh_memory: { dirty: true, nextConsolidationAt: '2026-10-26T06:00:00.000Z', lastConsolidationAt: '2026-10-25T06:00:00.000Z' },
    })
    expect(restored?.meta.pending.consolidate).toBeUndefined()
    expect(restored?.meta.pending['consolidate:test_only']?.kind).toBe('consolidate:test_only')
    expect(restored?.meta.pending['consolidate:dsh_memory']?.kind).toBe('consolidate:dsh_memory')
  })
})

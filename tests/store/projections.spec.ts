import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../src/store/store.js'
import { workspaceId } from '../../src/store/types.js'

const failure = vi.hoisted(() => ({
  partTwo: false,
  detailRecord: false,
  parentState: false,
  indexProjection: false,
  raceDirectory: null as string | null,
  raceCalls: 0,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (failure.partTwo && String(args[0]).endsWith('part-002.md')) throw new Error('injected chunk write failure')
      if (failure.detailRecord && String(args[0]).includes('detail-data')) throw new Error('injected detail record failure')
      if (failure.parentState && String(args[0]).includes('state.v2.json')) throw new Error('injected parent state failure')
      if (failure.indexProjection && String(args[0]).includes(join('global', 'INDEX.md'))) throw new Error('injected index projection failure')
      return actual.writeFile(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (failure.raceDirectory && String(args[0]) === failure.raceDirectory) {
        failure.raceCalls += 1
        if (failure.raceCalls === 1) await new Promise(resolve => setTimeout(resolve, 200))
      }
      return actual.rm(...args)
    },
  }
})

const roots: string[] = []
const stores: MemoryStore[] = []

afterEach(async () => {
  failure.partTwo = false
  failure.detailRecord = false
  failure.parentState = false
  failure.indexProjection = false
  failure.raceDirectory = null
  failure.raceCalls = 0
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('projection and detail publication', () => {
  it('keeps the v1 source when detail migration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-migration-failure-'))
    roots.push(root)
    const timestamp = '2026-10-26T00:00:00.000Z'
    await writeFile(join(root, 'state.v1.json'), JSON.stringify({
      formatVersion: 1,
      revision: 1,
      entries: [{
        id: 'legacy-id', scope: { kind: 'global' }, category: 'project-convention',
        summary: 'Legacy', detail: 'legacy detail', createdAt: timestamp, updatedAt: timestamp,
        lastVerifiedAt: timestamp, revision: 1, sourceRefs: [],
      }],
      workspaces: {}, scopeRevisions: { global: 1, workspaces: {} }, sessions: {},
      meta: {
        dirty: false, nextConsolidationAt: null, nextRetentionAt: null,
        lastConsolidationAt: null, lastRetentionAt: null, lastError: null, pending: {},
      },
    }))
    failure.detailRecord = true

    await expect(MemoryStore.open({ root, heartbeatMs: 60_000 })).rejects.toThrow('injected detail record failure')

    expect(await readFile(join(root, 'state.v1.json'), 'utf8')).toContain('legacy detail')
    await expect(readFile(join(root, 'state.v2.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the previous authoritative revision when writing a new detail record fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-detail-record-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'global' } as const
    const base = {
      scope,
      category: 'project-convention',
      summary: 'Atomic detail record',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    } as const
    const entry = await store.upsert({ ...base, detail: 'old-authoritative-detail' })
    failure.detailRecord = true

    await expect(store.upsert({ ...base, id: entry.id, detail: 'new-authoritative-detail' }))
      .rejects.toThrow('injected detail record failure')

    expect((await store.read(scope, entry.id))?.detail).toBe('old-authoritative-detail')
    const persisted = JSON.parse(await readFile(join(root, 'state.v2.json'), 'utf8'))
    expect(persisted.entries[0].revision).toBe(entry.revision)
    expect(persisted.entries[0].detailChars).toBe('old-authoritative-detail'.length)
  })

  it('restores the committed detail projection when parent state publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-parent-failure-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'global' } as const
    const base = {
      scope,
      category: 'project-convention',
      summary: 'Parent publication',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    } as const
    const entry = await store.upsert({ ...base, detail: 'old-committed-detail' })
    failure.parentState = true

    await expect(store.upsert({ ...base, id: entry.id, detail: 'new-uncommitted-detail' }))
      .rejects.toThrow('injected parent state failure')

    expect((await store.read(scope, entry.id))?.detail).toBe('old-committed-detail')
    expect(await readFile(store.paths.detail(entry.id), 'utf8')).toContain('old-committed-detail')
    expect(await readFile(store.paths.detail(entry.id), 'utf8')).not.toContain('new-uncommitted-detail')
  })

  it('returns the committed result when only the derived index projection fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-index-failure-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    failure.indexProjection = true

    const entry = await store.upsert({
      scope,
      category: 'project-convention',
      summary: 'Committed before index',
      detail: 'authoritative detail',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    })

    expect(entry.summary).toBe('Committed before index')
    expect((await store.read(scope, entry.id))?.detail).toBe('authoritative detail')
    await expect(readFile(store.paths.projectionPending, 'utf8')).resolves.toContain(entry.id)

    await store.close()
    failure.indexProjection = false
    const reopened = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(reopened)
    expect(await readFile(join(root, 'workspaces', 'workspace-1', 'INDEX.md'), 'utf8')).toContain('Committed before index')
    await expect(readFile(reopened.paths.projectionPending, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the previous complete chunk set when publishing a correction fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-projection-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'global' } as const
    const base = {
      scope,
      category: 'project-convention',
      summary: 'Atomic chunks',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    } as const
    const oldDetail = Array.from({ length: 3 }, () => `old-${'a'.repeat(3_996)}`).join('')
    const newDetail = Array.from({ length: 3 }, () => `new-${'b'.repeat(3_996)}`).join('')
    const entry = await store.upsert({ ...base, detail: oldDetail })
    failure.partTwo = true

    await expect(store.upsert({ ...base, id: entry.id, detail: newDetail })).rejects.toThrow('injected chunk write failure')

    const first = await readFile(join(root, 'details', entry.id, 'part-001.md'), 'utf8')
    const third = await readFile(join(root, 'details', entry.id, 'part-003.md'), 'utf8')
    expect(first).toContain('old-')
    expect(first).not.toContain('new-')
    expect(third).toContain('old-')
    expect((await store.read(scope, entry.id))?.detail).toBe(oldDetail)
    const persisted = JSON.parse(await readFile(join(root, 'state.v2.json'), 'utf8'))
    expect(persisted.entries[0].revision).toBe(entry.revision)
  })

  it('keeps the previous small detail when switching to chunks fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-projection-transition-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'global' } as const
    const base = {
      scope,
      category: 'project-convention',
      summary: 'Atomic transition',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    } as const
    const entry = await store.upsert({ ...base, detail: 'old-small-detail' })
    failure.partTwo = true

    await expect(store.upsert({ ...base, id: entry.id, detail: `new-${'b'.repeat(9_000)}` }))
      .rejects.toThrow('injected chunk write failure')

    expect(await readFile(join(root, 'details', `${entry.id}.md`), 'utf8')).toContain('old-small-detail')
  })

  it('serializes deletion cleanup with a same-id recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-projection-race-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    const scope = { kind: 'global' } as const
    const base = {
      scope,
      category: 'project-convention',
      summary: 'Recreated chunks',
      sourceRefs: [{ sessionId: 'session-1' }],
      lastVerifiedAt: '2026-10-26T00:00:00.000Z',
    } as const
    const entry = await store.upsert({ ...base, detail: `old-${'a'.repeat(9_000)}` })
    failure.raceDirectory = join(root, 'details', entry.id)

    const removing = store.remove(scope, entry.id)
    const recreating = store.upsert({ ...base, id: entry.id, detail: `new-${'b'.repeat(9_000)}` })
    await Promise.all([removing, recreating])

    expect(await readFile(join(root, 'details', entry.id, 'part-001.md'), 'utf8')).toContain('new-')
  })
})

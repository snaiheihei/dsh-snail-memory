import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, MemoryStoreReadonlyError } from '../../src/store/store.js'
import type { MemoryScope, UpsertMemoryInput } from '../../src/store/types.js'
import { memoryId, workspaceId } from '../../src/store/types.js'

const fileReads = vi.hoisted(() => [] as string[])
const fileReadControl = vi.hoisted(() => ({ delayDetails: false }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      fileReads.push(String(args[0]))
      if (fileReadControl.delayDetails && String(args[0]).includes('detail-data')) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return actual.readFile(...args)
    },
  }
})

const roots: string[] = []
const stores: MemoryStore[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'snail-memory-store-'))
  roots.push(root)
  return root
}

async function open(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  return store
}

function input(scope: MemoryScope, summary: string): UpsertMemoryInput {
  return {
    scope,
    category: 'project-convention',
    summary,
    detail: `${summary} details`,
    sourceRefs: [{ sessionId: 'session-1' }],
    lastVerifiedAt: '2026-10-26T00:00:00.000Z',
  }
}

afterEach(async () => {
  fileReads.length = 0
  fileReadControl.delayDetails = false
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MemoryStore', () => {
  it('keeps global and workspace entries separate and publishes workspace references', async () => {
    const store = await open(await tempRoot())
    const globalScope: MemoryScope = { kind: 'global' }
    const workspaceScope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }

    await store.upsert(input(globalScope, 'Use pnpm'))
    await store.upsert(input(workspaceScope, 'Run focused tests'))

    expect(store.list(globalScope).entries.map(entry => entry.summary)).toEqual(['Use pnpm'])
    expect(store.list(workspaceScope).entries.map(entry => entry.summary)).toEqual(['Run focused tests'])
    const globalIndex = store.list(globalScope)
    expect(globalIndex.workspaces).toEqual([
      expect.objectContaining({ workspaceId: workspaceId('workspace-1'), entryCount: 1 }),
    ])
    expect(globalIndex.workspaces[0]).not.toHaveProperty('detail')
  })

  it('links workspace index entries to the shared detail projection', async () => {
    const root = await tempRoot()
    const store = await open(root)
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const entry = await store.upsert(input(scope, 'Run focused tests'))

    const markdown = await readFile(join(root, 'workspaces', 'workspace-1', 'INDEX.md'), 'utf8')
    expect(markdown).toContain(`](../../details/${entry.id}.md)`)
  })

  it('projects large details into chunks without expanding the parent index', async () => {
    const root = await tempRoot()
    const store = await open(root)
    const scope: MemoryScope = { kind: 'global' }
    const detail = `Heading\n\n${'a'.repeat(9_000)}`
    const entry = await store.upsert({ ...input(scope, 'Large detail'), detail })

    const index = await readFile(join(root, 'global', 'INDEX.md'), 'utf8')
    const chunkIndex = await readFile(join(root, 'details', entry.id, 'INDEX.md'), 'utf8')
    const firstChunk = await readFile(join(root, 'details', entry.id, 'part-001.md'), 'utf8')

    expect(index).toContain(`](../details/${entry.id}/INDEX.md)`)
    expect(index.match(/Large detail/g)).toHaveLength(1)
    expect(index).not.toContain('part-001')
    expect(chunkIndex).toContain('part-001.md')
    expect(chunkIndex).not.toContain('a'.repeat(100))
    expect(firstChunk).toContain('Heading')
    await expect(readFile(join(root, 'details', `${entry.id}.md`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes stale chunk projections after corrections and deletion', async () => {
    const root = await tempRoot()
    const store = await open(root)
    const scope: MemoryScope = { kind: 'global' }
    const entry = await store.upsert({ ...input(scope, 'Changing detail'), detail: 'a'.repeat(13_000) })
    const chunkDirectory = join(root, 'details', entry.id)
    const firstRecord = store.paths.detailRecord(entry.id, entry.revision)

    const corrected = await store.upsert({ ...input(scope, 'Changing detail'), id: entry.id, detail: 'b'.repeat(8_500) })
    await expect(readFile(firstRecord, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.read(scope, entry.id))?.detail).toBe('b'.repeat(8_500))
    expect(corrected.revision).toBeGreaterThan(entry.revision)
    await expect(readFile(join(chunkDirectory, 'part-004.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(chunkDirectory, 'part-003.md'), 'utf8')).toContain('b')

    await store.upsert({ ...input(scope, 'Changing detail'), id: entry.id, detail: 'small' })
    await expect(readFile(join(chunkDirectory, 'INDEX.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(store.paths.detail(entry.id), 'utf8')).toContain('small')

    const recreated = await store.upsert({ ...input(scope, 'Changing detail'), id: entry.id, detail: 'c'.repeat(8_001) })
    await expect(readFile(store.paths.detail(entry.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await store.remove(scope, entry.id)
    await expect(readFile(join(chunkDirectory, 'part-001.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(store.paths.detailRecord(entry.id, recreated.revision), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores entries and session state after reopening', async () => {
    const root = await tempRoot()
    const first = await open(root)
    const scope: MemoryScope = { kind: 'global' }
    await first.upsert(input(scope, 'Prefer explicit APIs'))
    await first.updateSessionState('session-1', state => {
      state.layers.global.enabled = true
      state.layers.global.committed.push({
        injectionId: 'injection-1',
        revision: 1,
        tokens: 42,
        committedAt: '2026-10-26T00:00:00.000Z',
      })
    })
    await first.close()

    const second = await open(root)
    expect(second.list(scope).entries[0]?.summary).toBe('Prefer explicit APIs')
    expect(second.getSessionState('session-1').layers.global).toMatchObject({
      enabled: true,
      committed: [{ injectionId: 'injection-1', tokens: 42 }],
    })
  })

  it('keeps details out of the parent state and reads them only on demand', async () => {
    const root = await tempRoot()
    const first = await open(root)
    const scope: MemoryScope = { kind: 'global' }
    const entry = await first.upsert({ ...input(scope, 'Lazy detail'), detail: 'detail-' + 'x'.repeat(20_000) })
    await first.close()
    fileReads.length = 0

    const second = await open(root)
    expect(second.list(scope).entries[0]).toMatchObject({ id: entry.id, summary: 'Lazy detail' })
    expect(fileReads.some(path => path.includes(join('detail-data', entry.id)))).toBe(false)

    expect((await second.read(scope, entry.id))?.detail).toBe('detail-' + 'x'.repeat(20_000))
    expect(fileReads.filter(path => path.includes(join('detail-data', entry.id)))).toHaveLength(1)
    const persisted = JSON.parse(await readFile(join(root, 'state.v2.json'), 'utf8'))
    expect(persisted.formatVersion).toBe(2)
    expect(persisted.entries[0]).not.toHaveProperty('detail')
    expect(persisted.entries[0].detailChars).toBe(20_007)
  })

  it('migrates v1 inline details to versioned records', async () => {
    const root = await tempRoot()
    const id = memoryId('00000000-0000-4000-8000-000000000001')
    const timestamp = '2026-10-26T00:00:00.000Z'
    await writeFile(join(root, 'state.v1.json'), JSON.stringify({
      formatVersion: 1,
      revision: 7,
      entries: [{
        ...input({ kind: 'global' }, 'Migrated detail'),
        id,
        detail: 'legacy complete detail',
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 3,
      }],
      workspaces: {},
      scopeRevisions: { global: 3, workspaces: {} },
      sessions: {},
      meta: {
        dirty: false,
        nextConsolidationAt: null,
        nextRetentionAt: null,
        lastConsolidationAt: null,
        lastRetentionAt: null,
        lastError: null,
        pending: {},
      },
    }))

    const store = await open(root)
    expect((await store.read({ kind: 'global' }, id))?.detail).toBe('legacy complete detail')
    const migrated = JSON.parse(await readFile(join(root, 'state.v2.json'), 'utf8'))
    expect(migrated.entries[0]).toMatchObject({ id, detailChars: 'legacy complete detail'.length })
    expect(migrated.entries[0]).not.toHaveProperty('detail')
    await expect(readFile(join(root, 'state.v1.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forgets only memory content and preserves session history metadata', async () => {
    const store = await open(await tempRoot())
    const scope: MemoryScope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') }
    const entry = await store.upsert(input(scope, 'Obsolete convention'))
    await store.updateSessionState('session-1', state => {
      state.layers.workspace.enabled = true
    })

    expect(await store.remove(scope, entry.id)).toBe(true)

    await expect(store.read(scope, entry.id)).resolves.toBeNull()
    expect(store.list(scope).entries).toEqual([])
    expect(store.getSessionState('session-1').layers.workspace.enabled).toBe(true)
    await expect(readFile(store.paths.detail(entry.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.remove(scope, entry.id)).toBe(false)
  })

  it('reads unmigrated v1 details on a secondary host without writing', async () => {
    const root = await tempRoot()
    const writer = await open(root)
    const id = memoryId('00000000-0000-4000-8000-000000000002')
    const timestamp = '2026-10-26T00:00:00.000Z'
    await writeFile(join(root, 'state.v1.json'), JSON.stringify({
      formatVersion: 1,
      revision: 1,
      entries: [{
        ...input({ kind: 'global' }, 'Read-only legacy'),
        id,
        detail: 'legacy secondary detail',
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      }],
      workspaces: {},
      scopeRevisions: { global: 1, workspaces: {} },
      sessions: {},
      meta: {
        dirty: false, nextConsolidationAt: null, nextRetentionAt: null,
        lastConsolidationAt: null, lastRetentionAt: null, lastError: null, pending: {},
      },
    }))

    const reader = await open(root)
    expect(reader.writable).toBe(false)
    expect((await reader.read({ kind: 'global' }, id))?.detail).toBe('legacy secondary detail')
    await expect(readFile(join(root, 'state.v2.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(writer.writable).toBe(true)
  })

  it('opens a second host as read-only instead of allowing concurrent writes', async () => {
    const root = await tempRoot()
    const writer = await open(root)
    const reader = await open(root)
    const scope: MemoryScope = { kind: 'global' }

    expect(writer.writable).toBe(true)
    expect(reader.writable).toBe(false)
    await expect(reader.upsert(input(scope, 'Must not write'))).rejects.toBeInstanceOf(MemoryStoreReadonlyError)
    await reader.upsert(input(scope, 'Must not write')).catch(() => {})
    expect(reader.list(scope).entries).toEqual([])
  })

  it('refreshes a secondary host before reading corrected or deleted details', async () => {
    const root = await tempRoot()
    const writer = await open(root)
    const reader = await open(root)
    const scope: MemoryScope = { kind: 'global' }
    const entry = await writer.upsert({ ...input(scope, 'Secondary read'), detail: 'old-detail' })
    expect((await reader.read(scope, entry.id))?.detail).toBe('old-detail')

    await writer.upsert({ ...input(scope, 'Secondary read'), id: entry.id, detail: 'new-detail' })
    expect((await reader.read(scope, entry.id))?.detail).toBe('new-detail')

    await writer.remove(scope, entry.id)
    await expect(reader.read(scope, entry.id)).resolves.toBeNull()
  })

  it('serializes local detail reads with deletion', async () => {
    const store = await open(await tempRoot())
    const scope: MemoryScope = { kind: 'global' }
    const entry = await store.upsert({ ...input(scope, 'Read race'), detail: 'readable-before-delete' })
    fileReadControl.delayDetails = true

    const reading = store.read(scope, entry.id)
    await new Promise(resolve => setTimeout(resolve, 10))
    await store.remove(scope, entry.id)

    expect((await reading)?.detail).toBe('readable-before-delete')
  })

  it('recovers a stale writer lock', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'lock.json'), JSON.stringify({
      writerId: 'dead-writer',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    }))
    const store = await MemoryStore.open({
      root,
      heartbeatMs: 60_000,
      lockStaleMs: 1,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    })
    stores.push(store)

    expect(store.writable).toBe(true)
  })

  it('fails loudly on a corrupt authoritative snapshot', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'state.v1.json'), '{not json')

    await expect(open(root)).rejects.toThrow(/state\.v1\.json/)
  })
})

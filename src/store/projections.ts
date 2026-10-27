import { access, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryEntry, MemoryScope, StoreState, StoredMemoryEntry } from './types.js'
import { workspaceId } from './types.js'
import type { StorePaths } from './paths.js'
import { chunkMemoryDetail, MEMORY_CHUNK_THRESHOLD, type MemoryDetailChunk } from './chunks.js'
import { writeTextAtomic } from './json.js'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function escapeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function scopeEntries(state: StoreState, scope: MemoryScope): StoredMemoryEntry[] {
  return state.entries.filter(entry => scope.kind === 'global'
    ? entry.scope.kind === 'global'
    : entry.scope.kind === 'workspace' && entry.scope.workspaceId === scope.workspaceId)
}

function indexMarkdown(state: StoreState, scope: MemoryScope): string {
  const entries = scopeEntries(state, scope)
  const lines = [
    scope.kind === 'global' ? '# Snail Memory — 总记忆索引' : `# Snail Memory — ${scope.workspaceId}`,
    '',
    `Revision: ${scope.kind === 'global' ? state.scopeRevisions.global : state.scopeRevisions.workspaces[scope.workspaceId] ?? 0}`,
    '',
    '## 条目',
    '',
  ]
  const detailPrefix = scope.kind === 'global' ? '../details' : '../../details'
  for (const entry of entries) {
    const target = entry.detailChars > MEMORY_CHUNK_THRESHOLD ? `${entry.id}/INDEX.md` : `${entry.id}.md`
    lines.push(`- [${escapeText(entry.summary)}](${detailPrefix}/${target}) — ${entry.category}; verified ${entry.lastVerifiedAt}; revision ${entry.revision}`)
  }
  if (entries.length === 0) lines.push('- （无条目）')
  if (scope.kind === 'global') {
    lines.push('', '## Workspace 索引', '')
    for (const [id, meta] of Object.entries(state.workspaces)) {
      const count = scopeEntries(state, { kind: 'workspace', workspaceId: workspaceId(id) }).length
      lines.push(`- [${id}](../workspaces/${id}/INDEX.md) — ${count} 条；revision ${state.scopeRevisions.workspaces[id] ?? 0}；updated ${meta.updatedAt}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function coreMarkdown(state: StoreState, scope: MemoryScope): string {
  const entries = scopeEntries(state, scope)
  const lines = ['# Snail Memory — 核心摘要', '']
  for (const entry of entries) lines.push(`- [${entry.category}] ${escapeText(entry.summary)}`)
  if (entries.length === 0) lines.push('- （无核心摘要）')
  return `${lines.join('\n')}\n`
}

async function recoverChunkDirectory(target: string, staging: string, backup: string): Promise<void> {
  if (await exists(backup)) {
    if (await exists(target)) await rm(backup, { recursive: true, force: true })
    else await rename(backup, target)
  }
  await rm(staging, { recursive: true, force: true })
}

async function writeChunkDirectory(
  paths: StorePaths,
  entry: MemoryEntry,
  chunks: readonly MemoryDetailChunk[],
  metadata: string,
): Promise<void> {
  const target = paths.detailDirectory(entry.id)
  const staging = `${target}.tmp`
  const backup = `${target}.bak`
  await recoverChunkDirectory(target, staging, backup)
  await mkdir(staging, { recursive: true })
  const lines = [`${metadata}\n## 分片索引`]
  try {
    for (const chunk of chunks) {
      lines.push(`- [${chunk.id}](${chunk.id}.md) — ${chunk.text.length} 字符`)
      await writeFile(join(staging, `${chunk.id}.md`), `${metadata}\n- Chunk: ${chunk.id}\n\n${escapeText(chunk.text)}\n`, 'utf8')
    }
    await writeFile(join(staging, 'INDEX.md'), `${lines.join('\n')}\n`, 'utf8')
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  let hadPrevious = false
  try {
    if (await exists(target)) {
      await rename(target, backup)
      hadPrevious = true
    }
    await rename(staging, target)
  } catch (error) {
    if (hadPrevious && !(await exists(target))) await rename(backup, target)
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => {})
}

async function removeOrphanDetails(paths: StorePaths, state: StoreState): Promise<void> {
  const retained = new Set(state.entries.flatMap(entry => [
    `${entry.id}.md`, entry.id, `${entry.id}.tmp`, `${entry.id}.bak`,
  ]))
  for (const name of await readdir(paths.details)) {
    if (!retained.has(name)) await rm(join(paths.details, name), { recursive: true, force: true })
  }
}

export async function writeDetailProjection(paths: StorePaths, entry: MemoryEntry): Promise<void> {
  await mkdir(paths.details, { recursive: true })
  const metadata = `# ${escapeText(entry.summary)}\n\n- Category: ${entry.category}\n- Updated: ${entry.updatedAt}\n- Last verified: ${entry.lastVerifiedAt}\n- Revision: ${entry.revision}\n`
  const chunks = chunkMemoryDetail(entry.detail)
  if (chunks.length === 0) {
    await writeTextAtomic(paths.detail(entry.id), `${metadata}\n${escapeText(entry.detail)}\n`)
    await rm(paths.detailDirectory(entry.id), { recursive: true, force: true })
    await rm(`${paths.detailDirectory(entry.id)}.tmp`, { recursive: true, force: true })
    await rm(`${paths.detailDirectory(entry.id)}.bak`, { recursive: true, force: true })
    return
  }
  await writeChunkDirectory(paths, entry, chunks, metadata)
  await rm(paths.detail(entry.id), { force: true })
}

export async function removeDetailProjection(paths: StorePaths, id: string): Promise<void> {
  await Promise.all([
    rm(paths.detail(id), { force: true }),
    rm(paths.detailDirectory(id), { recursive: true, force: true }),
    rm(`${paths.detailDirectory(id)}.tmp`, { recursive: true, force: true }),
    rm(`${paths.detailDirectory(id)}.bak`, { recursive: true, force: true }),
  ])
}

export async function writeIndexProjections(paths: StorePaths, state: StoreState): Promise<void> {
  const scopes: MemoryScope[] = [
    { kind: 'global' },
    ...Object.keys(state.workspaces).map(id => ({ kind: 'workspace' as const, workspaceId: workspaceId(id) })),
  ]
  await mkdir(paths.details, { recursive: true })
  await removeOrphanDetails(paths, state)
  for (const scope of scopes) {
    const directory = scope.kind === 'global' ? paths.global : paths.workspace(scope.workspaceId)
    await mkdir(directory, { recursive: true })
    await writeTextAtomic(join(directory, 'INDEX.md'), indexMarkdown(state, scope))
    await writeTextAtomic(join(directory, 'MEMORY.md'), coreMarkdown(state, scope))
  }
}

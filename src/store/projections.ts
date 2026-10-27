import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryEntry, MemoryScope, StoreState } from './types.js'
import { workspaceId } from './types.js'
import type { StorePaths } from './paths.js'

function escapeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function scopeEntries(state: StoreState, scope: MemoryScope): MemoryEntry[] {
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
    lines.push(`- [${escapeText(entry.summary)}](${detailPrefix}/${entry.id}.md) — ${entry.category}; verified ${entry.lastVerifiedAt}; revision ${entry.revision}`)
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

export async function writeProjections(paths: StorePaths, state: StoreState): Promise<void> {
  const scopes: MemoryScope[] = [
    { kind: 'global' },
    ...Object.keys(state.workspaces).map(id => ({ kind: 'workspace' as const, workspaceId: workspaceId(id) })),
  ]
  await mkdir(paths.details, { recursive: true })
  for (const entry of state.entries) {
    const body = `# ${escapeText(entry.summary)}\n\n- Category: ${entry.category}\n- Updated: ${entry.updatedAt}\n- Last verified: ${entry.lastVerifiedAt}\n- Revision: ${entry.revision}\n\n${escapeText(entry.detail)}\n`
    await writeFile(paths.detail(entry.id), body, 'utf8')
  }
  for (const scope of scopes) {
    const directory = scope.kind === 'global' ? paths.global : paths.workspace(scope.workspaceId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'INDEX.md'), indexMarkdown(state, scope), 'utf8')
    await writeFile(join(directory, 'MEMORY.md'), coreMarkdown(state, scope), 'utf8')
  }
}

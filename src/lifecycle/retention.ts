import type { MemoryStore } from '../store/store.js'
import type { MemoryCategory, MemoryId, MemoryIndexEntry, MemoryScope } from '../store/types.js'

const DAY_MS = 86_400_000
const RETENTION_DAYS: Partial<Record<MemoryCategory, number>> = {
  'environment-fact': 30,
  'project-convention': 180,
  troubleshooting: 180,
}

export interface RetentionOptions {
  readonly now?: () => Date
  readonly onChange?: (scope: MemoryScope, ids: readonly MemoryId[]) => Promise<void> | void
}

export function isExpired(entry: MemoryIndexEntry, now: Date): boolean {
  if (entry.expiresAt !== undefined) {
    const explicit = new Date(entry.expiresAt).getTime()
    if (Number.isFinite(explicit) && explicit <= now.getTime()) return true
  }
  const days = RETENTION_DAYS[entry.category]
  if (days === undefined) return false
  const verified = new Date(entry.lastVerifiedAt).getTime()
  return !Number.isFinite(verified) || verified + days * DAY_MS <= now.getTime()
}

export async function retentionSweep(store: MemoryStore, options: RetentionOptions = {}): Promise<MemoryId[]> {
  const now = options.now?.() ?? new Date()
  const scopes: MemoryScope[] = [
    { kind: 'global' },
    ...store.list({ kind: 'global' }).workspaces.map(ref => ({ kind: 'workspace' as const, workspaceId: ref.workspaceId })),
  ]
  const removed: MemoryId[] = []
  for (const scope of scopes) {
    const ids: MemoryId[] = []
    for (const entry of store.list(scope).entries) {
      if (isExpired(entry, now) && await store.remove(scope, entry.id)) {
        ids.push(entry.id)
        removed.push(entry.id)
      }
    }
    if (ids.length) await options.onChange?.(scope, ids)
  }
  await store.updateMeta(meta => {
    if (removed.length) {
      meta.dirty = true
      meta.nextConsolidationAt = new Date(now.getTime() + 6 * 3_600_000).toISOString()
    }
    meta.lastRetentionAt = now.toISOString()
    meta.nextRetentionAt = new Date(now.getTime() + 24 * 3_600_000).toISOString()
  })
  return removed
}

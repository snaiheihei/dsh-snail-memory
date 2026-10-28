import { createHash } from 'node:crypto'
import { prepareMemoryCandidate } from '../safety/policy.js'
import type { MemoryStore } from '../store/store.js'
import type { MemoryEntry, MemoryScope, MemorySourceRef } from '../store/types.js'
import { memoryId } from '../store/types.js'
import { invokeAuxiliaryModel, type AuxiliaryModel } from './llm.js'

export interface ConsolidateOptions {
  readonly model?: AuxiliaryModel
  readonly provider?: string
  readonly modelName?: string
  readonly scope?: MemoryScope
  readonly now?: () => Date
  readonly signal?: AbortSignal
  readonly onChange?: (scope: MemoryScope, entries: readonly MemoryEntry[]) => Promise<void> | void
}

function memoryRefs(refs: readonly MemorySourceRef[]): MemorySourceRef[] {
  const unique = new Map<string, MemorySourceRef>()
  for (const ref of refs) unique.set(JSON.stringify(ref), ref)
  return [...unique.values()]
}

function generatedId(scope: MemoryScope, category: string, summary: string) {
  const key = scope.kind === 'global' ? 'global' : scope.workspaceId
  return memoryId(createHash('sha256').update(`${key}\0${category}\0${summary.toLowerCase()}`).digest('hex'))
}

async function fullEntries(store: MemoryStore, scope: MemoryScope): Promise<MemoryEntry[]> {
  const entries = await Promise.all(store.list(scope).entries.map(index => store.read(scope, index.id)))
  return entries.filter((entry): entry is MemoryEntry => entry !== null)
}

export async function consolidateMemories(store: MemoryStore, options: ConsolidateOptions): Promise<number> {
  if (!options.model || !options.provider || !options.modelName) throw new Error('No auxiliary model route is available')
  const now = options.now?.() ?? new Date()
  const initialMeta = store.getMeta()
  const consolidationSchedule = options.scope?.kind === 'global'
    ? initialMeta.nextGlobalConsolidationAt
    : initialMeta.nextConsolidationAt
  const scopes: MemoryScope[] = options.scope ? [options.scope] : store.workspaceScopes()
  let written = 0
  for (const scope of scopes) {
    const entries = await fullEntries(store, scope)
    if (entries.length === 0) continue
    const newestFirst = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    let input = ''
    const included: MemoryEntry[] = []
    for (const entry of newestFirst) {
      const next = `${input}${input ? '\n' : ''}${JSON.stringify(entry)}`
      if (next.length > 64_000) break
      input = next
      included.push(entry)
    }
    if (included.length === 0) included.push({ ...newestFirst[0]!, detail: newestFirst[0]!.detail.slice(0, 60_000) })
    const safe = prepareMemoryCandidate(included.map(entry => JSON.stringify(entry)).join('\n'), {
      source: 'session', mode: 'automatic',
    })
    const scopeName = scope.kind === 'global' ? 'global' : `workspace:${scope.workspaceId}`
    const parsed = await invokeAuxiliaryModel({
      model: options.model,
      provider: options.provider,
      modelName: options.modelName,
      prompt: `Consolidate only scope ${scopeName}. Never promote between scopes. Merge duplicates, correct conflicts, and supersede obsolete entries. Return JSON candidates with optional id and supersedes.\n${safe.text}`,
      maxOutputChars: 64_000,
      maxDetailChars: 16_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const changed: MemoryEntry[] = []
    for (const candidate of parsed.candidates) {
      const snapshot = candidate.id
        ? entries.find(entry => entry.id === candidate.id)
        : entries.find(entry => entry.category === candidate.category
          && entry.summary.toLowerCase() === candidate.summary.toLowerCase())
      // An id absent from this scope may belong to another scope; never move it.
      if (candidate.id && !snapshot) continue
      const existing = snapshot ? await store.read(scope, snapshot.id) : undefined
      if (snapshot && (!existing || existing.revision !== snapshot.revision)) continue
      const id = existing?.id ?? generatedId(scope, candidate.category, candidate.summary.trim())
      const refs = memoryRefs([...(existing?.sourceRefs ?? []), ...(candidate.sourceRefs ?? [])])
      if (existing && existing.summary === candidate.summary.trim() && existing.detail === candidate.detail.trim()
        && JSON.stringify(existing.sourceRefs) === JSON.stringify(refs)) {
        continue
      }
      const saved = await store.upsert({
        id,
        scope,
        category: candidate.category,
        summary: candidate.summary.trim(),
        detail: candidate.detail.trim(),
        sourceRefs: refs.length ? refs : existing?.sourceRefs ?? [],
        lastVerifiedAt: now.toISOString(),
        ...(candidate.supersedes === undefined ? {} : { supersedes: candidate.supersedes }),
      })
      changed.push(saved)
      written += 1
      for (const oldId of candidate.supersedes ?? []) {
        if (oldId !== saved.id && await store.read(scope, oldId)) await store.remove(scope, oldId)
      }
    }
    if (changed.length) await options.onChange?.(scope, changed)
  }
  await store.updateMeta(meta => {
    if (options.scope?.kind === 'global') {
      if (meta.nextGlobalConsolidationAt === consolidationSchedule) {
        meta.globalDirty = false
        meta.lastGlobalConsolidationAt = now.toISOString()
        meta.nextGlobalConsolidationAt = null
      }
    } else if (meta.nextConsolidationAt === consolidationSchedule) {
      meta.dirty = false
      meta.lastConsolidationAt = now.toISOString()
      meta.nextConsolidationAt = null
    }
    meta.lastError = null
  })
  return written
}

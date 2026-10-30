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

function modelEntry(entry: MemoryEntry) {
  return {
    id: entry.id,
    category: entry.category,
    summary: entry.summary,
    detail: entry.detail,
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
  }
}

export async function consolidateMemories(store: MemoryStore, options: ConsolidateOptions): Promise<number> {
  if (!options.model || !options.provider || !options.modelName) throw new Error('No auxiliary model route is available')
  const now = options.now?.() ?? new Date()
  const scopes: MemoryScope[] = options.scope ? [options.scope] : store.workspaceScopes()
  let written = 0
  for (const scope of scopes) {
    const entries = await fullEntries(store, scope)
    if (entries.length > 0) {
      const newestFirst = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      let input = ''
      const included: MemoryEntry[] = []
      for (const entry of newestFirst) {
        const next = `${input}${input ? '\n' : ''}${JSON.stringify(modelEntry(entry))}`
        if (next.length > 64_000) break
        input = next
        included.push(entry)
      }
      if (included.length === 0) included.push({ ...newestFirst[0]!, detail: newestFirst[0]!.detail.slice(0, 60_000) })
      const safe = prepareMemoryCandidate(included.map(entry => JSON.stringify(modelEntry(entry))).join('\n'), {
        source: 'session', mode: 'automatic',
      })
      const scopeName = scope.kind === 'global' ? 'global' : `workspace:${scope.workspaceId}`
      const parsed = await invokeAuxiliaryModel({
        model: options.model,
        provider: options.provider,
        modelName: options.modelName,
        prompt: `Consolidate only scope ${scopeName}. Never promote between scopes. Merge duplicates, correct conflicts, and supersede obsolete entries.
Return only JSON: one object with a candidates array, without Markdown fences or explanatory text.
Use this shape: {"candidates":[{"id":"optional input entry id","category":"required category","summary":"required non-empty string","detail":"required non-empty string, at most 16000 characters","supersedes":["optional input entry ids"]}]}.
Category must be exactly one of preference, project-convention, environment-fact, troubleshooting, long-term-decision.
Return only new or changed candidates; do not return unchanged entries. Omit id for new entries. id and supersedes may only reference entry ids from the input below. Do not return sourceRefs.
Input entries:\n${safe.text}`,
        maxOutputChars: 64_000,
        maxDetailChars: 16_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const changed: MemoryEntry[] = []
      for (const candidate of parsed.candidates) {
        const snapshot = candidate.id
          ? included.find(entry => entry.id === candidate.id)
          : included.find(entry => entry.category === candidate.category
            && entry.summary.trim().toLowerCase() === candidate.summary.trim().toLowerCase())
        // An id absent from the model input may belong to another scope or a truncated entry.
        if (candidate.id && !snapshot) continue
        const existing = snapshot ? await store.read(scope, snapshot.id) : undefined
        if (snapshot && (!existing || existing.revision !== snapshot.revision)) continue
        const id = existing?.id ?? generatedId(scope, candidate.category, candidate.summary.trim())
        const supersededSnapshots = [...new Set(candidate.supersedes ?? [])]
          .filter(oldId => oldId !== id)
          .map(oldId => included.find(entry => entry.id === oldId))
          .filter((entry): entry is MemoryEntry => entry !== undefined)
        const currentSuperseded = await Promise.all(supersededSnapshots.map(entry => store.read(scope, entry.id)))
        if (currentSuperseded.some((entry, index) => !entry || entry.revision !== supersededSnapshots[index]!.revision)) continue
        const supersedes = supersededSnapshots.map(entry => entry.id)
        const refs = memoryRefs([
          ...(existing?.sourceRefs ?? []),
          ...supersededSnapshots.flatMap(entry => entry.sourceRefs),
        ])
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
          sourceRefs: refs,
          lastVerifiedAt: now.toISOString(),
          ...(candidate.supersedes === undefined ? {} : { supersedes }),
        })
        changed.push(saved)
        written += 1
        for (const oldId of supersedes) {
          if (await store.read(scope, oldId)) await store.remove(scope, oldId)
        }
      }
      if (changed.length) await options.onChange?.(scope, changed)
    }
  }
  return written
}

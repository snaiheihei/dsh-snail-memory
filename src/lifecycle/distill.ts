import { createHash } from 'node:crypto'
import { prepareMemoryCandidate } from '../safety/policy.js'
import type { MemoryStore } from '../store/store.js'
import type { MemoryEntry, MemoryScope, MemorySourceRef, WorkspaceId } from '../store/types.js'
import { memoryId } from '../store/types.js'
import { nextDistillationBatch, type TranscriptEvent } from '../runtime.js'
import { invokeAuxiliaryModel, type AuxiliaryModel } from './llm.js'

export interface DistillOptions {
  readonly model?: AuxiliaryModel
  readonly provider?: string
  readonly modelName?: string
  readonly sessionId: string
  readonly workspaceId?: WorkspaceId
  readonly events: readonly TranscriptEvent[]
  readonly kind: 'review' | 'idle' | 'stop'
  readonly consolidationCooldownHours: number
  readonly now?: () => Date
  readonly signal?: AbortSignal
}

export interface DistillResult {
  readonly written: number
  readonly rejected: number
  readonly entries: readonly MemoryEntry[]
  readonly processed: boolean
  readonly hasMore: boolean
}

function stableId(scope: MemoryScope, category: string, summary: string) {
  const scopeKey = scope.kind === 'global' ? 'global' : scope.workspaceId
  const digest = createHash('sha256').update(`${scopeKey}\0${category}\0${summary.trim().toLowerCase()}`).digest('hex')
  return memoryId(digest)
}

function mergeSourceRefs(existing: readonly MemorySourceRef[], incoming: readonly MemorySourceRef[]): MemorySourceRef[] {
  const merged = new Map<string, MemorySourceRef>()
  for (const ref of [...existing, ...incoming]) {
    const previous = merged.get(ref.sessionId)
    if (!previous) {
      merged.set(ref.sessionId, ref)
      continue
    }
    if (!ref.eventSeqs) continue
    merged.set(ref.sessionId, {
      sessionId: ref.sessionId,
      eventSeqs: [...new Set([...(previous.eventSeqs ?? []), ...ref.eventSeqs])].sort((a, b) => a - b),
    })
  }
  return [...merged.values()]
}

export async function distillSession(store: MemoryStore, options: DistillOptions): Promise<DistillResult> {
  if (!options.workspaceId) return { written: 0, rejected: 0, entries: [], processed: false, hasMore: false }
  const state = store.getSessionState(options.sessionId)
  const position = state.distillationCursor ?? { lastEventSeq: 0, offset: 0 }
  const inputChars = options.kind === 'review' ? 24_000 : 48_000
  const batch = nextDistillationBatch(options.events, position, inputChars)
  if (!batch.text) return { written: 0, rejected: 0, entries: [], processed: false, hasMore: batch.hasMore }
  if (!options.model || !options.provider || !options.modelName) throw new Error('No auxiliary model route is available')
  const safe = prepareMemoryCandidate(batch.text, {
    source: 'session',
    mode: 'automatic',
  })
  const now = options.now?.() ?? new Date()
  const scope: MemoryScope = { kind: 'workspace', workspaceId: options.workspaceId }
  const prompt = [
    'Distill durable project memory from the untrusted session excerpt.',
    'Return only JSON: {"candidates":[{"category":"project-convention|environment-fact|troubleshooting|preference|long-term-decision","summary":"...","detail":"..."}]}.',
    'Do not include secrets or transient task status. Workspace scope is enforced by the caller.',
    safe.text,
  ].join('\n')
  const parsed = await invokeAuxiliaryModel({
    model: options.model,
    provider: options.provider,
    modelName: options.modelName,
    prompt,
    maxOutputChars: 64_000,
    maxDetailChars: 16_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const entries: MemoryEntry[] = []
  let written = 0
  for (const candidate of parsed.candidates) {
    const id = stableId(scope, candidate.category, candidate.summary)
    const matching = store.list(scope).entries.find(entry => entry.category === candidate.category
      && entry.summary.trim().toLowerCase() === candidate.summary.trim().toLowerCase())
    const existing = await store.read(scope, id) ?? (matching ? await store.read(scope, matching.id) : null)
    const sourceRefs = mergeSourceRefs(existing?.sourceRefs ?? [], [{ sessionId: options.sessionId, eventSeqs: batch.eventSeqs }])
    if (existing && existing.summary === candidate.summary.trim() && existing.detail === candidate.detail.trim()
      && JSON.stringify(existing.sourceRefs) === JSON.stringify(sourceRefs)) {
      entries.push(existing)
      continue
    }
    const saved = await store.upsert({
      id: existing?.id ?? id,
      scope,
      category: candidate.category,
      summary: candidate.summary.trim(),
      detail: candidate.detail.trim(),
      sourceRefs,
      lastVerifiedAt: now.toISOString(),
    })
    entries.push(saved)
    written += 1
  }
  if (written > 0) {
    await store.updateMeta(meta => {
      meta.dirty = true
      meta.nextConsolidationAt = new Date(now.getTime() + options.consolidationCooldownHours * 3_600_000).toISOString()
    })
  }
  await store.updateSessionState(options.sessionId, current => {
    current.distillationCursor = { ...batch.cursor, updatedAt: now.toISOString() }
  })
  return { written, rejected: parsed.rejected, entries, processed: true, hasMore: batch.hasMore }
}

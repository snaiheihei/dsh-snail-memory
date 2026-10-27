import type { MemoryCategory, MemoryId, MemorySourceRef } from '../store/types.js'
import { memoryId } from '../store/types.js'
import { scanSecrets } from '../safety/scanner.js'

export interface AuxiliaryModelCallConfig {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

export interface AuxiliaryModel {
  prepareCall(config: AuxiliaryModelCallConfig): Promise<{
    stream(options: {
      provider: string
      model: string
      messages: readonly { role: 'user'; content: readonly { type: 'text'; text: string }[] }[]
      maxTokens?: number
      signal?: AbortSignal
    }): AsyncIterable<{ type: string; text?: string }>
  }>
}

export interface AuxiliaryCallOptions {
  readonly model: AuxiliaryModel
  readonly provider: string
  readonly modelName: string
  readonly prompt: string
  readonly maxOutputChars?: number
  readonly maxDetailChars?: number
  readonly onPrompt?: (prompt: string) => void
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface ParsedCandidates {
  readonly candidates: readonly {
    readonly id?: MemoryId
    readonly category: MemoryCategory
    readonly summary: string
    readonly detail: string
    readonly sourceRefs?: readonly MemorySourceRef[]
    readonly supersedes?: readonly MemoryId[]
  }[]
  readonly rejected: number
}

function decodeJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = (fenced ?? text).trim()
  if (!source) throw new Error('Empty model output; expected JSON')
  try {
    return JSON.parse(source) as unknown
  } catch {
    const start = Math.min(...['{', '['].map(token => {
      const index = source.indexOf(token)
      return index < 0 ? source.length : index
    }))
    const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'))
    if (start >= source.length || end <= start) throw new Error('Model output was not valid JSON')
    try {
      return JSON.parse(source.slice(start, end + 1)) as unknown
    } catch (error) {
      const wrapped = new Error(`Model output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      Object.defineProperty(wrapped, 'cause', { value: error, configurable: true, writable: true })
      throw wrapped
    }
  }
}

export function parseCandidateResponse(text: string, maxDetailChars = 16_000): ParsedCandidates {
  if (!text.trim()) throw new Error('Empty model output; expected JSON')
  const parsed = decodeJson(text)
  const value = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : null
  if (!value) throw new Error('Model output JSON must be an array or a candidates object')
  const categories = new Set<MemoryCategory>([
    'preference', 'project-convention', 'environment-fact', 'troubleshooting', 'long-term-decision',
  ])
  const candidates: ParsedCandidates['candidates'][number][] = []
  let rejected = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      rejected += 1
      continue
    }
    const candidate = item as Record<string, unknown>
    if (typeof candidate.category !== 'string' || !categories.has(candidate.category as MemoryCategory)
      || typeof candidate.summary !== 'string' || !candidate.summary.trim()
      || typeof candidate.detail !== 'string' || !candidate.detail.trim()
      || candidate.detail.length > maxDetailChars
      || (candidate.id !== undefined && (typeof candidate.id !== 'string' || !candidate.id))
      || (candidate.sourceRefs !== undefined && !Array.isArray(candidate.sourceRefs))
      || (candidate.supersedes !== undefined && !Array.isArray(candidate.supersedes))) {
      rejected += 1
      continue
    }
    if (scanSecrets(`${candidate.summary}\n${candidate.detail}`).findings.length > 0) {
      rejected += 1
      continue
    }
    const sourceRefs = candidate.sourceRefs?.filter(ref => ref && typeof ref === 'object'
      && typeof (ref as { sessionId?: unknown }).sessionId === 'string') as MemorySourceRef[] | undefined
    const supersedes = candidate.supersedes?.filter(id => typeof id === 'string' && id.length > 0) as MemoryId[] | undefined
    candidates.push({
      category: candidate.category as MemoryCategory,
      summary: candidate.summary,
      detail: candidate.detail,
      ...(candidate.id === undefined ? {} : { id: memoryId(candidate.id) }),
      ...(sourceRefs === undefined ? {} : { sourceRefs }),
      ...(supersedes === undefined ? {} : { supersedes }),
    })
  }
  return { candidates, rejected }
}

async function invokeAuxiliaryModelInner(options: AuxiliaryCallOptions): Promise<ParsedCandidates> {
  const outputBudget = options.maxOutputChars ?? 64_000
  let text = ''
  const prepared = await options.model.prepareCall({
    provider: options.provider,
    model: options.modelName,
    maxTokens: Math.max(1, Math.ceil(outputBudget / 4)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  options.onPrompt?.(options.prompt)
  for await (const chunk of prepared.stream({
    provider: options.provider,
    model: options.modelName,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
    maxTokens: Math.max(1, Math.ceil(outputBudget / 4)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (text.length > outputBudget) throw new Error('Model output exceeds the JSON candidate budget')
  }
  return parseCandidateResponse(text, options.maxDetailChars)
}

export async function invokeAuxiliaryModel(options: AuxiliaryCallOptions): Promise<ParsedCandidates> {
  if (options.timeoutMs === undefined) return invokeAuxiliaryModelInner(options)
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([
      invokeAuxiliaryModelInner({ ...options, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Auxiliary model timeout after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** An injectable model boundary; production can pass an LlmRuntime directly. */
export type LlmModel = AuxiliaryModel

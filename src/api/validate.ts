import type { RpcMethod, RpcPayload } from '../contract.js'
import { memoryId, workspaceId, type MemoryCategory, type MemoryScope } from '../store/types.js'
import { MemoryApiError } from './errors.js'

const CATEGORIES: readonly MemoryCategory[] = ['preference', 'project-convention', 'environment-fact', 'troubleshooting', 'long-term-decision']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryApiError('invalid-request', 'Expected a JSON object.')
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, max = 128, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (name !== 'summary' && name !== 'detail' && !ID.test(value))) {
    throw new MemoryApiError('invalid-request', `Invalid ${name}.`)
  }
  return value
}

function scope(value: unknown): MemoryScope {
  const input = record(value)
  if (input.kind === 'global') return { kind: 'global' }
  if (input.kind === 'workspace') return { kind: 'workspace', workspaceId: workspaceId(string(input.workspaceId, 'workspaceId')!) }
  throw new MemoryApiError('invalid-request', 'Invalid memory scope.')
}

function category(value: unknown): MemoryCategory {
  if (typeof value !== 'string' || !CATEGORIES.includes(value as MemoryCategory)) throw new MemoryApiError('invalid-request', 'Invalid memory category.')
  return value as MemoryCategory
}

function session(value: unknown, optional = false) {
  return string(value, 'sessionId', 128, optional)
}

function settings(input: Record<string, unknown>) {
  if (typeof input.reviewEveryUserTurns !== 'number'
    || !Number.isSafeInteger(input.reviewEveryUserTurns) || input.reviewEveryUserTurns < 1) {
    throw new MemoryApiError('invalid-request', 'Invalid reviewEveryUserTurns.')
  }
  if (typeof input.idleDelayMinutes !== 'number'
    || !Number.isFinite(input.idleDelayMinutes) || input.idleDelayMinutes < 0) {
    throw new MemoryApiError('invalid-request', 'Invalid idleDelayMinutes.')
  }
  if (typeof input.consolidationCooldownHours !== 'number'
    || !Number.isFinite(input.consolidationCooldownHours) || input.consolidationCooldownHours < 0) {
    throw new MemoryApiError('invalid-request', 'Invalid consolidationCooldownHours.')
  }
  if (typeof input.globalConsolidationCooldownDays !== 'number'
    || !Number.isFinite(input.globalConsolidationCooldownDays) || input.globalConsolidationCooldownDays < 0) {
    throw new MemoryApiError('invalid-request', 'Invalid globalConsolidationCooldownDays.')
  }
  if (typeof input.snapshotTokenBudget !== 'number'
    || !Number.isSafeInteger(input.snapshotTokenBudget) || input.snapshotTokenBudget < 1) {
    throw new MemoryApiError('invalid-request', 'Invalid snapshotTokenBudget.')
  }
  const retention = record(input.retentionDays)
  const retentionDays = {} as Record<MemoryCategory, number>
  for (const category of CATEGORIES) {
    const days = retention[category]
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
      throw new MemoryApiError('invalid-request', `Invalid retentionDays.${category}.`)
    }
    retentionDays[category] = days
  }
  return {
    reviewEveryUserTurns: input.reviewEveryUserTurns,
    idleDelayMinutes: input.idleDelayMinutes,
    consolidationCooldownHours: input.consolidationCooldownHours,
    globalConsolidationCooldownDays: input.globalConsolidationCooldownDays,
    snapshotTokenBudget: input.snapshotTokenBudget,
    retentionDays,
  }
}

function write(input: Record<string, unknown>) {
  return {
    scope: scope(input.scope), category: category(input.category),
    summary: string(input.summary, 'summary', 500), detail: string(input.detail, 'detail', 16_000),
    sessionId: session(input.sessionId, true),
  }
}

export function validatePayload(method: RpcMethod, payload: unknown): RpcPayload {
  const input = record(payload)
  switch (method) {
    case 'getSessionState':
    case 'disable': return { sessionId: session(input.sessionId)! }
    case 'enable':
    case 'refresh': {
      if (input.layer !== 'global' && input.layer !== 'workspace') throw new MemoryApiError('invalid-request', 'Invalid memory layer.')
      if (input.workspaceId !== undefined && (method !== 'enable' || input.layer !== 'workspace')) {
        throw new MemoryApiError('invalid-request', 'workspaceId is only valid when enabling workspace memory.')
      }
      return {
        sessionId: session(input.sessionId)!,
        layer: input.layer,
        ...(input.workspaceId === undefined ? {} : { workspaceId: workspaceId(string(input.workspaceId, 'workspaceId')!) }),
      }
    }
    case 'list':
    case 'consolidate': return { scope: scope(input.scope) }
    case 'read':
    case 'remove':
    case 'promote': return { scope: scope(input.scope), id: memoryId(string(input.id, 'id')!) }
    case 'remember': return write(input)
    case 'correct': return { ...write(input), id: memoryId(string(input.id, 'id')!) }
    case 'status':
    case 'getSettings':
    case 'listWorkspaces': return {}
    case 'updateSettings': return settings(input)
  }
}

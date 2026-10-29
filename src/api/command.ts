import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CorrectRequest, MemoryStatus, ScopeRequest, WriteRequest } from '../contract.js'
import type { MemoryEntry, MemoryScope } from '../store/types.js'
import { memoryId, workspaceId } from '../store/types.js'
import type { MemoryController } from './controller.js'
import { safeError } from './errors.js'

export type MemoryCommandResult = CommandResult

const USAGE = 'Usage: /memory status | remember workspace <text> | correct workspace <id> <text> | forget workspace <id>'

function scope(value: string | undefined): MemoryScope | undefined {
  if (value === 'global') return { kind: 'global' }
  if (value === 'workspace') return { kind: 'workspace', workspaceId: workspaceId('pending') }
  return undefined
}

export async function executeMemoryCommand(
  controller: MemoryController,
  rawInput: string,
  sessionId: string,
): Promise<MemoryCommandResult> {
  const match = /^\s*(\S+)(?:\s+(global|workspace))?(?:\s+([\s\S]*))?\s*$/u.exec(rawInput)
  const action = match?.[1]
  const layer = match?.[2]
  const rest = match?.[3]?.trim()
  if (!action || !['remember', 'correct', 'forget', 'status'].includes(action)) return { kind: 'error', text: USAGE }
  try {
    if (action === 'status') {
      if (layer || rest) return { kind: 'error', text: USAGE }
      const status = await controller.call('status', {}) as MemoryStatus
      const workspaceSchedules = Object.values(status.workspaceConsolidation).filter(consolidation => consolidation.dirty)
      const nextConsolidationAt = workspaceSchedules.map(consolidation => consolidation.nextConsolidationAt)
        .filter((value): value is string => value !== null).sort()[0]
      return { kind: 'success', text: `Snail Memory: ${status.writable ? 'writable' : 'read-only'}; dirty workspaces=${workspaceSchedules.length}; next workspace consolidation=${nextConsolidationAt ?? 'not scheduled'}; next cleanup=${status.nextRetentionAt ?? 'not scheduled'}` }
    }
    let target = scope(layer)
    if (!target || !rest) return { kind: 'error', text: USAGE }
    if (target.kind === 'global') {
      return { kind: 'error', text: 'Direct global writes are unavailable; use Promote from a workspace memory.' }
    }
    const attachedWorkspaceId = controller.workspaceForSession(sessionId)
    if (!attachedWorkspaceId) return { kind: 'error', text: 'Workspace memory requires a session attached to a workspace.' }
    target = { kind: 'workspace', workspaceId: attachedWorkspaceId }
    if (action === 'forget') {
      if (/\s/u.test(rest)) return { kind: 'error', text: USAGE }
      const result = await controller.call('remove', { scope: target, id: memoryId(rest) })
      return { kind: 'success', text: result.removed ? 'Memory forgotten. Conversation history was not changed.' : 'Memory was already absent.' }
    }
    if (action === 'remember') {
      const request: WriteRequest = {
        scope: target, category: 'project-convention',
        summary: rest, detail: rest, sessionId,
      }
      const entry = await controller.call('remember', request)
      return { kind: 'success', text: `Remembered ${entry.id} in ${target.kind} memory.` }
    }
    const separator = rest.search(/\s/u)
    if (separator <= 0) return { kind: 'error', text: USAGE }
    const id = rest.slice(0, separator)
    const text = rest.slice(separator).trim()
    const existing = await controller.call('read', { scope: target, id: memoryId(id) } as ScopeRequest & { id: ReturnType<typeof memoryId> }) as MemoryEntry
    const request: CorrectRequest = {
      id: memoryId(id), scope: target, category: existing.category, summary: text, detail: text, sessionId,
    }
    await controller.call('correct', request)
    return { kind: 'success', text: `Corrected ${id}.` }
  } catch (error) {
    return { kind: 'error', text: safeError(error).message }
  }
}

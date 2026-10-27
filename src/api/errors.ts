import { MemoryStoreReadonlyError } from '../store/store.js'
import { SafetyError } from '../safety/index.js'

export class MemoryApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'MemoryApiError'
  }
}

export function safeError(error: unknown): MemoryApiError {
  if (error instanceof MemoryApiError) return error
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'read-only') {
    return new MemoryApiError('read-only', 'Snail Memory is read-only on this host.', 409)
  }
  if (error instanceof MemoryStoreReadonlyError || (error instanceof Error && error.name === 'MemoryStoreReadonlyError')) {
    return new MemoryApiError('read-only', 'Snail Memory is read-only on this host.', 409)
  }
  if (error instanceof SafetyError) {
    return new MemoryApiError(error.code, 'The memory contains content that cannot be stored safely.', 422)
  }
  if (error instanceof Error && /disabled|ungrouped|cannot move/i.test(error.message)) {
    return new MemoryApiError('invalid-operation', error.message, 409)
  }
  return new MemoryApiError('internal', 'Snail Memory could not complete the operation.', 500)
}

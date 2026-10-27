export interface LifecycleSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** Counts a user message only once its containing turn has completed. */
export class CompletedTurnCounter {
  private readonly pending = new Map<string, Set<string>>()
  private readonly completed = new Map<string, Set<string>>()
  private readonly currentTurns = new Map<string, string>()
  private readonly counted = new Map<string, Set<string>>()
  private readonly counts = new Map<string, number>()

  constructor(private reviewEveryUserTurns = 15) {
    this.updateReviewEveryUserTurns(reviewEveryUserTurns)
  }

  updateReviewEveryUserTurns(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('reviewEveryUserTurns must be a positive integer')
    }
    this.reviewEveryUserTurns = value
  }

  handleEvent(sessionId: string, event: LifecycleSessionEvent): boolean {
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {}
    const source = data.source && typeof data.source === 'object'
      ? data.source as Record<string, unknown>
      : undefined
    const turnId = typeof data.turnId === 'string' && data.turnId
      ? data.turnId
      : typeof data.turn === 'number' || typeof data.turn === 'string'
        ? String(data.turn)
        : this.currentTurns.get(sessionId) ?? sessionId
    if (event.type === 'turn/start') {
      this.currentTurns.set(sessionId, turnId)
      return false
    }
    if (event.type === 'user/message' && source?.kind === 'user') {
      if (this.counted.get(sessionId)?.has(turnId)) return false
      this.pending.set(sessionId, (this.pending.get(sessionId) ?? new Set()).add(turnId))
      if (!this.completed.get(sessionId)?.delete(turnId)) return false
      return this.complete(sessionId, turnId)
    }
    const isTurnEnd = event.type === 'turn/end' || event.type === 'agent/turn' || event.type === 'turn/completed'
    if (!isTurnEnd) return false
    const reason = data.reason && typeof data.reason === 'object' ? data.reason as Record<string, unknown> : {}
    const completed = event.type === 'turn/completed' || data.status === 'completed' || reason.kind === 'completed'
    const pending = this.pending.get(sessionId)
    if (!completed) {
      pending?.delete(turnId)
      return false
    }
    if (this.counted.get(sessionId)?.has(turnId)) return false
    if (!pending?.delete(turnId)) {
      this.completed.set(sessionId, (this.completed.get(sessionId) ?? new Set()).add(turnId))
      return false
    }
    return this.complete(sessionId, turnId)
  }

  private complete(sessionId: string, turnId: string): boolean {
    this.counted.set(sessionId, (this.counted.get(sessionId) ?? new Set()).add(turnId))
    const count = (this.counts.get(sessionId) ?? 0) + 1
    this.counts.set(sessionId, count)
    return count % this.reviewEveryUserTurns === 0
  }
}

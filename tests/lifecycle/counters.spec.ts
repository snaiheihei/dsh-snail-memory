import { describe, expect, it } from 'vitest'
import { CompletedTurnCounter } from '../../src/lifecycle/counters.js'

describe('CompletedTurnCounter', () => {
  it('deduplicates repeated user/completed pairs and counts per session', () => {
    const counter = new CompletedTurnCounter(1)
    expect(counter.handleEvent('a', { type: 'user/message', data: { turnId: '1', source: { kind: 'user' } } })).toBe(false)
    expect(counter.handleEvent('a', { type: 'turn/end', data: { turnId: '1', reason: { kind: 'completed' } } })).toBe(true)
    expect(counter.handleEvent('a', { type: 'user/message', data: { turnId: '1', source: { kind: 'user' } } })).toBe(false)
    expect(counter.handleEvent('a', { type: 'turn/end', data: { turnId: '1', reason: { kind: 'completed' } } })).toBe(false)
    expect(counter.handleEvent('b', { type: 'user/message', data: { turnId: '1', source: { kind: 'user' } } })).toBe(false)
    expect(counter.handleEvent('b', { type: 'turn/end', data: { turnId: '1', reason: { kind: 'completed' } } })).toBe(true)
  })

  it('updates the review threshold without resetting completed turn counts', () => {
    const counter = new CompletedTurnCounter(10)
    for (const turn of [1, 2]) {
      counter.handleEvent('a', { type: 'user/message', data: { turnId: String(turn), source: { kind: 'user' } } })
      expect(counter.handleEvent('a', { type: 'turn/end', data: { turnId: String(turn), reason: { kind: 'completed' } } })).toBe(false)
    }

    counter.updateReviewEveryUserTurns(3)
    counter.handleEvent('a', { type: 'user/message', data: { turnId: '3', source: { kind: 'user' } } })
    expect(counter.handleEvent('a', { type: 'turn/end', data: { turnId: '3', reason: { kind: 'completed' } } })).toBe(true)
  })
})

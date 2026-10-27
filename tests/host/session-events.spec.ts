import { describe, expect, it } from 'vitest'
import { CompletedTurnCounter } from '../../src/lifecycle/counters.js'

function user(source = 'user') {
  return { type: 'user/message', data: { source: { kind: source }, content: [{ type: 'text', text: 'hello' }] } }
}

describe('dsh Session turn events', () => {
  it('counts real turn/end completed events and excludes injected context', () => {
    const counter = new CompletedTurnCounter(2)
    const events: boolean[] = []
    for (const turn of [1, 2]) {
      events.push(counter.handleEvent('session-1', { type: 'turn/start', data: { turn } }))
      events.push(counter.handleEvent('session-1', user()))
      events.push(counter.handleEvent('session-1', user('snail-memory')))
      events.push(counter.handleEvent('session-1', { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }))
    }

    expect(events).toEqual([false, false, false, false, false, false, false, true])
  })

  it('does not review aborted or failed dsh turns', () => {
    const counter = new CompletedTurnCounter(1)
    counter.handleEvent('session-1', { type: 'turn/start', data: { turn: 1 } })
    counter.handleEvent('session-1', user())

    expect(counter.handleEvent('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })).toBe(false)
    expect(counter.handleEvent('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })).toBe(false)
  })
})

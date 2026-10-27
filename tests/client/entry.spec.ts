// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, MEMORY_PANEL_ID } from '../../client/src/entry.js'
import { t } from './fixtures.js'

interface Registration {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

function fakeContext() {
  const registrations: Registration[] = []
  const cleanups: Array<() => void> = []
  const ctx = {
    effect(effect: () => void | (() => void)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return vi.fn()
    },
    slots: {
      inject(slot: string, register: () => unknown) { return register() },
      register(options: Record<string, unknown>, component: unknown) {
        const registration = { slot: options.name as string, options, component }
        registrations.push(registration)
        return () => { registrations.splice(registrations.indexOf(registration), 1) }
      },
    },
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => t),
    },
  }
  return { ctx: ctx as unknown as Context, registrations, cleanups }
}

afterEach(() => { document.head.innerHTML = '' })

describe('client slot registration', () => {
  it('uses the actual composer, sidebar, and main slots with one panel key', () => {
    const host = fakeContext()
    apply(host.ctx)

    const composer = host.registrations.find(row => row.slot === 'conversation.input.left')
    const sidebar = host.registrations.find(row => row.slot === 'sidebar.panellist')
    const main = host.registrations.find(row => row.slot === 'main')
    expect(composer?.options).toMatchObject({ name: 'conversation.input.left', id: 'snail-memory' })
    expect(sidebar?.options.id).toBe(MEMORY_PANEL_ID)
    expect(main?.options.key).toBe(MEMORY_PANEL_ID)
    expect(sidebar?.options.id).toBe(main?.options.key)
    expect(host.cleanups.length).toBeGreaterThan(0)
  })

  it('cleans registered effects and injected styles when unloaded', () => {
    const host = fakeContext()
    apply(host.ctx)
    expect(document.head.querySelector('[data-snail-memory-styles]')).not.toBeNull()

    for (const cleanup of host.cleanups) cleanup()
    expect(document.head.querySelector('[data-snail-memory-styles]')).toBeNull()
  })
})

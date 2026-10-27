// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { installMemoryStyles, MEMORY_STYLES } from '../../client/src/styles.js'

describe('memory styles', () => {
  it('constrains page overflow and includes a narrow mobile layout', () => {
    expect(MEMORY_STYLES).toContain('@media (max-width: 480px)')
    expect(MEMORY_STYLES).toContain('min-width: 0')
    expect(MEMORY_STYLES).toContain('overflow-wrap: anywhere')
  })

  it('injects one owned style element and removes it on cleanup', () => {
    const cleanup = installMemoryStyles(document)
    const style = document.head.querySelector('[data-snail-memory-styles]')
    expect(style).not.toBeNull()
    expect(document.head.querySelectorAll('[data-snail-memory-styles]')).toHaveLength(1)
    cleanup()
    expect(document.head.querySelector('[data-snail-memory-styles]')).toBeNull()
  })
})

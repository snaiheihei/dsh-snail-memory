import { describe, expect, it } from 'vitest'
import { chunkMemoryDetail } from '../../src/store/chunks.js'

describe('chunkMemoryDetail', () => {
  it('keeps details at the threshold unchunked', () => {
    expect(chunkMemoryDetail('a'.repeat(8_000))).toEqual([])
  })

  it('splits large details deterministically without losing characters', () => {
    const detail = `${'alpha '.repeat(700)}\n\n${'beta '.repeat(700)}\n${'gamma'.repeat(700)}`

    const first = chunkMemoryDetail(detail)
    const second = chunkMemoryDetail(detail)

    expect(detail.length).toBeGreaterThan(8_000)
    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)
    expect(first.map(chunk => chunk.text).join('')).toBe(detail)
    expect(first.every(chunk => chunk.text.length > 0 && chunk.text.length <= 4_000)).toBe(true)
    expect(first.map(chunk => chunk.id)).toEqual(first.map((_, index) => `part-${String(index + 1).padStart(3, '0')}`))
  })

  it('prefers a paragraph boundary near the hard limit', () => {
    const detail = `${'a'.repeat(3_990)}\n\n${'b'.repeat(4_100)}`

    const chunks = chunkMemoryDetail(detail)

    expect(chunks[0]?.text).toBe(`${'a'.repeat(3_990)}\n\n`)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(detail)
    expect(chunks.every(chunk => chunk.text.length <= 4_000)).toBe(true)
  })

  it('hard-splits large details that have no whitespace', () => {
    const detail = 'x'.repeat(8_001)

    const chunks = chunkMemoryDetail(detail)

    expect(chunks.map(chunk => chunk.text.length)).toEqual([4_000, 4_000, 1])
    expect(chunks.map(chunk => chunk.text).join('')).toBe(detail)
  })
})

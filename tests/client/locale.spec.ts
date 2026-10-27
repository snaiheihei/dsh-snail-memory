import { describe, expect, it } from 'vitest'
import { copy, translator } from '../../client/src/locale.js'

describe('memory copy', () => {
  it('provides complete typed English and Chinese dictionaries', () => {
    expect(Object.keys(copy.zh).sort()).toEqual(Object.keys(copy.en).sort())
    expect(translator('zh')('deleteSuccess')).toContain('未删除对话历史')
    expect(translator('en')('estimatedTokens')).toContain('Estimated')
    expect(translator('zh')('estimatedTokens')).toContain('估算')
  })
})

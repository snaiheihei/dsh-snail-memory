import { describe, expect, it } from 'vitest'
import { redactDetectedCredentials, sanitizeBeforeUse } from '../../src/safety/redact.js'

describe('sanitizeBeforeUse', () => {
  it('redacts supported credential forms with typed placeholders', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'c'.repeat(20)}.${'d'.repeat(30)}`
    const input = [
      `jwt: ${jwt}`,
      'Authorization: Bearer abcdef1234567890',
      'https://user:secret-password@example.test',
      'client_secret = "client-secret-123"',
    ].join('\n')

    const result = sanitizeBeforeUse(input)

    expect(result.text).toContain('[REDACTED:jwt]')
    expect(result.text).toContain('[REDACTED:authorization]')
    expect(result.text).toContain('[REDACTED:url-password]')
    expect(result.text).toContain('[REDACTED:token]')
    expect(result.text).not.toContain(jwt)
    expect(result.text).not.toContain('abcdef1234567890')
    expect(result.text).not.toContain('secret-password')
    expect(result.text).not.toContain('client-secret-123')
    expect(result.findings.length).toBeGreaterThanOrEqual(4)
  })

  it('redacts complete authorization values including multi-field schemes', () => {
    const result = sanitizeBeforeUse('Authorization: Digest username="alice", response="abcdef123456"')

    expect(result.text).toBe('Authorization: [REDACTED:authorization]')
    expect(result.text).not.toContain('abcdef123456')
  })

  it('redacts each overlapping secret only once', () => {
    const result = redactDetectedCredentials('api_key="sk-abcdefghijklmnop1234"')

    expect(result.text).toBe('api_key="[REDACTED:api-key]"')
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'api-key', action: 'redact' }),
    ])
  })
})

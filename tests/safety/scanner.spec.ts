import { describe, expect, it } from 'vitest'
import { scanSecrets } from '../../src/safety/scanner.js'
import { sanitizeBeforeUse } from '../../src/safety/redact.js'
import { SafetyError } from '../../src/safety/types.js'

describe('secret scanner', () => {
  it('detects JWTs, common API keys, URL passwords, authorization headers, and token assignments with ranges', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(20)}.${'b'.repeat(30)}`
    const input = [
      `jwt=${jwt}`,
      'apiKey="sk-live-abc123def456ghi789"',
      'https://alice:p%40ssw0rd@example.test/path',
      'Authorization: Bearer abcdef1234567890',
      'refresh_token = "refresh-1234567890"',
    ].join('\n')

    const result = scanSecrets(input)

    expect(result.findings.map((finding) => finding.kind)).toEqual([
      'jwt',
      'api-key',
      'url-password',
      'authorization',
      'token',
    ])
    for (const finding of result.findings) {
      expect(finding.start).toBeGreaterThanOrEqual(0)
      expect(finding.end).toBeGreaterThan(finding.start)
      expect(finding.action).toBe('redact')
      expect(JSON.stringify(finding)).not.toContain('p%40ssw0rd')
      expect(JSON.stringify(finding)).not.toContain('abcdef1234567890')
      expect(JSON.stringify(finding)).not.toContain('refresh-1234567890')
    }
    const jwtResult = scanSecrets(`JWT ${jwt}`)
    expect(jwtResult.findings).toEqual([
      expect.objectContaining({ kind: 'jwt', action: 'redact' }),
    ])
  })

  it('detects OpenAI, GitHub, Slack, Google, and AWS key formats', () => {
    const input = [
      `sk-${'a'.repeat(20)}`,
      `sk_live_${'a'.repeat(20)}`,
      `ghp_${'a'.repeat(30)}`,
      `github_pat_${'a'.repeat(25)}`,
      `AIza${'a'.repeat(35)}`,
      `xoxb-${'a'.repeat(20)}`,
      `AKIA${'A'.repeat(16)}`,
    ].join(' ')

    const result = scanSecrets(input)
    expect(result.findings).toHaveLength(7)
    expect(result.findings.every((finding) => finding.kind === 'api-key')).toBe(true)
  })

  it('rejects complete private-key blocks without exposing key material', () => {
    const secretBody = 'not-a-real-private-key-body'
    const input = `before\n-----BEGIN PRIVATE KEY-----\n${secretBody}\n-----END PRIVATE KEY-----\nafter`

    const result = scanSecrets(input)
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'private-key', action: 'reject' }),
    ])
    expect(JSON.stringify(result)).not.toContain(secretBody)

    let thrown: unknown
    try {
      sanitizeBeforeUse(input)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SafetyError)
    expect(thrown).toMatchObject({ code: 'unsafe-content', kind: 'private-key' })
    expect(String(thrown)).not.toContain(secretBody)
    expect(JSON.stringify(thrown)).not.toContain(secretBody)
  })

  it('redacts all repeated secrets and preserves non-secret Unicode text', () => {
    const input = '密码 token=abc123xyz；再来 token=abc123xyz'
    const result = sanitizeBeforeUse(input)

    expect(result.text).toBe('密码 token=[REDACTED:token]；再来 token=[REDACTED:token]')
    expect(result.findings).toHaveLength(2)
    expect(result.text).not.toContain('abc123xyz')
    expect(JSON.stringify(result.findings)).not.toContain('abc123xyz')
  })

  it('redacts URL passwords while retaining non-secret URL components', () => {
    const result = sanitizeBeforeUse('open https://alice:p%40ssw0rd@example.test/a?x=密码')

    expect(result.text).toBe('open https://alice:[REDACTED:url-password]@example.test/a?x=密码')
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'url-password', action: 'redact' }),
    ])
  })

  it('redacts the complete value when username and password are identical', () => {
    const result = sanitizeBeforeUse('https://alice:alice@example.test')
    expect(result.text).toBe('https://alice:[REDACTED:url-password]@example.test')
  })

  it('detects camelCase assignment names without redacting identifiers in ordinary code', () => {
    expect(sanitizeBeforeUse('accessToken = abcdef123456').text).toBe('accessToken = [REDACTED:token]')
    expect(sanitizeBeforeUse('const accessToken = getAccessToken()').text).toBe('const accessToken = getAccessToken()')
  })

  it('does not flag ordinary cryptographic terms, project paths, or normal code', () => {
    const input = [
      'Discuss private key cryptography and JWT validation.',
      'Open src/auth/private-key-utils.ts and docs/token-design.md.',
      'const token = getToken()',
      'const password = null',
      'Visit https://example.test/a/b?query=value',
    ].join('\n')

    expect(scanSecrets(input).findings).toEqual([])
    expect(sanitizeBeforeUse(input).text).toBe(input)
  })

  it('enforces a deterministic scan budget before returning content', () => {
    const input = `${'x'.repeat(100)} token=abc123xyz`
    let thrown: unknown
    try {
      scanSecrets(input, { maxChars: 64 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(SafetyError)
    expect(thrown).toMatchObject({ code: 'scan-limit' })
    expect(String(thrown)).not.toContain('abc123xyz')
    expect(scanSecrets(input, { maxChars: input.length }).findings).toHaveLength(1)
  })

  it('rejects large private-key blocks within the scan budget', () => {
    const input = `-----BEGIN PRIVATE KEY-----\n${'x'.repeat(70_000)}\n-----END PRIVATE KEY-----`

    expect(() => sanitizeBeforeUse(input)).toThrow(SafetyError)
    expect(scanSecrets(input).findings[0]).toMatchObject({ kind: 'private-key', action: 'reject' })
  })

  it('rejects overlong credential assignments instead of silently missing them', () => {
    const secret = 'a'.repeat(513)
    const input = `refresh_token = ${secret}`

    expect(scanSecrets(input).findings).toEqual([
      expect.objectContaining({ kind: 'token', action: 'reject' }),
    ])
    expect(() => sanitizeBeforeUse(input)).toThrow(SafetyError)
    expect(JSON.stringify(scanSecrets(input))).not.toContain(secret)
  })

  it('rejects unterminated private-key blocks without exposing their contents', () => {
    const secretBody = 'unterminated-secret-key-body'
    const input = `-----BEGIN PRIVATE KEY-----\n${secretBody}`

    expect(scanSecrets(input).findings).toEqual([
      expect.objectContaining({ kind: 'private-key', action: 'reject' }),
    ])
    expect(() => sanitizeBeforeUse(input)).toThrow(SafetyError)
    expect(JSON.stringify(scanSecrets(input))).not.toContain(secretBody)
  })

  it('does not let an overlapping redaction hide a rejected credential', () => {
    const secret = 'a'.repeat(513)
    const input = `Authorization: refresh_token=${secret}`

    expect(scanSecrets(input).findings).toEqual([
      expect.objectContaining({ kind: 'token', action: 'reject' }),
    ])
    expect(() => sanitizeBeforeUse(input)).toThrow(SafetyError)
    expect(JSON.stringify(scanSecrets(input))).not.toContain(secret)
  })

  it('handles long benign input within the default budget', () => {
    const result = scanSecrets('数据'.repeat(100_000))
    expect(result.findings).toEqual([])
  })
})

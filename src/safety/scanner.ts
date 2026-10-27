import type { RedactionFinding, ScanOptions, ScanResult, SecretKind } from './types.js'
import { SafetyError } from './types.js'

const DEFAULT_MAX_CHARS = 1_000_000
const MAX_PRIVATE_KEY_BLOCK_CHARS = DEFAULT_MAX_CHARS

interface PatternRule {
  readonly kind: SecretKind
  readonly pattern: RegExp
}

const JWT_PATTERN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{8,2048}(?![A-Za-z0-9_-])/g
const API_KEY_PATTERN = /(?<![A-Za-z0-9_-])(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,256}|sk_(?:live|test)_[A-Za-z0-9]{16,256}|gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|AIza[0-9A-Za-z_-]{30,40}|xox[baprs]-[A-Za-z0-9-]{10,255}|(?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Za-z0-9_-])/g
const PRIVATE_KEY_PATTERN = /(?:^|\r?\n)-----BEGIN ([A-Z0-9 ]{0,32}PRIVATE KEY)-----/g
const URL_PASSWORD_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{1,1024})@/gi
const AUTHORIZATION_PATTERN = /\bAuthorization[ \t]*:[ \t]*([^\r\n]{1,4096})/gi
const ASSIGNMENT_PATTERN = /(?:^|[\s,;{])(?<key>api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\s*(?:=|:)\s*(?:(?<quote>['"`])(?<quoted>[^'"`\r\n]{4,512})\k<quote>|(?<bare>[A-Za-z0-9_./+~!#$%^&*?=-]{8,512})(?![A-Za-z0-9_./+~!#$%^&*?=-])(?!\s*\())/gi
const RULES: readonly PatternRule[] = [
  { kind: 'jwt', pattern: JWT_PATTERN },
  { kind: 'api-key', pattern: API_KEY_PATTERN },
  { kind: 'url-password', pattern: URL_PASSWORD_PATTERN },
  { kind: 'authorization', pattern: AUTHORIZATION_PATTERN },
]

function privateKeyFindings(input: string): RedactionFinding[] {
  const findings: RedactionFinding[] = []
  for (const match of input.matchAll(PRIVATE_KEY_PATTERN)) {
    const keyType = match[1]
    const matchIndex = match.index
    if (keyType === undefined || matchIndex === undefined) {
      continue
    }
    const contentStart = matchIndex + match[0].length
    const endMarker = `-----END ${keyType}-----`
    const endMarkerIndex = input.indexOf(endMarker, contentStart)
    if (endMarkerIndex >= 0 && endMarkerIndex - contentStart <= MAX_PRIVATE_KEY_BLOCK_CHARS) {
      findings.push({
        kind: 'private-key',
        start: matchIndex + (match[0].startsWith('\r\n') ? 2 : match[0].startsWith('\n') ? 1 : 0),
        end: endMarkerIndex + endMarker.length,
        action: 'reject',
      })
    }
  }
  return findings
}

function patternFindings(input: string, rule: PatternRule): RedactionFinding[] {
  const findings: RedactionFinding[] = []
  for (const match of input.matchAll(rule.pattern)) {
    if (match.index === undefined) {
      continue
    }
    const value = match[1]
    const start = match.index + (value === undefined ? 0 : match[0].lastIndexOf(value))
    findings.push({ kind: rule.kind, start, end: start + (value ?? match[0]).length, action: 'redact' })
  }
  return findings
}

function assignmentFindings(input: string): RedactionFinding[] {
  const findings: RedactionFinding[] = []
  for (const match of input.matchAll(ASSIGNMENT_PATTERN)) {
    if (match.index === undefined) {
      continue
    }
    const groups = match.groups
    const value = groups?.quoted ?? groups?.bare
    if (value === undefined) {
      continue
    }
    const valueStart = match[0].lastIndexOf(value)
    const start = match.index + Math.max(0, valueStart)
    findings.push({
      kind: groups?.key?.toLowerCase().includes('api') ? 'api-key' : 'token',
      start,
      end: start + value.length,
      action: 'redact',
    })
  }
  return findings
}

function overlaps(left: RedactionFinding, right: RedactionFinding): boolean {
  return left.start < right.end && right.start < left.end
}

export function scanSecrets(input: string, options: ScanOptions = {}): ScanResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new SafetyError('Invalid scan budget', 'scan-limit')
  }
  if (input.length > maxChars) {
    throw new SafetyError('Input exceeds the secret scan budget', 'scan-limit')
  }

  const candidates: RedactionFinding[] = [...privateKeyFindings(input)]
  for (const rule of RULES) {
    candidates.push(...patternFindings(input, rule))
  }
  candidates.push(...assignmentFindings(input))
  candidates.sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start))

  const findings: RedactionFinding[] = []
  for (const candidate of candidates) {
    if (!findings.some((finding) => overlaps(finding, candidate))) {
      findings.push(candidate)
    }
  }
  return { findings }
}

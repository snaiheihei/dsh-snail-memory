export type SecretKind = 'private-key' | 'jwt' | 'api-key' | 'url-password' | 'authorization' | 'token'
export type FindingAction = 'redact' | 'reject'

export interface RedactionFinding {
  readonly kind: SecretKind
  readonly start: number
  readonly end: number
  readonly action: FindingAction
}

export interface ScanResult {
  readonly findings: readonly RedactionFinding[]
}

export interface SanitizedText {
  readonly text: string
  readonly findings: readonly RedactionFinding[]
}

export interface ScanOptions {
  readonly maxChars?: number
}

export type SafetyErrorCode = 'unsafe-content' | 'scan-limit' | 'source-rejected' | 'invalid-metadata'

export class SafetyError extends Error {
  readonly code: SafetyErrorCode
  readonly findings: readonly RedactionFinding[]
  readonly kind?: SecretKind

  constructor(message: string, code: SafetyErrorCode, findings: readonly RedactionFinding[] = [], kind?: SecretKind) {
    super(message)
    this.name = 'SafetyError'
    this.code = code
    this.findings = findings
    if (kind !== undefined) {
      this.kind = kind
    }
  }
}

export type AcquisitionMode = 'automatic' | 'explicit'
export type SourceRejectionReason = 'automatic-requires-session'

export interface SourceAdmission {
  readonly allowed: boolean
  readonly reason?: SourceRejectionReason
}

export interface MemoryCandidateOptions {
  readonly source: string
  readonly mode?: AcquisitionMode
}

export interface UntrustedContextOptions {
  readonly capturedAt?: Date | string | number
  readonly now?: Date | string | number
}

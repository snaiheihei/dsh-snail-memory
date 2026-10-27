import { scanSecrets } from './scanner.js'
import type { SanitizedText, ScanOptions } from './types.js'
import { SafetyError } from './types.js'

export function redactDetectedCredentials(input: string, options: ScanOptions = {}): SanitizedText {
  const { findings } = scanSecrets(input, options)
  if (findings.some((finding) => finding.action === 'reject')) {
    throw new SafetyError('Unsafe content was rejected without retaining secret material', 'unsafe-content', findings, 'private-key')
  }

  let cursor = 0
  let text = ''
  for (const finding of findings) {
    text += input.slice(cursor, finding.start)
    text += `[REDACTED:${finding.kind}]`
    cursor = finding.end
  }
  text += input.slice(cursor)
  return { text, findings }
}

export function sanitizeBeforeUse(input: string, options: ScanOptions = {}): SanitizedText {
  return redactDetectedCredentials(input, options)
}

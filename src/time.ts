const BEIJING_OFFSET_MS = 8 * 3_600_000

export function formatBeijingTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const beijing = new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 19)
  return `${beijing.replace('T', ' ')} +08:00`
}

/** Date and minute in Beijing time: the seconds and the offset are noise in a list. */
export function formatBeijingMinute(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
}

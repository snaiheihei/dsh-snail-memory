const BEIJING_OFFSET_MS = 8 * 3_600_000

export function formatBeijingTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const beijing = new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 19)
  return `${beijing.replace('T', ' ')} +08:00`
}

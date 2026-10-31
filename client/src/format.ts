/** Thousands separators without asking the Host which locale it renders in. */
export function formatCount(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)))
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return value < 0 ? `-${grouped}` : grouped
}

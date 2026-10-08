/** 0 to 999 as is, then 1.2k and 12k. Rounds down, so it never claims stars the repo doesn't have. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${Math.floor(n / 100) / 10}k`
  return `${Math.floor(n / 1000)}k`
}

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })

/** "2026-10-08" becomes "October 8, 2026" in every time zone. */
export function formatDate(isoDate: string): string {
  return dateFormat.format(new Date(`${isoDate}T00:00:00Z`))
}

/** "0.1.0" becomes "0.1". */
export function latestVersionLabel(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

/** 14230 -> "14.2k", 132000 -> "132k", 1200000 -> "1.2M". Under 1,000 as is, and one decimal under 100k, which a .0 drops. The context popover and the long-chat banner (KERNEL-426) share it. */
export function formatTokens(n: number): string {
  const short = (v: number, unit: string) => `${v < 100 ? Math.round(v * 10) / 10 : Math.round(v)}${unit}`
  if (n < 1000) return String(n)
  if (n < 1_000_000) return short(n / 1000, 'k')
  return `${Math.round(n / 100_000) / 10}M`
}

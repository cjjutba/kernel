/** 14230 -> "14k", 1500 -> "1.5k", 1200000 -> "1.2M". Under 1,000 as is. The context popover and the long-chat banner (KERNEL-426) share it. */
export function formatTokens(n: number): string {
  const short = (v: number, unit: string) => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}${unit}`
  if (n < 1000) return String(n)
  if (n < 1_000_000) return short(n / 1000, 'k')
  return `${Math.round(n / 100_000) / 10}M`
}

export function formatShort(n: number): string {
  const rounded = Math.round(n)
  if (rounded < 1000) return String(rounded)
  return `${(rounded / 1000).toFixed(1).replace(/\.0$/, "")}k`
}

export function computeSessionSaved(
  current: { total_saved: number },
  baseline: { total_saved: number } | null
): number | null {
  if (baseline === null) return null
  return Math.max(0, current.total_saved - baseline.total_saved)
}

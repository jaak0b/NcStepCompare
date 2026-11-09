/** A duration in seconds as hours, minutes and seconds, for example "2 h 44 min 53 s". */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h} h ${m} min ${s} s`
}

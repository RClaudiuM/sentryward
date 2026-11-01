const UNITS: [Intl.RelativeTimeFormatUnit, number, number][] = [
  ["minute", 60_000, 60],
  ["hour", 3_600_000, 24],
  ["day", 86_400_000, Infinity],
]

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

export function timeAgo(iso: string, now = Date.now()) {
  const diff = new Date(iso).getTime() - now
  // An unparseable timestamp yields NaN; keep the old "just now" fallback.
  if (Number.isNaN(diff)) return "just now"
  const abs = Math.abs(diff)
  if (abs < 60_000) return "just now"

  const sign = Math.sign(diff)
  for (const [unit, ms, max] of UNITS) {
    const value = Math.round(abs / ms)
    if (value < max) return format.format(sign * value, unit)
  }
  // Unreachable: "day" has no cap.
  return "just now"
}

// A calendar date in the viewer's locale, e.g. "Oct 31, 2026".
export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
}

export function localDateStamp(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

// Short elapsed time, e.g. "42s", "3m 05s", "1h 02m", "2d 04h".
export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`
}

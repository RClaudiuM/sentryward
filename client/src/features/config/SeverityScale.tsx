import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

type Status = "blocks" | "reported" | "hidden"

const STATUS: Record<Status, { label: string; className: string }> = {
  blocks: { label: "Blocks", className: "border-destructive/40 bg-destructive/10 text-destructive" },
  reported: { label: "Reported", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  hidden: { label: "Hidden", className: "border-dashed bg-transparent text-muted-foreground" },
}

// What each severity does under a report floor and a block level. The
// severities come most severe first (SEVERITIES in server/src/review/core/severity.ts),
// so a lower index ranks higher. Findings under the floor are dropped before
// the verdict (below_floor in server/src/review/validate/validator.ts), so a
// hidden severity never blocks, whatever the block level says.
function severityStatuses(severities: string[], floor: string, blockOn: string) {
  const floorRank = severities.indexOf(floor)
  const blockRank = severities.indexOf(blockOn)
  return severities.map((severity, rank) => ({
    severity,
    status: (rank > floorRank ? "hidden" : rank <= blockRank ? "blocks" : "reported") as Status,
  }))
}

// The two severity choices drawn as one scale, so "reported" and "blocks" read
// together. Each segment says its status in words, not only in color.
export function SeverityScale(props: { severities: string[]; floor?: string; blockOn?: string; className?: string }) {
  const { severities, floor, blockOn } = props
  if (!floor || !blockOn || !severities.includes(floor) || !severities.includes(blockOn)) return null
  // A block level under the floor reads as stricter than it is: those findings
  // are dropped first, so blocking really starts at the floor.
  const blockBelowFloor = severities.indexOf(blockOn) > severities.indexOf(floor)
  return (
    <div className={cn("flex flex-col gap-2", props.className)}>
      <ol
        aria-label="Severity scale"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${severities.length}, minmax(0, 1fr))` }}
      >
        {severityStatuses(severities, floor, blockOn).map(({ severity, status }) => (
          <li
            key={severity}
            className={cn("flex min-w-0 flex-col rounded-md border px-2 py-1.5 text-xs", STATUS[status].className)}
          >
            <span className="truncate font-medium capitalize">{severity}</span>
            <span className="sr-only">: </span>
            <span className="truncate">{STATUS[status].label}</span>
          </li>
        ))}
      </ol>
      {blockBelowFloor && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          Blocking starts at {floor}: {blockOn} findings are under the report level, so they are dropped before they can block.
        </p>
      )}
    </div>
  )
}

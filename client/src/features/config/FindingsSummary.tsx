import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SeverityScale } from "./SeverityScale"

export interface FindingsSummaryProps {
  severities: string[]
  floor?: string
  blockOn?: string
  categories?: string[]
  categoryCount: number
  maxFindings?: number
  minConfidence?: number
  verifyLabel?: string
  context?: string
  contextLabel?: string
  agent?: { maxSteps?: number; maxToolTokens?: number; maxSearches?: number }
  fileContext?: boolean
  impactDepth?: number
  toolFindings?: boolean
  toolFindingsBlock?: boolean
  // Repository scope only: how many of this tab's fields it overrides, and
  // how many the repository file sets (which win over both).
  overrides?: number
  fromFile?: number
  repoFile?: string | null
}

const UNKNOWN = "..."

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-right font-medium">{props.children}</dd>
    </div>
  )
}

const onOff = (value: boolean | undefined) => (value === undefined ? UNKNOWN : value ? "On" : "Off")
const shown = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? UNKNOWN : String(value))

// What a review does with the Finding Types settings, unsaved edits included,
// so the tab's answer is readable without scanning every field. Values are
// resolved by the caller (repository file, then the form, then inherited).
export function FindingsSummary(props: FindingsSummaryProps) {
  const agentic = props.context === "agentic"
  const categories = props.categories
  return (
    <Card role="region" aria-label="Findings summary" className="@6xl:sticky @6xl:top-18">
      <CardHeader>
        <CardTitle>Summary</CardTitle>
        <CardDescription>What a review reports and blocks on with these settings, including unsaved edits.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <SeverityScale severities={props.severities} floor={props.floor} blockOn={props.blockOn} />
        <dl className="divide-y">
          <Row label="Categories">
            {categories ? `${categories.length} of ${props.categoryCount}` : UNKNOWN}
          </Row>
          {categories && categories.length > 0 && (
            <div className="flex flex-wrap gap-1 py-2" aria-hidden>
              {categories.map((category) => (
                <Badge key={category} variant="secondary" className="capitalize">
                  {category}
                </Badge>
              ))}
            </div>
          )}
          <Row label="Max findings">{shown(props.maxFindings)}</Row>
          <Row label="Min confidence">{shown(props.minConfidence)}</Row>
          <Row label="Verify">{props.verifyLabel ?? UNKNOWN}</Row>
          <Row label="Context">{props.contextLabel ?? UNKNOWN}</Row>
          {agentic && props.agent && (
            <Row label="Agent limits">
              {shown(props.agent.maxSteps)} steps, {shown(props.agent.maxSearches)} searches
            </Row>
          )}
          <Row label="Surrounding code">
            {props.fileContext
              ? `On, ${shown(props.impactDepth)} caller hop${props.impactDepth === 1 ? "" : "s"}`
              : onOff(props.fileContext)}
          </Row>
          <Row label="Static analysis">
            {props.toolFindings
              ? props.toolFindingsBlock
                ? "On, can block"
                : "On, never blocks"
              : onOff(props.toolFindings)}
          </Row>
        </dl>
        {(props.overrides !== undefined || Boolean(props.fromFile)) && (
          <p className="text-xs text-muted-foreground">
            {props.overrides !== undefined &&
              `${props.overrides} ${props.overrides === 1 ? "setting" : "settings"} overridden in this repository.`}
            {Boolean(props.fromFile) &&
              ` ${props.fromFile} set in ${props.repoFile ?? ".sentryward.yaml"}, which wins over these settings.`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

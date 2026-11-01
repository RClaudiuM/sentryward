import type { ReactNode } from "react"
import { Link } from "react-router"
import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useTestLlmModel, type ModelCapability, type ModelTestResult } from "@/features/llm-connections/api"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import { useModelPriceLookup, type ModelPrice } from "@/features/model-prices/api"
import type { LlmProviderName } from "./api"

const THINKING_SUPPORT_LABEL: Record<string, string> = {
  options: "thinking options",
  model: "the model thinks by itself",
  none: "no thinking",
}

// What probes and reviews found the model that will run supports, so an
// override is only set when that is wrong. The separators are screen-reader
// text so the chips still read (and match) as one sentence.
function DetectedCapabilities(props: { model: string; capability: ModelCapability | undefined; loading: boolean }) {
  if (!props.model) return null
  const { capability } = props
  let detail: ReactNode
  if (props.loading) detail = "Checking what was detected..."
  else if (!capability || (capability.thinking === null && capability.tools === null))
    detail = "Not detected yet. Test the model to detect it."
  else {
    const thinking = capability.thinking === null ? "thinking unknown" : THINKING_SUPPORT_LABEL[capability.thinking]
    const tools = capability.tools === null ? "tools unknown" : capability.tools ? "tools work" : "no tools"
    detail = (
      <span className="inline-flex flex-wrap gap-1 align-middle">
        <Badge variant="secondary">{thinking}</Badge>
        <span className="sr-only">, </span>
        <Badge variant="secondary">{tools}</Badge>
        <span className="sr-only">.</span>
      </span>
    )
  }
  return (
    <p className="text-sm text-muted-foreground" data-testid="detected-capabilities">
      <span className="sr-only">Detected for {props.model}: </span>
      {detail}
    </p>
  )
}

const TEST_FAILURE: Record<Extract<ModelTestResult, { ok: false }>["reason"], string> = {
  revoked: "the key was rejected",
  model: "the connection cannot run this model",
  unreachable: "the connection could not be reached",
  output: "the reply was not usable",
}

// Runs one call against the connection that will run the review, without saving.
function ModelTest(props: { provider: LlmProviderName | null; model: string }) {
  // The caller keys this by provider and model, so a result never outlives what was tested.
  const test = useTestLlmModel()
  const target = props.provider && props.model
  const result = test.data?.result
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.provider && test.mutate({ provider: props.provider, model: props.model })}
          disabled={!target || test.isPending}
          title={props.provider ? undefined : "Select an LLM connection to test the model"}
        >
          {test.isPending && <Loader2 className="animate-spin" />}
          Test model
        </Button>
      </div>
      <div role="status" className="text-xs">
        {result?.ok && (
          <span className="text-muted-foreground">Works: answered in {result.latencyMs.toLocaleString()} ms.</span>
        )}
        {result && !result.ok && (
          <span className="text-destructive">
            Failed, {TEST_FAILURE[result.reason]}: {result.message}
          </span>
        )}
        {test.isError && <span className="text-destructive">{test.error.message}</span>}
      </div>
    </div>
  )
}

const usd = (value: number) => `$${value.toFixed(2)}`

// What the effective model costs, or where to set a price when none is known.
function ModelPriceHint(props: { model: string }) {
  const lookup = useModelPriceLookup(props.model)
  if (!props.model || lookup.isPending || lookup.isError) return null
  const price: ModelPrice | null = lookup.data.price
  return (
    <p className="text-xs text-muted-foreground">
      {price ? (
        `${usd(price.input)} input / ${usd(price.output)} output per million tokens.`
      ) : (
        <>
          No price set for this model.{" "}
          <Link className="underline underline-offset-4" to="/llm-connections">
            Set model prices
          </Link>
          .
        </>
      )}
    </p>
  )
}

function Row(props: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground uppercase">{props.term}</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-sm">{props.children}</dd>
    </div>
  )
}

const tokens = (value: number) => `${value.toLocaleString("en-US")} tokens`

// The LLM tab's sticky aside: what a review would run with, unsaved edits
// included, gathered in one place instead of spread under the fields. Every
// value is computed by ConfigFields; this only lays it out.
export function LlmRunSummary(props: {
  provider: LlmProviderName | null
  // Why the connection may fail right now, if it might.
  attention?: string
  model: string
  fallbacks: string[]
  thinkingLabel?: string
  // The auto ceiling (undefined until the schema and model are known) and a typed override.
  autoBudget?: { budget: number }
  typedBudget?: number
  capability: ModelCapability | undefined
  capabilityLoading: boolean
}) {
  const { provider, model } = props
  const budget = props.typedBudget ?? props.autoBudget?.budget
  const overflows = props.typedBudget !== undefined && props.autoBudget && props.typedBudget > props.autoBudget.budget
  return (
    <Card role="region" aria-label="What will run" className="@6xl:sticky @6xl:top-18">
      <CardHeader>
        <CardTitle>What will run</CardTitle>
        <CardDescription>What a review would use with these settings, including unsaved edits.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-4">
          <Row term="Connection">
            {provider ? (
              <span className="flex flex-wrap items-center gap-2">
                {LLM_PROVIDERS[provider].label}
                {props.attention && <Badge variant="destructive">{props.attention}</Badge>}
              </span>
            ) : (
              <span className="text-muted-foreground">None selected</span>
            )}
          </Row>
          <Row term="Model">
            {model ? <code className="break-all">{model}</code> : <span className="text-muted-foreground">Not set</span>}
            <ModelPriceHint model={model} />
            <DetectedCapabilities model={provider ? model : ""} capability={props.capability} loading={props.capabilityLoading} />
            <ModelTest key={`${provider}:${model}`} provider={provider} model={model} />
          </Row>
          <Row term="Fallbacks">
            {props.fallbacks.length ? (
              <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Fallback order">
                {props.fallbacks.map((fallback, index) => (
                  <li key={index} className="flex items-center gap-1">
                    {index > 0 && <span aria-hidden className="text-muted-foreground">-&gt;</span>}
                    <code className="break-all">{fallback}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Row>
          <Row term="Thinking">{props.thinkingLabel ?? <span className="text-muted-foreground">Unknown</span>}</Row>
          <Row term="Context budget">
            {budget === undefined ? (
              <span className="text-muted-foreground">Unknown</span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                {tokens(budget)}
                {props.typedBudget === undefined ? " (auto)" : ""}
                {overflows && <Badge variant="destructive">Over the window</Badge>}
              </span>
            )}
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

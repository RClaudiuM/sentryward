import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { SeverityScale } from "./SeverityScale"

const SEVERITIES = ["critical", "major", "minor", "info"]

const statuses = () =>
  within(screen.getByRole("list", { name: "Severity scale" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent)

describe("SeverityScale", () => {
  it("marks what blocks, what is reported and what is hidden", () => {
    render(<SeverityScale severities={SEVERITIES} floor="minor" blockOn="major" />)
    expect(statuses()).toEqual(["critical: Blocks", "major: Blocks", "minor: Reported", "info: Hidden"])
    expect(screen.queryByText(/Blocking starts at/)).not.toBeInTheDocument()
  })

  it("hides a severity under the floor even when the block level covers it", () => {
    render(<SeverityScale severities={SEVERITIES} floor="major" blockOn="info" />)
    expect(statuses()).toEqual(["critical: Blocks", "major: Blocks", "minor: Hidden", "info: Hidden"])
    expect(screen.getByText(/Blocking starts at major/)).toBeInTheDocument()
  })

  it("renders nothing until both levels are known", () => {
    const { container } = render(<SeverityScale severities={SEVERITIES} floor={undefined} blockOn="major" />)
    expect(container).toBeEmptyDOMElement()
  })
})

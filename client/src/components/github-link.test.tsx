import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import { GITHUB_REPO_URL, GitHubLink } from "./github-link"
import { renderWithProviders } from "@/test/renderWithProviders"

describe("GitHubLink", () => {
  it("opens the repository in a new tab", () => {
    renderWithProviders(<GitHubLink />)

    const link = screen.getByRole("link", { name: "Sentryward on GitHub" })
    expect(link).toHaveAttribute("href", GITHUB_REPO_URL)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link.getAttribute("rel")).toContain("noopener")
  })
})

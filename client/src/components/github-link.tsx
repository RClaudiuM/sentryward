import { GitHubIcon } from "@/features/forge/icons"
import { Button } from "@/components/ui/button"

export const GITHUB_REPO_URL = "https://github.com/rdlugs/sentryward"

export function GitHubLink() {
  return (
    <Button variant="ghost" size="icon" asChild>
      <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
        <GitHubIcon className="size-4" />
        <span className="sr-only">Sentryward on GitHub</span>
      </a>
    </Button>
  )
}

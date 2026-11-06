# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sentryward is an AI code reviewer for GitHub PRs and GitLab MRs: a React SPA (`client/`), an Express 5 + Prisma 7 API (`server/`), a review worker (same `server/` codebase, `src/worker`), and PostgreSQL 17. README.md documents the API endpoints, forge setup, publishing behaviour, the `.sentryward.yaml` format and the review quality evals; CONTRIBUTING.md covers conventions and change-specific processes.

## Commands

Everything runs in Docker Compose (`cp .env.example .env`, set `JWT_SECRET` and `ENCRYPTION_KEY`, then `docker compose up --build`). Run tests and tooling inside the containers:

```sh
docker compose exec server npm test                      # migrates sentryward_test, then vitest run
docker compose exec server npm test -- tests/repos.test.ts   # single file
docker compose exec server npm test -- -t "name of test"     # single test by name
docker compose exec server npm run typecheck

docker compose exec client npm test                      # vitest + jsdom
docker compose exec client npx vitest run src/pages/reviews/reviews.test.tsx
docker compose exec client npm run typecheck
docker compose exec client npm run lint                  # oxlint

# schema change: edit server/prisma/schema.prisma, then
docker compose exec server npx prisma migrate dev --name <change>

# review quality evals (real model calls, costs money, never part of npm test)
docker compose exec worker npm run eval -- --model anthropic/claude-sonnet-5-5 [--case a,b] [--context static|agentic] [--compare]
```

- Server tests hit a real Postgres database (`sentryward_test`, created by `docker/postgres/init-test-db.sh`) and run with `fileParallelism: false`. `server/vitest.config.ts` injects a throwaway GitHub App config.
- The `server` container applies migrations and regenerates the Prisma client on start; the client is generated into `server/src/generated/prisma` (an anonymous volume, so regenerate inside the container, not on the host).
- The server runs TypeScript directly with `tsx` (no build step). Imports use explicit `.ts` extensions.

## Architecture

### Request path (API)

`server/src/app.ts` mounts `routes/*.routes.ts` -> `controllers/*.controller.ts`. Controllers parse input with zod schemas from `schemas/`, throw `HttpError` (`lib/httpError.ts`) for expected failures, and rely on `middleware/errorHandler.ts` to turn `ZodError` into `400 { message, errors: fieldErrors }`. The client's `ApiError.fieldErrors` (`client/src/lib/api.ts`) maps those back onto react-hook-form fields. Auth is a JWT in an httpOnly cookie; `requireAuth` sets `req.userId`. Data belongs to workspaces, not users: `middleware/requireWorkspace.ts` resolves `req.workspaceId` from the `x-sentryward-workspace` header (falling back to the user's personal workspace) and re-reads membership on every request, `requireWorkspaceRole` gates by role, and data access is always scoped by workspace (e.g. `loadWorkspaceConnection` in `services/forge.ts`, `loadOwnedRepo`/`loadOwnedReview` in controllers). LLM keys are stored per workspace too.

The webhook router is mounted **before** `express.json()` because signature checks need the raw body.

### Review jobs

Reviews are rows in `review_jobs`, queued by the API (manual URL, rerun, webhook, or `/sentryward review` comment) and executed by the worker:

- `worker/index.ts`: poll loop for review jobs and thread replies, plus periodic retention. `worker/queue.ts` claims jobs with `FOR UPDATE SKIP LOCKED`, enforces per-**workspace** concurrency (env var is still named `WORKER_USER_CONCURRENCY`), recovers stale locks.
- `worker/runJob.ts`: loads repo + connection, fetches the change from the forge, resolves config, decides skip reasons (trigger settings are checked here, not in the webhook handler), runs the review, publishes, stores the result. Dependencies are injectable (`RunJobDeps`) for tests.
- `worker/incremental.ts` decides whether a push can be reviewed incrementally (and records why not); `worker/syncFindings.ts` tracks finding lifecycle across runs; `worker/closeWatch.ts` aborts model calls when a review is cancelled or its change is closed/merged mid-run.
- Thread replies (a question asked on a Sentryward comment) are a separate queue: `worker/replyQueue.ts` (same SKIP LOCKED claim) -> `worker/runReply.ts` -> `review/llm/threadAnswer.ts`.
- `worker/retention.ts` deletes or trims old job rows per the privacy policy (`services/privacyPolicy.ts`).
- `review/pipeline.ts` (`runReview`): pure apart from model calls. Classifies/ignores files, plans chunks within a token budget, runs passes concurrently (static context, or agentic passes that call repo-reading tools when `review.context` is agentic) plus an optional walkthrough, validates findings, computes status (`completed`/`partial`/`failed`) and verdict. Failures inside a review are recorded in the result, not thrown.

### `server/src/review/` (the engine, no DB or HTTP framework)

- `config/`: layered config resolution (trigger overrides > `.sentryward.yaml` from the PR's **base** revision > dashboard repo settings > workspace global settings > profile > defaults), with per-field source tracking. Rules are the exception to "higher layer replaces": each layer can only add rules, so a repo file cannot loosen what the workspace requires.
- `rules.ts`: team rules. Pattern rules are checked without a model; the rest go into the prompt and come back as model findings naming the rule.
- `diff/`, `context/`: diff parsing, language detection, ignore globs, context gathering, token budgeting and chunking.
- `llm/`: prompts, zod output schemas, and `providers.ts`, which wraps the Vercel AI SDK behind a `Generate` function. Models are named `provider/model` (`anthropic`, `openai`, `google`, `ollama`; OpenAI-compatible base URLs are supported). Keys come from env or the workspace's stored keys (`services/llm.ts`). `agentic.ts`/`agenticReview.ts` run tool-calling passes.
- `agent/tools.ts`: the repo-reading tools agentic passes may call. Everything they return is PR-author content, so treat it as untrusted.
- `validate/`, `core/`: finding validation (drop/demote), severity, verdict, fingerprints (dedupe across runs via hidden markers in forge comments).
- `render/`: markdown/JSON output; the summary comment is exactly `GET /api/reviews/:id/markdown`.
- `publish/`: inline comments, summary comment, `sentryward/review` commit status, each step independent.
- `forge/`: per-forge adapters (fetch change, publish, hooks) and `providers.ts` (`FORGE_INFO`: URL parsing, suggestion syntax).
- `preview/`: what a review of a sample change would post under a given config, built from the same pieces as `publish/publisher.ts` so it cannot drift from real output.

### Two forge layers

Forges are split between `review/forge/` (pipeline-facing, no app concerns) and `services/providers/` (connecting accounts, GitHub App install flow, webhooks, encrypted credentials). Both are `Record<ForgeProvider, ...>` so adding a forge is compiler-guided; the step list is in the comment at the top of `server/src/review/forge/providers.ts` (Prisma enum + migration, adapter, both registries, and `client/src/features/forge/providers.tsx`).

### Client

Vite + React 19 + React Router + TanStack Query, shadcn/ui in `src/components/ui` (generated, edit sparingly). Pages in `src/pages/<area>`, feature modules (API hooks, forms, components) in `src/features/<area>`. `/api` is proxied to the server by Vite. Tests use `src/test/renderWithProviders.tsx` and stub the API via `src/test/apiRoutes.ts` / `fixtures.ts`.

### Testing conventions (server)

- `tests/helpers/fetchStub.ts` replaces `fetch` with a route table; unmatched requests throw, so tests never reach real forges.
- `tests/helpers/model.ts` fakes the `Generate` function instead of calling an LLM.
- `tests/helpers/users.ts` creates a user and returns an auth cookie for supertest.
- `tests/__snapshots__/review.md` is the rendered-markdown snapshot.
- `server/evals/` is a separate corpus of cases scored against a real model (`npm run eval`); see README "Review quality evals" for adding a case.

## Style

- Server: semicolons, double quotes. Client: no semicolons, double quotes in app code, `@/` alias for `src/`.
- Comments explain *why* (constraints, ordering, security decisions), matching the existing tone; keep that density.

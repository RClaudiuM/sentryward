# Contributing to Sentryward

Sentryward is pre-1.0. For questions and ideas, start a
[discussion](https://github.com/rdlugs/sentryward/discussions) explaining what you
tried and what you need. Follow the [code of conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Contents

- [Your first pull request](#your-first-pull-request)
- [Finding something to work on](#finding-something-to-work-on)
- [Development](#development)
- [Code style](#code-style)
- [Branches and commits](#branches-and-commits)
- [Required checks](#required-checks)
- [Changes with their own process](#changes-with-their-own-process)
- [Changelog](#changelog)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Pull requests](#pull-requests)
- [For maintainers](#for-maintainers)

## Your first pull request

1. Fork the repository and clone your fork.
2. Run `cp .env.example .env`, then set `JWT_SECRET` and `ENCRYPTION_KEY`, each
   generated with `openssl rand -hex 32`. Keep `NODE_ENV=development`.
3. Start everything with `docker compose up --build`.
4. Create a branch, make your change, and run the [required checks](#required-checks).
5. Push the branch and open a pull request against `main`.

The [getting started instructions](README.md#getting-started) cover the setup in
more detail.

## Finding something to work on

Issues labelled
[good first issue](https://github.com/rdlugs/sentryward/labels/good%20first%20issue)
are small and well scoped. Comment on an issue to claim it before you start, so
two people do not fix the same thing.

Typos, documentation fixes, and small bug fixes with an obvious cause can go
straight to a pull request. Open an issue or discussion first for:

- new features or changed default behavior
- schema changes
- new forges
- changes to prompts or the review pipeline
- new dependencies
- breaking changes to configuration, `.sentryward.yaml`, or the API

Agreeing on the approach first avoids rewriting a finished patch.

## Development

Install Docker with Compose and follow the steps above. No forge or model keys
are needed for automated tests. Tests stub forge requests and model calls.

[CLAUDE.md](CLAUDE.md) is the architecture guide for everyone, not only for coding
agents: it covers the request path, review jobs, the review engine, the forge
layers, and the testing helpers. Read [AGENTS.md](AGENTS.md) too if you use a
coding agent. The client is a React SPA, the API is Express, the review engine
lives in `server/src/review`, and the worker shares the server codebase.

Source is mounted into the containers. Rebuild after dependency changes and
include the corresponding lockfile. Keep secrets and personal repository data
out of patches, logs, screenshots, and fixtures.

If the setup fails, start with [troubleshooting](README.md#troubleshooting).

## Code style

Follow the surrounding code. The essentials:

- **Server:** semicolons and double quotes. Imports use explicit `.ts`
  extensions, since the server runs TypeScript directly with `tsx`. Controllers
  stay thin: they parse input with zod schemas from `schemas/` and throw
  `HttpError` for expected failures. Data access is always scoped to its owner.
- **Client:** no semicolons, double quotes, and the `@/` alias for `src/`. The
  shadcn components in `src/components/ui` are generated, so edit them sparingly.
  `npm run lint` runs oxlint (`client/.oxlintrc.json`).
- **Comments** explain *why*: constraints, ordering, and security decisions.
  Match the density of the code around them.

## Branches and commits

Name branches `<type>/<short-slug>`, with the issue number when there is one,
for example `fix/issue-212-worker-shutdown-requeue` or
`feat/104-finding-lifecycle`.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
as `type(scope): summary`, with the issue number when the commit fixes one:

```
fix(worker): requeue unfinished reviews on shutdown (#212)
feat(config): ...
```

Types in use are `feat`, `fix`, `docs`, `test`, `perf`, `ci`, and `chore`.
Common scopes include `client`, `server`, `worker`, `review`, `reviews`,
`config`, `forge`, `github`, `gitlab`, `auth`, `security`, `accounts`,
`workspaces`, `webhooks`, `repos`, `llm-connections`, `docker`, `deps`, and
`changelog`. The list is not fixed: pick the area your change touches.

## Required checks

With Docker services running:

```sh
docker compose exec -T server npm test
docker compose exec -T server npm run typecheck
docker compose exec -T client npm test
docker compose exec -T client npm run typecheck
docker compose exec -T client npm run lint
docker compose exec -T client npm run build
```

`-T` disables TTY allocation, which scripts and CI need. You can drop it when
running the commands yourself.

Server tests apply existing migrations to the separate `sentryward_test` database.
Never point `TEST_DATABASE_URL` at a database containing data you need to keep.
Client tests use jsdom. Add focused regression coverage for behavior changes;
use existing fetch and model stubs rather than real external services.

### Faster loop

While working, run only the tests you are touching:

```sh
docker compose exec server npm test -- tests/repos.test.ts       # one file
docker compose exec server npm test -- -t "name of test"         # one test by name
docker compose exec client npx vitest run src/pages/reviews/reviews.test.tsx
```

The client checks need neither the database nor the API, so for client-only work
you can start just the client with `docker compose up --no-deps client`, as CI
does. Run the full set of required checks before opening the pull request.

## Changes with their own process

### Schema changes

Edit the Prisma schema and generate a named migration inside Docker as documented
in [database changes](README.md#database-changes). Include the migration in the
proposal and explain compatibility and data consequences. Do not rewrite
migrations already applied by other contributors.

The Prisma client is generated into `server/src/generated/prisma`, which is an
anonymous volume in the container. Regenerate it inside the container: running
`prisma generate` on the host does not update what the server uses.

### Review quality

The tests use a fake model, so they cannot tell whether a change to prompts,
chunking, context, or validation in `server/src/review` makes reviews better or
worse. For those changes, run the [review quality evals](README.md#review-quality-evals),
ideally with `--compare` or a before and after run, and paste the precision and
recall summary into the pull request with the model you used. Evals call a paid
API and are not part of CI, so if you could not run them, say so.

### Adding a forge

Follow the numbered steps in the comment at the top of
`server/src/review/forge/providers.ts`. Both forge registries are keyed by
`ForgeProvider`, so the compiler points at whatever is still missing.

## Changelog

Add an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a
user, operator, or API client would notice: behavior, configuration keys,
environment variables, API responses, the UI, migrations, and security fixes.
Refactors, tests, CI, and internal docs do not need one.

Use the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) subsections
(`Added`, `Changed`, `Fixed`, `Removed`, `Security`), and add an `Upgrade notes`
entry for anything an operator must act on when upgrading. Write for users, not
reviewers, and reference the issue.

## AI-assisted contributions

AI tools are welcome, and you do not need to disclose using them. You are
responsible for every line you submit: understand it, be able to explain it, and
actually run the required checks and report their results honestly. Coding agents
should read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md).

## Pull requests

- Explain the concrete problem and resulting behavior, linking the relevant issue.
- Keep the patch focused, follow surrounding code style, and update affected docs.
- Record checks run and disclose any failures or checks you could not run.
- Preserve third-party notices. Submit only code and assets you have permission to
  contribute under the project's [MIT license](LICENSE).
- Add a [changelog](#changelog) entry for user-visible changes.

GitHub Actions repeats the required checks in Docker for pull requests and pushes
to `main`, using disposable development credentials. A passing client build
verifies the frontend output; it does not certify a production deployment.

### Review

Maintainers review pull requests as time allows. If a pull request has had no
response for a week, leave a comment on it. Push follow-up commits to the same
branch, and rebase on `main` when asked or when conflicts appear.

## For maintainers

Use the [release checklist](docs/RELEASE_CHECKLIST.md) for verification results,
audit findings, and the remaining publication steps.

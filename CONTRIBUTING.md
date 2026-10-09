# Contributing & Git workflow

Solo-friendly **GitHub Flow**: `main` is always deployable; all work happens on short-lived branches merged via pull request with green CI.

## Branches

- `main` — protected, always releasable. Never commit directly.
- Feature branches off `main`, named `type/short-description`:
  - `feat/charity-project-creation`, `fix/score-decay-off-by-one`, `chore/ci-cache`, `docs/adr-0002`.

## Workflow

1. `git switch -c feat/my-thing`
2. Build with tests (TDD encouraged). Keep commits small and focused.
3. Push and open a PR into `main`. Fill in the PR template.
4. CI (lint, typecheck, tests, build, audit, CodeQL) must pass.
5. Squash-merge. Delete the branch.

## Commit messages

Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
Example: `feat(scoring): compute momentum with 7-day half-life`.

## Recommended branch protection for `main`

Set once in GitHub → Settings → Branches:

- Require a pull request before merging.
- Require status checks to pass: `verify`, `audit`, `analyze` (CodeQL).
- Require branches to be up to date before merging.
- Require linear history; disallow force pushes and deletions.

## Local setup

```bash
docker compose up -d                 # Postgres + MailHog
cp .env.example .env.local           # then fill APP_ENCRYPTION_KEY + SESSION_SECRET
npm install
npm run db:migrate
npm run dev                          # web on :3000
npm run worker                       # background worker (separate terminal)
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # APP_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # SESSION_SECRET
```

# Orbit Economica Bug Reporter

Cloudflare Worker API for in-game bug reporting. Players file bugs from the OER PauseMenu modal, which POSTs directly to this worker. The worker creates Linear issues with attachments. It also exposes authenticated admin endpoints for triage, so the backend is operational without giving Linear credentials to the client.

## Architecture

```
OER PauseMenu / desktop crash page
  → POST FormData (description, steps, severity, version, platform, saveGame?, logs?)
    → Cloudflare Worker (this repo, deployed via wrangler)
      → Linear GraphQL API (create issue)
      → GitHub Gist API (host save game / screenshot / crash logs)
      → Linear GraphQL API (attach gist URL)
```

## Secrets (set via `wrangler secret put`)

- `LINEAR_API_KEY` — Linear API key for creating issues and attachments
- `GITHUB_TOKEN` — GitHub PAT with gist scope for hosting save game files
- `ADMIN_TOKEN` — optional dedicated bearer token for admin triage endpoints. Until set, the existing `LINEAR_API_KEY` also works as a break-glass admin credential.

## Vars (in wrangler.toml)

- `LINEAR_TEAM_ID` — Orbit Economica team in Linear
- `LINEAR_BUG_LABEL_ID` — "Bug" label ID

## Admin API

All admin routes require `Authorization: Bearer <ADMIN_TOKEN>`:

- `GET /admin/health` — backend/secret readiness without exposing secret values
- `GET /admin/issues?limit=25` — list bug-labelled Linear issues, newest updates first
- `PATCH /admin/issues/:identifier` — update `title`, `description`, `priority`, `stateId`, or `assigneeId`

`OPTIONS` allows the `Authorization` header for browser-based admin tooling. The public client never receives or uses this credential.

## Deployment

```bash
wrangler deploy
```

## History

Originally had a separate Cloudflare Pages static HTML form. Migrated to inline PauseMenu modal in OER on Jun 13 2026 (commit 3ad7560a). The worker was simplified from form+API hybrid to pure API. Attachment flow evolved from Linear's native upload (size limits) → R2 (public access issues) → GitHub Gist (current, working).

# Orbit Economica Bug Reporter

Cloudflare Worker API for in-game bug reporting. Players file bugs from the OER PauseMenu modal, which POSTs directly to this worker. The worker creates Linear issues with attachments.

## Architecture

```
OER PauseMenu (BugReportModal)
  → POST FormData (description, steps, severity, version, platform, saveGame?)
    → Cloudflare Worker (this repo, deployed via wrangler)
      → Linear GraphQL API (create issue)
      → GitHub Gist API (host save game / screenshot)
      → Linear GraphQL API (attach gist URL)
```

## Secrets (set via `wrangler secret put`)

- `LINEAR_API_KEY` — Linear API key for creating issues and attachments
- `GITHUB_TOKEN` — GitHub PAT with gist scope for hosting save game files

## Vars (in wrangler.toml)

- `LINEAR_TEAM_ID` — Orbit Economica team in Linear
- `LINEAR_BUG_LABEL_ID` — "Bug" label ID

## Deployment

```bash
wrangler deploy
```

## History

Originally had a separate Cloudflare Pages static HTML form. Migrated to inline PauseMenu modal in OER on Jun 13 2026 (commit 3ad7560a). The worker was simplified from form+API hybrid to pure API. Attachment flow evolved from Linear's native upload (size limits) → R2 (public access issues) → GitHub Gist (current, working).

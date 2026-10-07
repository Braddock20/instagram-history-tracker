# Instagram History Tracker — 2.0.0

A privacy-first historical Instagram follower/following analytics app built for Cloudflare Workers + Neon Postgres. It does **not** require B2 or any permanent ZIP storage.

## What this final build does

- Browser-parses Instagram export ZIPs so the original ZIP is ephemeral and is not stored.
- Discovers follower/following JSON files, including split follower files.
- Normalizes usernames, removes duplicates and ignores deleted placeholders.
- Stages normalized usernames in Neon in chunks.
- Finalizes imports asynchronously through Cloudflare Queues when the binding is configured.
- Keeps immutable historical snapshots rather than overwriting old data.
- Infers four relationship events: followed you, unfollowed you, you followed, you unfollowed.
- Correctly treats event times as a window between snapshots, never a fake exact timestamp.
- Maintains one persistent exclusion list per Instagram account.
- Exclusions affect presentation/analytics but never delete historical facts.
- Provides current followers, following, mutuals, non-follow-backs, never-followed-back vs used-to-follow classification, growth, churn, relationship history, snapshot-to-snapshot comparison, people search and CSV change export.
- Detects duplicate ZIPs with SHA-256 before creating another snapshot.
- Provides retryable failed imports and an audit log.
- Includes a server-side ZIP fallback for smaller files; the browser workflow is the preferred path.

## Architecture

```text
Browser
  ├─ ZIP parser (fflate)
  ├─ SHA-256
  └─ normalized username chunks
             │
             ▼
Cloudflare Worker / Hono
  ├─ API + auth
  └─ Queue producer
             │
             ▼
Cloudflare Queue
  └─ finalize import
             │
             ▼
Neon Postgres
  ├─ accounts
  ├─ imports
  ├─ staged usernames (temporary)
  ├─ snapshots
  ├─ people
  ├─ follower/following snapshot relationships
  ├─ inferred events
  ├─ persistent exclusions
  └─ audit log
```

Cloudflare documents Queues as the background/batching primitive for deferred processing, with retries and DLQs; the current Queue limits include 128 KB messages, up to 100 messages per batch, and consumer execution up to 15 minutes, so this project queues only a tiny import ID rather than the ZIP itself. 

Neon’s serverless driver is designed for Cloudflare Workers and other edge/serverless environments. 

## Setup

1. Create a Neon Postgres database.
2. Run `migrations/001_initial.sql` in the Neon SQL editor.
3. Install dependencies:

```bash
npm install
```

4. Create `.dev.vars` from `.dev.vars.example`.
5. For production, set the database secret:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put API_KEY
```

6. Create the queues:

```bash
npx wrangler queues create instagram-history-imports
npx wrangler queues create instagram-history-imports-dlq
```

7. Run locally:

```bash
npm run dev
```

8. Deploy:

```bash
npm run deploy
```

## Important behavior

### Exclusions

Import an exclusion JSON/TXT/CSV once. It is saved in Neon and automatically applied to future analytics. Add/remove entries whenever needed. Clearing exclusions does not alter historical snapshots.

### Historical timestamps

If a person exists in snapshot A and is gone in snapshot B, the system records the event window as `occurred_after = A.observed_at` and `occurred_before = B.observed_at`. It does not claim an exact unfollow date.

### No ZIP archive

The original ZIP is deliberately not stored. The normalized follower/following state is the durable analytical record. If you want future re-parsing of original ZIPs, add object storage later; it is not required for any current analytics feature.

## API overview

- `POST /api/v1/accounts`
- `GET /api/v1/accounts`
- `POST /api/v1/accounts/:id/imports/init`
- `POST /api/v1/accounts/:id/imports/:importId/chunk`
- `POST /api/v1/accounts/:id/imports/:importId/commit`
- `POST /api/v1/accounts/:id/imports/:importId/retry`
- `GET /api/v1/accounts/:id/imports/:importId`
- `GET /api/v1/accounts/:id/imports`
- `GET /api/v1/accounts/:id/snapshots`
- `GET /api/v1/accounts/:id/snapshots/compare?from=...&to=...`
- `GET /api/v1/accounts/:id/overview`
- `GET /api/v1/accounts/:id/relationships/{followers|following|mutuals|not-following-back|excluded}`
- `GET /api/v1/accounts/:id/analytics/relationships`
- `GET /api/v1/accounts/:id/analytics/growth`
- `GET /api/v1/accounts/:id/analytics/churn`
- `GET /api/v1/accounts/:id/changes`
- `GET /api/v1/accounts/:id/changes/export.csv`
- `GET /api/v1/accounts/:id/people?q=...`
- `GET /api/v1/accounts/:id/people/:username/history`
- `GET /api/v1/accounts/:id/exclusions`
- `POST /api/v1/accounts/:id/exclusions`
- `POST /api/v1/accounts/:id/exclusions/import`
- `DELETE /api/v1/accounts/:id/exclusions/:username`
- `POST /api/v1/accounts/:id/exclusions/clear`

## Data model principle

`IMPORT` is the upload operation. `SNAPSHOT` is the immutable normalized state at an observation time. `EVENT` is an inference from two snapshots. The database therefore remains useful even though the ZIP itself is discarded.

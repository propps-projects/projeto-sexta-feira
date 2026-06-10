# Disaster Recovery Plan — Askine

Last revised: 2026-06-09 (Phase 5.6.b)

This document describes how Askine recovers from infrastructure failures. It exists for two audiences:

1. **You / future-you / on-call**: a checklist for "the database is on fire, what do I do".
2. **Customers asking about uptime guarantees** (Enterprise tier): proof there is a plan.

It is intentionally short. The longer the plan, the more nobody reads it under stress.

## RTO / RPO targets

| Tier      | Recovery Time Objective | Recovery Point Objective |
| --------- | ----------------------- | ------------------------ |
| Starter   | best-effort (≤ 24h)     | ≤ 24h data loss          |
| Pro       | ≤ 8h                    | ≤ 24h data loss          |
| Scale     | ≤ 4h                    | ≤ 1h data loss           |
| Enterprise | ≤ 1h (negotiated)      | ≤ 5 min data loss        |

The targets above are aspirational on the current EasyPanel + Supabase stack. They get tighter once a Phase 6 Fly.io migration replaces single-region EasyPanel with multi-region failover.

## What's protected

### Database (Supabase Postgres)

- **Daily automated backups** retained 7 days (Pro tier on Supabase). Point-in-time recovery (PITR) within that 7-day window.
- **Logical export** snapshot triggered manually before any disruptive migration (see "Restore drill" below).
- **Schema in repo**: every column / table / RPC is defined in `migrations/NNN_*.sql`. Re-creating the schema from scratch is a `psql -f` away.

### Application code

- **Single source of truth**: `propps-projects/mcp-agentclass:main` on GitHub. EasyPanel auto-deploys from there.
- **Docker image** is rebuilt from source on every push, so there is no separate registry to back up.
- **Environment variables** in EasyPanel: documented in `.env.example`. Without a backup of the EasyPanel env, restore is recoverable but tedious — every secret (`APP_ENCRYPTION_KEY`, `ADMIN_SESSION_SECRET`, Supabase keys, ValidaPay creds, OpenAI key, Resend key) must be set again before the new instance boots.
  - **Mitigation**: store the env in a password manager (1Password / Bitwarden / `pass`). Quarterly review.

### User-uploaded content

- **Lesson videos**: held by **Panda Video** (per-tenant). Not in our infra. Tenant retains ownership; we just consume via API.
- **Materials (KB) bucket**: Supabase Storage `materials/` bucket. Covered by Supabase's normal storage replication. No additional copy today.

### What is NOT protected

- **Render of transcripts in memory** during ingest. A container restart mid-ingest loses the in-progress job. Recovery: admin re-clicks "Iniciar ingest". This is acceptable for current scale; a BullMQ worker is queued for a future phase.
- **In-flight OAuth code/state** (5-minute TTL). Lost on restart; clients re-initiate the flow.

## Disaster scenarios

### Scenario 1 — Database corruption / accidental DROP TABLE

**Detection:** application errors flooding logs; `/status` shows DB "down" or "degraded".

**Response:**

1. Stop write traffic if possible (suspend in EasyPanel or block /webhooks/* and /signup at the proxy).
2. From Supabase Dashboard → Database → Backups → "Restore". Pick PITR timestamp ≤ 1 minute before the bad event.
3. Restore creates a NEW Supabase project. Update `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in EasyPanel env. Restart container.
4. Verify with the **Restore drill checklist** below before re-enabling writes.

Estimated RTO: 30 min – 2h depending on database size + ops familiarity.

### Scenario 2 — EasyPanel host outage

**Detection:** `https://mcp-infosaas-mcp-agentclass.zdnmrb.easypanel.host/health` not responding; Statuspage of EasyPanel shows incident.

**Response:** if outage > 1h, deploy emergency instance:

1. Provision a fresh container anywhere (Fly.io, Render, even a $5 DigitalOcean droplet).
2. Clone repo, install deps, set the same env vars.
3. Update DNS for `askine.cc` to point at the new host.
4. ValidaPay + Hotmart webhooks already point at our public URL — they keep working through DNS change.

This is documented but never drilled. First drill scheduled before launching Pro tier publicly.

### Scenario 3 — APP_ENCRYPTION_KEY lost

**Detection:** all tenant secrets in `tenants.panda_api_key_enc` and `tenants.hotmart_basic_token_enc` decrypt to `null`; admin "Hottok salvo" UI shows blank state for every tenant.

**Response:** **There is no recovery.** Encrypted tenant secrets are unrecoverable without the key. Action plan:

1. Notify all tenants their integrations need reconnection.
2. Generate a new `APP_ENCRYPTION_KEY` and update EasyPanel env.
3. Mark all `_enc` columns NULL via super-admin.
4. Each tenant re-enters their Panda + Hotmart credentials via `/t/:slug/admin/integrations`.

**Prevention:** the key MUST be backed up in at least one secondary location (your password manager, sealed envelope, whatever — but somewhere). Treat it like a root cert.

### Scenario 4 — Hotmart webhook backlog after our outage

After any incident where our server was down > 5 minutes, Hotmart will have undelivered webhooks queued. Their producer panel exposes the queue.

**Response:** open Hotmart Producer Panel → Configurações → Postback URL → check failures → "Reenviar". Hotmart redelivers in the same order. Our handler is idempotent (PURCHASE_APPROVED with the same `transaction` is a no-op after the first grant), so this is safe.

## Restore drill checklist

The drill exists to confirm the restore PROCEDURE works before you need it for real. Run it quarterly. Mark date in this file at the bottom after each run.

1. **Trigger a backup** in Supabase Dashboard.
2. **Make a small destructive change** in the prod schema (e.g. `INSERT INTO tenants (slug, ...) VALUES ('drill-test', ...)`).
3. **Restore to a new Supabase project** from the backup taken in step 1.
4. **Update `.env.local` only** to point at the restored project.
5. **Boot the app locally** against the restore: `npm run dev`.
6. **Verify:**
   - [ ] `GET /status.json` reports DB up
   - [ ] `GET /pricing` lists plans (proves `plans` table restored)
   - [ ] Demo tenant's `GET /t/demo/admin/login` shows the login form
   - [ ] The `drill-test` row from step 2 should be ABSENT (proving you restored from before, not after, the change)
7. **Clean up:** delete the restored Supabase project.
8. **Document:** add a line below.

### Drill log

| Date       | Operator | Outcome     | Notes                                   |
| ---------- | -------- | ----------- | --------------------------------------- |
| —          | —        | (not yet)   | First drill scheduled before Pro launch |

## On-call playbook references

Linked from `/status` page once incidents start being tracked publicly. For now this doc is the on-call playbook.

# Apps Directory Submission Checklist

The Askine MCP server runs at two endpoints and is submitted to two directories.

| Endpoint | Adapter | Directory                                   |
| -------- | ------- | ------------------------------------------- |
| `/mcp`     | mcpApps | Anthropic Claude.ai MCP Directory           |
| `/mcp-gpt` | appsSdk | OpenAI ChatGPT Apps Directory               |

This doc is the source of truth for what needs to be ready before either submission. Tick items as they get done. Re-run before each new submission attempt — directories iterate their requirements.

## ✅ Already shipped (Phase 6.1 + 6.2 + 6.3)

- [x] Privacy policy at `/privacy` (LGPD-aware)
- [x] Terms of service at `/terms`
- [x] Contact page at `/contact` with support, sales, LGPD, security routes
- [x] About page at `/about`
- [x] Home page at `/` with hero + features + CTA
- [x] Public docs at `/docs` covering onboarding + tool catalog + OAuth
- [x] Public status page at `/status` with live checks
- [x] Pricing page at `/pricing` with Enterprise CTA
- [x] Legal links in footer of every public page
- [x] SVG logo at `/logo.svg`
- [x] Favicon at `/favicon.ico` (SVG)
- [x] Open Graph card at `/og-image.svg` (1200×630 SVG)
- [x] `<meta>` tags for og:title, og:description, og:image on homepage
- [x] OAuth AS metadata (RFC 8414) declares `op_policy_uri`, `op_tos_uri`, `service_documentation`
- [x] OAuth PRM metadata (RFC 9728) declares `resource_documentation`, `resource_policy_uri`, `resource_tos_uri`

## ⚠️ Needs human action

### Branding (designer or you)
- [ ] **Replace placeholder logo** — current `/logo.svg` is a generic gradient "A" mark. Commission or design a real logo (suggested deliverables: 1024×1024 PNG, 512×512 PNG, SVG)
- [ ] **Replace OG image** — current `/og-image.svg` is a text-on-gradient placeholder. Produce a real 1200×630 PNG and update the route to serve it from Supabase Storage or directly bundled
- [ ] **Replace favicon** — output a real 32×32 + 16×16 ICO file in addition to the SVG version

### Screenshots (you, taken from a working Claude.ai connector)
- [ ] **Screenshot 1**: Adding the conector in Claude.ai Settings → Connectors. Show the URL `${PUBLIC_URL}/mcp`
- [ ] **Screenshot 2**: Magic-link login page rendered for the aluno
- [ ] **Screenshot 3**: `list_courses` output in Claude.ai showing 2+ courses across infoprodutores (use demo + a seeded fake tenant)
- [ ] **Screenshot 4**: Aluno asking a question, Claude calling `search_course`, citing aula + timestamp
- [ ] **Screenshot 5**: `play_lesson` tool rendering the video player widget inline in chat
- [ ] **Screenshot 6**: ChatGPT equivalent of #5 (uses the appsSdk adapter at `/mcp-gpt`)

Recommended dimensions per OpenAI: at least 1280×800. Capture in light AND dark theme if your designer wants both.

### Demo video (you, screen recording)
- [ ] **Demo video** — 60–90 seconds. Suggested arc:
  1. Add conector at Claude.ai (5s)
  2. Login with magic link (10s)
  3. `list_courses` (5s)
  4. Ask a question about a specific lesson (15s) — narration in pt-BR
  5. `play_lesson` widget renders, click around the video (20s)
  6. `get_my_progress` showing where the aluno paused (10s)

Format: MP4 H.264, 30fps, ≤ 100 MB. Subtitle/transcription is required by OpenAI.

### Domain (you, DNS provider)
- [x] **Register `askine.cc`** — registered
- [x] Point an A record at the VPS public IP
- [ ] Verify SSL: `certbot --nginx -d askine.cc` provisions Let's Encrypt
- [ ] Update `PUBLIC_URL` env var on the VPS to `https://askine.cc`
- [ ] Re-encrypt nothing — the secret envelope uses `APP_ENCRYPTION_KEY` not the URL
- [ ] Run a `/.well-known/oauth-authorization-server` check — the `issuer` field should change to the new URL

### Legal review (lawyer or accept the AI draft)
- [ ] **Privacy policy** review by a lawyer familiar with LGPD. The current draft is reasonable defaults but should be reviewed before any prospective Enterprise customer asks for a DPA
- [ ] **Terms of service** review by a lawyer. Same caveat
- [ ] **DPA template** (Enterprise-tier) — not yet written; needed before first Enterprise customer signs

### OpenAI-specific
- [ ] **Iframe risk review** — OpenAI flags MCP apps that use iframes for "extra manual review". We DO use an iframe for `/mcp-gpt` (Apps SDK appsSdk adapter shipping to a Panda Video URL). The `GPT_USE_VIDEO=true` flag flips it to `<video>` + hls.js but is experimental. Decide BEFORE submitting: try `GPT_USE_VIDEO=true` and validate that the video plays correctly in ChatGPT, OR submit with the iframe and accept the slower review

### Anthropic-specific
- [ ] **Confirm Claude.ai mounts the widget correctly** in production (not just dev) — there's a known gotcha where Claude collapses MCP-UI widgets to a thin strip without `preferred-frame-size`. We set it but reverify against the current Claude.ai version

## 📋 The actual submission steps

### Anthropic — MCP Directory

1. Open https://github.com/modelcontextprotocol/servers (or wherever the directory PR target moves to)
2. Fork, add a directory entry for Askine. Required fields are usually:
   - Name, description, category, public URL, support contact
   - Auth method (OAuth 2.1 with PKCE)
   - Privacy + Terms URLs (`{PUBLIC_URL}/privacy`, `{PUBLIC_URL}/terms`)
   - Screenshots, demo video (link out, don't bundle)
3. Open PR, address review comments
4. Land

Expected review time: 1–3 weeks based on activity in the directory repo.

### OpenAI — ChatGPT Apps Directory

1. Sign in at https://platform.openai.com/apps (when the directory portal goes live publicly)
2. Create a new app entry. Required fields:
   - Display name, description (short + long), category
   - Public URL (`{PUBLIC_URL}/mcp-gpt` — the Apps SDK endpoint specifically)
   - Logo (1024×1024 PNG)
   - Cover image (real 1200×630 PNG, NOT the SVG placeholder)
   - 4–6 screenshots (1280×800+ PNG)
   - Demo video (mp4, ≤ 100MB, with captions)
   - Privacy URL, Terms URL, Support URL
   - Auth method: OAuth 2.1 with discovery at `/.well-known/oauth-authorization-server`
   - Indicate the iframe situation honestly if you still use the iframe path
3. Submit for review
4. Address OpenAI review feedback. Iframe-using apps typically get more pushback

Expected review time: 2–4 weeks.

## After submission

- Update [project_askine_status.md](../../.claude/projects/-Users-rafaelalmeidasouza-Documents-mcp-agentclass/memory/project_askine_status.md) memory file with submission date + status
- Save a copy of the exact submission text (descriptions, screenshots) to `docs/submissions/{anthropic,openai}/v1/` so the next iteration knows what changed

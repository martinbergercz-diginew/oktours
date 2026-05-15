# ok-tours admin-service

Chat-driven admin for [oktours.cz](https://oktours.cz/). Implements the spec at [`../ADMIN_CHAT_SPEC.md`](../ADMIN_CHAT_SPEC.md).

The client chats in Czech with a Claude instance running on the production VPS. Claude reads the static-HTML repo, drafts an edit, asks the client to confirm, commits to a `staging` branch, and on **Publish** runs a shadow-deploy + smoke test before swapping live content atomically.

---

## Architecture at a glance

```
Browser ──HTTPS──▶ Caddy ──reverse-proxy──▶ admin-service (this) :3000
                                  │  shared-password login (src/auth.js)
                       ┌──────────────────┼────────────────────┐
                       ▼                  ▼                    ▼
                src/server.js        src/agent.js         src/ops/git-ops.js
                  (Fastify)          (Claude loop)         (simple-git +
                       │                  │                  rsync atomic swap)
                       │                  ▼
                       │            src/tools/index.js
                       │            (typed tools, NO bash)
                       │                  │
                       │                  └─→ src/paths.js (allowlist + traversal block)
                       ▼
                  ./public/* (chat UI, vanilla JS)
```

Repos on disk (production):
- `/srv/oktours-repo/` — checked-out `oktours` repo. Claude edits the static-HTML
  site files at the repo root; `admin-service/` (this dir) is off-limits to it.
- `/var/www/oktours-staging/` — rsync target for staging preview.
- `/var/www/oktours-shadow/` — temporary pre-publish dir for smoke testing.
- `/var/www/oktours-previous/` — last-known-good prod for instant rollback.
- `/var/www/oktours/` — current live. Atomic-renamed in/out by `git-ops.js`.

---

## Local development

```bash
cd admin-service
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY, leave DRY_RUN=true.
# Optionally set ADMIN_PASSWORD to test the login (blank = login bypassed in dev).
npm install
npm run dev
# → http://localhost:3000/admin/
```

In dry-run mode:
- `REPO_PATH` defaults to the repo root (this checkout, two levels up). Claude
  edits real site files there via an isolated git worktree.
- Login is bypassed unless `ADMIN_PASSWORD` is set in `.env`.
- Git ops run locally but skip `push`. Use a scratch branch (`git checkout -b admin-test`) if you don't want test commits on `main`.
- `rsync` falls back to `fs.cp` into `data/dev-staging/` and `data/dev-live/`.
- Both are served back at `/_staging/` and `/_live/` so you can click the preview link.
- Email notifications log instead of sending.

To run path-allowlist tests:
```bash
npm test
```

---

## Production deployment (Hetzner VPS, `77.42.39.133`)

### One-time setup
> Full step-by-step is in [VPS_DEPLOY.md](VPS_DEPLOY.md). Short version:

```bash
ssh root@77.42.39.133
adduser --system --home /srv/admin-service oktours-admin

# Clone the oktours repo somewhere Claude can edit:
git clone git@github.com:martinbergercz-diginew/oktours.git /srv/oktours-repo
chown -R oktours-admin:oktours-admin /srv/oktours-repo

# Install admin-service:
cd /srv/oktours-repo/admin-service
npm install --omit=dev

# Create deploy targets:
mkdir -p /var/www/oktours-staging /var/www/oktours-shadow /var/www/oktours-previous
chown -R oktours-admin:caddy /var/www/oktours-*

# Drop the systemd unit (see admin-service.service in this dir):
cp admin-service.service /etc/systemd/system/oktours-admin.service
systemctl daemon-reload
systemctl enable --now oktours-admin

# Caddyfile addition (NOT in this repo — manual edit on /etc/caddy/Caddyfile).
# The admin-service has its own shared-password login, so /admin/* needs NO
# basic_auth — just reverse-proxy it. The staging file_server still gets
# basic_auth since it has no app of its own.
#
#   oktours.diginew.cz {
#       handle_path /admin/* {
#           reverse_proxy 127.0.0.1:3000
#       }
#       handle_path /_staging/* {
#           basic_auth { client <bcrypt-hash> }
#           root * /var/www/oktours-staging
#           file_server
#       }
#       root * /var/www/oktours
#       file_server
#   }

systemctl reload caddy
```

### Updates
```bash
ssh root@77.42.39.133
cd /srv/oktours-repo
git pull
cd admin-service
npm install --omit=dev
systemctl restart oktours-admin
```

---

## Endpoint contract

| Method | Path | Purpose |
|---|---|---|
| GET  | `/admin/login` | Login page (shown to unauthenticated browsers) |
| POST | `/admin/api/login` | Exchange the shared password for a session cookie (`{ password }`) |
| POST | `/admin/api/logout` | Clear the session cookie |
| GET  | `/admin/api/health` | Health probe (also prints repo path + dryRun flag) |
| GET  | `/admin/api/session` | Load chat history + state for resume |
| POST | `/admin/api/chat` | Run one Claude turn (`{ text, squashChoice? }`) |
| POST | `/admin/api/confirm` | Client clicked "Yes, apply" → commit draft to staging |
| POST | `/admin/api/cancel` | Client clicked "No, cancel" → discard draft |
| POST | `/admin/api/publish` | Shadow-deploy + smoke + atomic swap |
| POST | `/admin/api/undo` | Reset staging to main |
| POST | `/admin/api/revert` | Inverse-commit a past commit (`{ commit }`) |
| GET  | `/admin/api/history` | Last 50 commits with hash, date, message |
| POST | `/admin/api/upload` | multipart/form-data; routes by MIME (image/pdf) |

---

## Safety mechanisms (see spec §6 for details)

- **Shared-password login** (`src/auth.js`) — every `/admin` request needs a
  signed, HttpOnly session cookie. Production refuses to start without
  `ADMIN_PASSWORD`. The `/admin/api/redeploy-main` endpoint is exempt (it has
  its own `X-Admin-Token` gate).
- **Typed tools only**, no bash. See `src/tools/index.js`.
- **Path allowlist** (`src/paths.js`) blocks `.git`, `.env`, `.php`, `.sh`, `admin-service/`, path traversal, symlink escapes.
- **PROTECTED_FILES** list — 3 pages, send-mail.php, 5 legal PDFs, robots/sitemap, CLAUDE.md — undeletable.
- **Pre-commit confirmation gate** — Claude calls `propose_change`, the client clicks Yes/No before disk is touched.
- **Destructive-change warning** — `is_destructive: true` triggers the §3.1 hard-stop copy.
- **Squash-on-second-turn** — staging only ever holds ≤1 unpublished commit.
- **Shadow-deploy + smoke** — production never sees broken HTML; bad commits never reach git history.
- **Per-turn budget** — 20 tool calls, 100K tokens, 120s wall-clock.
- **Rate limit** — 30 staging commits / 10 publishes per day.
- **Email notification** to Martin on every publish.

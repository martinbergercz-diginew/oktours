# OK TOURS admin-service — VPS deployment runbook

Target: **Hetzner CX22 at `77.42.39.133`** (Ubuntu 24.04, hostname `oktours-prod`).
Companion to [README.md](README.md) and the spec at [../ADMIN_CHAT_SPEC.md](../ADMIN_CHAT_SPEC.md).

Total time: ~30 min. Most of it is one-time setup; updates after that take seconds.

Each step has a **Why** line (so you can skip if you understand the rationale), the **Commands** to run, and a **Verify** check.

> **Repo note.** The admin-service now lives in the dedicated **`oktours`** repo
> (`github.com/martinbergercz-diginew/oktours`), not the old `prototypes`
> monorepo. The static site is at the repo root; `admin-service/` is a
> subdirectory. There is no `ok-tours/` prefix anymore.

---

## Pre-flight (assumed already true on the VPS)

- Caddy v2 running, listening on :80 and :443.
- PHP-FPM 8.3 running for `send-mail.php`.
- Postfix running for outgoing mail.
- `oktours.diginew.cz` Caddy vhost serving `/var/www/oktours/`.
- SSH access from your laptop as `root@77.42.39.133` using `~/.ssh/id_ed25519`.

If any of those is false, fix it first via the repo-root `CLAUDE.md` before proceeding.

---

## Step 1 — Install Node 20+

**Why:** admin-service uses Node 20 features (`fs/promises.cp`, native `--test`).

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
node --version 2>/dev/null || true
if ! command -v node >/dev/null || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version
REMOTE
```

**Verify:** prints `v20.x.x` or higher.

---

## Step 2 — Create the `oktours-admin` system user

**Why:** service must NOT run as root. Restricting writes to `/srv/oktours-repo`, `/var/www/oktours*` is enforced by file permissions, not just code.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
id oktours-admin 2>/dev/null || \
  adduser --system --group --home /srv/admin-service --shell /usr/sbin/nologin oktours-admin
id oktours-admin
REMOTE
```

**Verify:** prints `uid=...(oktours-admin) gid=...(oktours-admin) groups=...`.

---

## Step 3 — Set up GitHub deploy key for `oktours-admin`

**Why:** admin-service does `git push origin main` and `git push origin staging`. It needs auth that's scoped to JUST the `oktours` repo, not your personal account.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
sudo -u oktours-admin -H bash -c '
  mkdir -p /srv/admin-service/.ssh
  chmod 700 /srv/admin-service/.ssh
  if [ ! -f /srv/admin-service/.ssh/id_ed25519 ]; then
    ssh-keygen -t ed25519 -N "" -f /srv/admin-service/.ssh/id_ed25519 -C "oktours-admin@oktours-prod"
  fi
  cat /srv/admin-service/.ssh/id_ed25519.pub
  ssh-keyscan -H github.com >> /srv/admin-service/.ssh/known_hosts 2>/dev/null
'
REMOTE
```

**Add the printed `ssh-ed25519 …` line as a deploy key** — either via the CLI from your laptop:

```bash
gh repo deploy-key add /dev/stdin --repo martinbergercz-diginew/oktours \
  --title "oktours-admin (VPS)" --allow-write <<< "PASTE_THE_PUBKEY_LINE"
```

…or in the web UI: https://github.com/martinbergercz-diginew/oktours/settings/keys/new — title `oktours-admin (VPS)`, paste the key, **check "Allow write access"**, Add key.

**Verify the key works:**
```bash
ssh root@77.42.39.133 "sudo -u oktours-admin -H ssh -i /srv/admin-service/.ssh/id_ed25519 -T git@github.com"
```
Should print: `Hi martinbergercz-diginew/oktours! You've successfully authenticated…`

---

## Step 4 — Clone the repo

**Why:** admin-service edits files inside this clone. Each `commit_to_staging` runs `git pull --rebase` first to stay in sync with your laptop pushes.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
if [ ! -d /srv/oktours-repo/.git ]; then
  sudo -u oktours-admin -H bash -c '
    git clone git@github.com:martinbergercz-diginew/oktours.git /srv/oktours-repo
    cd /srv/oktours-repo
    git config user.name "OK TOURS admin"
    git config user.email "admin@oktours.cz"
    git branch staging main 2>/dev/null || true
  '
fi
sudo -u oktours-admin git -C /srv/oktours-repo log --oneline -1
REMOTE
```

**Verify:** prints the most recent commit from `main`.

---

## Step 5 — Install admin-service dependencies

**Why:** Production-only deps (`@anthropic-ai/sdk`, `sharp`, `simple-git`, `fastify`, …), no devDeps.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
cd /srv/oktours-repo/admin-service
sudo -u oktours-admin npm ci --omit=dev
REMOTE
```

**Verify:**
```bash
ssh root@77.42.39.133 "ls /srv/oktours-repo/admin-service/node_modules/@anthropic-ai/sdk/package.json && echo OK"
```

---

## Step 6 — Create deploy target directories

**Why:** admin-service rsyncs into these. Permissions: `oktours-admin` owns them so it can write; `caddy` reads them.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
mkdir -p /var/www/oktours-staging /var/www/oktours-shadow /var/www/oktours-previous
# /var/www/oktours/ already exists from the original deploy — leave it.
chown -R oktours-admin:caddy /var/www/oktours-staging /var/www/oktours-shadow /var/www/oktours-previous
# Existing /var/www/oktours/ also needs to be writable by admin-service:
chown -R oktours-admin:caddy /var/www/oktours
chmod -R u+rwX,g+rX /var/www/oktours*
REMOTE
```

**Verify:**
```bash
ssh root@77.42.39.133 "ls -ld /var/www/oktours*"
```
All four dirs should be owned by `oktours-admin:caddy`.

---

## Step 7 — Choose the two secrets

**Why:**
- **`ADMIN_PASSWORD`** — the shared password the client types at `/admin/login`.
  The login itself is handled by the admin-service (`src/auth.js`), not Caddy.
- **`STAGING_PASSWORD` hash** — the staging preview is a plain file_server with
  no app of its own, so Caddy basic-auth still gates it. Generate a bcrypt hash:

```bash
read -s -p "Choose a staging-preview password: " STAGING_PASS
ssh root@77.42.39.133 "caddy hash-password --plaintext '$STAGING_PASS'"
unset STAGING_PASS
```

Copy the printed `$2a$…` hash for the Caddyfile in step 10. Pick the
`ADMIN_PASSWORD` value now too — it goes in the env file in step 9.

---

## Step 8 — Generate the secrets that need randomness

**Why:** `SESSION_SECRET` signs login cookies; `REDEPLOY_TOKEN` gates
`POST /admin/api/redeploy-main` (Caddy auth doesn't apply to `curl localhost:3000`).

```bash
ssh root@77.42.39.133 "echo SESSION_SECRET=\$(openssl rand -hex 32); echo REDEPLOY_TOKEN=\$(openssl rand -hex 32)"
```

Copy both values into `/etc/oktours-admin.env` in the next step.

---

## Step 9 — Create the production env file

**Why:** systemd reads this file at boot. Owned by root, mode 600, so even other users on the box can't read the API key.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
cat > /etc/oktours-admin.env <<'ENV'
# Production env for admin-service. Do NOT commit. Mode 600.

ANTHROPIC_API_KEY=sk-ant-REPLACE_ME
ANTHROPIC_MODEL=claude-sonnet-4-6

PORT=3000
HOST=127.0.0.1
NODE_ENV=production
LOG_LEVEL=info

REPO_PATH=/srv/oktours-repo
STAGING_PATH=/var/www/oktours-staging
SHADOW_PATH=/var/www/oktours-shadow
LIVE_PATH=/var/www/oktours
PREVIOUS_PATH=/var/www/oktours-previous
DATA_DIR=/srv/admin-service/data

STAGING_URL=https://oktours.diginew.cz/_staging/
LIVE_URL=https://oktours.diginew.cz/

NOTIFY_EMAIL=martinbergercz@gmail.com
SMTP_HOST=localhost
SMTP_PORT=25
MAIL_DOMAIN=oktours.cz

# Admin login.
ADMIN_PASSWORD=REPLACE_ME
SESSION_SECRET=REPLACE_ME_FROM_STEP_8

# Server-side redeploy hook (Martin's claude.ai flow).
REDEPLOY_TOKEN=REPLACE_ME_FROM_STEP_8
DRY_RUN=false
ENV
chmod 600 /etc/oktours-admin.env
chown root:root /etc/oktours-admin.env

mkdir -p /srv/admin-service/data
chown -R oktours-admin:oktours-admin /srv/admin-service

nano /etc/oktours-admin.env
REMOTE
```

Replace the four `REPLACE_ME` values: the Anthropic key, `ADMIN_PASSWORD`
(from step 7), and `SESSION_SECRET` + `REDEPLOY_TOKEN` (from step 8). Save
and exit (`Ctrl-O`, `Enter`, `Ctrl-X`).

**Verify:**
```bash
ssh root@77.42.39.133 "stat -c '%a %U:%G %n' /etc/oktours-admin.env"
```
Should print `600 root:root /etc/oktours-admin.env`.

---

## Step 10 — Install the systemd unit

**Why:** Restart-on-failure, boot-on-startup, sandbox via NoNewPrivileges + ProtectSystem.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
cp /srv/oktours-repo/admin-service/admin-service.service /etc/systemd/system/oktours-admin.service
systemctl daemon-reload
systemctl enable --now oktours-admin
sleep 2
systemctl status oktours-admin --no-pager -l | head -15
REMOTE
```

**Verify:**
```bash
ssh root@77.42.39.133 "curl -s http://127.0.0.1:3000/admin/api/health"
```
Should print: `{"ok":true,"dryRun":false,"repo":"/srv/oktours-repo","version":"0.1.0","authEnabled":true}`

If `dryRun` is true or `authEnabled` is false, the env file didn't apply — check `/etc/oktours-admin.env`.

---

## Step 11 — Update Caddyfile

**Why:** Two new routes on the existing `oktours.diginew.cz` vhost:
- `/admin/*` → reverse-proxy to admin-service. **No basic_auth** — the service
  has its own shared-password login.
- `/_staging/*` → file_server for the staging preview, behind basic_auth
  (it's a plain static dir, no app of its own). Path-based, so it needs **no
  extra DNS record**.

Open the Caddyfile:
```bash
ssh root@77.42.39.133 "nano /etc/caddy/Caddyfile"
```

Edit the existing `oktours.diginew.cz` block so it looks like this:

```caddyfile
oktours.diginew.cz {
    encode gzip
    log {
        output file /var/log/caddy/access.log
    }

    # NEW — admin chat UI + API. App-level login, no basic_auth here.
    handle /admin/* {
        reverse_proxy 127.0.0.1:3000
    }

    # NEW — staging preview. Plain file_server, so Caddy gates it.
    handle_path /_staging/* {
        basic_auth {
            client PASTE_BCRYPT_HASH_FROM_STEP_7
        }
        root * /var/www/oktours-staging
        file_server
    }

    # Existing PHP form handler.
    handle /send-mail.php {
        root * /var/www/oktours
        php_fastcgi unix//run/php/php8.3-fpm.sock
    }

    # Everything else: static files.
    handle {
        root * /var/www/oktours
        file_server
    }
}
```

> Note: `handle /admin/*` (not `handle_path`) — the admin-service expects the
> full `/admin/...` path. `handle_path /_staging/*` *strips* the prefix so the
> file_server sees plain `/index.html`.

**Validate, then reload:**
```bash
ssh root@77.42.39.133 "caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
```

---

## Step 12 — Initial staging deploy

**Why:** The staging dir is currently empty. Seed it with the current `main` content so the first preview works.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
curl -s -X POST -H "X-Admin-Token: $(grep ^REDEPLOY_TOKEN= /etc/oktours-admin.env | cut -d= -f2)" \
  http://127.0.0.1:3000/admin/api/redeploy-main
REMOTE
```

**Verify:**
- `https://oktours.diginew.cz/_staging/` (after basic auth) shows the current site.
- `https://oktours.diginew.cz/admin/` shows the login page.

---

## Step 13 — First chat-driven edit (smoke test)

Open `https://oktours.diginew.cz/admin/` in your browser.

1. You land on the login page → enter `ADMIN_PASSWORD` (from step 7).
2. You're now in the chat UI. Send something trivial, e.g.
   *"Změň text v patičce na 'Cestovní agentura OK TOURS Praha'"*.
3. Wait for Claude's confirmation prompt.
4. Click **Ano, použít**.
5. Click the staging preview link, enter the staging password, verify the change.
6. Back in chat, click **Publikovat na živý web**.
7. Open `https://oktours.diginew.cz/` in a private window — confirm the change is live.
8. Check your inbox for the `[OK TOURS] …` email notification.

If all 8 pass, MVP is in production.

> Known minor glitch: the staging preview at `/_staging/` may show a missing
> logo/favicon — `index.html` has two root-absolute links (`/logo.svg`,
> `/apple-touch-icon.png`) that resolve against the domain root, not the
> `/_staging/` prefix. Cosmetic, preview-only; the live site is unaffected.

---

## Updating Martin's workflow

After this lands, **retire the manual rsync from the repo-root `CLAUDE.md`**. To deploy your claude.ai edits:

```bash
# From your laptop, after `git push origin main`:
ssh root@77.42.39.133 \
  'curl -s -X POST -H "X-Admin-Token: $(grep ^REDEPLOY_TOKEN= /etc/oktours-admin.env | cut -d= -f2)" \
        http://127.0.0.1:3000/admin/api/redeploy-main'
```

Stick that in `scripts/deploy.sh` so it's a one-liner. The admin-service handles the smoke test, atomic swap, and staging sync.

---

## Rollback

If anything goes wrong mid-deploy:

```bash
# Stop the service.
ssh root@77.42.39.133 "systemctl stop oktours-admin"

# Swap previous back to live (if /var/www/oktours/ got moved).
ssh root@77.42.39.133 "
  [ -d /var/www/oktours-previous ] && {
    rm -rf /var/www/oktours-broken
    mv /var/www/oktours /var/www/oktours-broken 2>/dev/null
    mv /var/www/oktours-previous /var/www/oktours
  }
"

# Revert the systemd unit + Caddyfile additions if needed.
ssh root@77.42.39.133 "systemctl disable oktours-admin && rm /etc/systemd/system/oktours-admin.service"
# Then re-edit /etc/caddy/Caddyfile to remove the /admin/* and /_staging/* handlers, and `systemctl reload caddy`.
```

The site is back to its pre-admin state. All data lives in `/srv/oktours-repo/.git` and is recoverable.

---

## Operational maintenance

- **Logs:** `journalctl -u oktours-admin -f` (live), `journalctl -u oktours-admin --since=today` (today's events).
- **Restart:** `systemctl restart oktours-admin`.
- **Updating the service code:** `cd /srv/oktours-repo && sudo -u oktours-admin git pull && cd admin-service && sudo -u oktours-admin npm ci --omit=dev && systemctl restart oktours-admin`.
- **Rotating the Anthropic key / admin password / secrets:** edit `/etc/oktours-admin.env`, then `systemctl restart oktours-admin`.
- **Disk usage:** `du -sh /srv/admin-service/data /var/www/oktours*` — session history grows slowly; should stay well under 1 GB.

---

## After this is stable

- [ ] Add a GitHub webhook so `git push origin main` automatically calls `/admin/api/redeploy-main` (replaces the manual SSH curl).
- [ ] Move staging to its own subdomain (`staging.oktours.cz`) after the `oktours.cz` cutover, so preview links render identically to production.
- [ ] Add Playwright screenshot capture (currently structural smoke only).
- [ ] Add the "Request developer help" button for structural client asks.
- [ ] Per-user logins (Pavel Trejtnar + Marek Plášil) instead of one shared password.

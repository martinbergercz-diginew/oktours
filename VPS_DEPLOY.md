# OK TOURS admin-service — VPS deployment runbook

Target: **Hetzner CX22 at `77.42.39.133`** (Ubuntu 24.04, hostname `oktours-prod`).
Companion to [README.md](README.md) and the spec at [../ADMIN_CHAT_SPEC.md](../ADMIN_CHAT_SPEC.md).

Total time: ~45 min. Most of it is one-time setup; updates after that take seconds.

Each step has a **Why** line (so you can skip if you understand the rationale), the **Commands** to run, and a **Verify** check.

---

## Pre-flight (assumed already true on the VPS)

- Caddy v2 running, listening on :80 and :443.
- PHP-FPM 8.3 running for `send-mail.php`.
- Postfix running for outgoing mail.
- `oktours.diginew.cz` Caddy vhost serving `/var/www/oktours/`.
- SSH access from your laptop as `root@77.42.39.133` using `~/.ssh/id_ed25519`.

If any of those is false, fix it first via `ok-tours/CLAUDE.md` before proceeding.

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

**Why:** admin-service does `git push origin main` and `git push origin staging`. It needs auth that's scoped to JUST this one repo, not your personal account.

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

**Take the printed `ssh-ed25519 …` line and add it as a deploy key:**

1. Open https://github.com/martinbergercz-diginew/prototypes/settings/keys/new
2. Title: `oktours-admin (VPS)`
3. Paste the key.
4. **Check "Allow write access"** — required since the service pushes.
5. Click "Add key".

**Verify the key works:**
```bash
ssh root@77.42.39.133 "sudo -u oktours-admin -H ssh -i /srv/admin-service/.ssh/id_ed25519 -T git@github.com"
```
Should print: `Hi martinbergercz-diginew/prototypes! You've successfully authenticated…`

---

## Step 4 — Clone the monorepo

**Why:** admin-service edits files inside this clone. Each `commit_to_staging` runs `git pull --rebase` first to stay in sync with your laptop pushes.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
if [ ! -d /srv/oktours-repo/.git ]; then
  sudo -u oktours-admin -H bash -c '
    git clone git@github.com:martinbergercz-diginew/prototypes.git /srv/oktours-repo
    cd /srv/oktours-repo
    git config user.name "OK TOURS admin"
    git config user.email "admin@oktours.cz"
    git branch staging main 2>/dev/null || true
  '
fi
# Newer git requires marking the dir as safe even when the owning user runs against it.
sudo -u oktours-admin git -C /srv/oktours-repo log --oneline -1
REMOTE
```

**Verify:** prints the most recent commit from `main`.

---

## Step 5 — Install admin-service dependencies

**Why:** Production-only deps (`@anthropic-ai/sdk`, `sharp`, `simple-git`, etc.), no devDeps.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
cd /srv/oktours-repo/ok-tours/admin-service
sudo -u oktours-admin npm ci --omit=dev
REMOTE
```

**Verify:**
```bash
ssh root@77.42.39.133 "ls /srv/oktours-repo/ok-tours/admin-service/node_modules/@anthropic-ai/sdk/package.json && echo OK"
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
All four dirs should be owned by `oktours-admin:caddy` with `drwxr-x---` or similar.

---

## Step 7 — Generate the basic-auth password hash

**Why:** Caddy stores the password as a bcrypt hash. Same hash gates `/admin/` AND the staging vhost (§9).

```bash
read -s -p "Choose an admin password: " ADMIN_PASS
ssh root@77.42.39.133 "caddy hash-password --plaintext '$ADMIN_PASS'"
unset ADMIN_PASS
```

Copy the printed `$2a$…` hash. You'll paste it into the Caddyfile in step 10.

---

## Step 8 — Generate the redeploy token

**Why:** `POST /admin/api/redeploy-main` is gated by a shared-secret header, because Caddy basic-auth doesn't apply when you `curl localhost:3000` from the VPS itself.

```bash
ssh root@77.42.39.133 "openssl rand -hex 32"
```

Copy the printed value. You'll put it in `/etc/oktours-admin.env` next.

---

## Step 9 — Create the production env file

**Why:** systemd reads this file at boot. Owned by root with mode 600 so even other users on the box can't read the API key.

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

STAGING_URL=https://oktours-staging.diginew.cz
LIVE_URL=https://oktours.cz

NOTIFY_EMAIL=martinbergercz@gmail.com
SMTP_HOST=localhost
SMTP_PORT=25
MAIL_DOMAIN=oktours.cz

REDEPLOY_TOKEN=REPLACE_ME_FROM_STEP_8
DRY_RUN=false
ENV
chmod 600 /etc/oktours-admin.env
chown root:root /etc/oktours-admin.env

mkdir -p /srv/admin-service/data
chown -R oktours-admin:oktours-admin /srv/admin-service

# Now edit the two REPLACE_ME values:
nano /etc/oktours-admin.env
REMOTE
```

Replace `sk-ant-REPLACE_ME` with your real Anthropic key and `REPLACE_ME_FROM_STEP_8` with the hex value from step 8. Save and exit (`Ctrl-O`, `Enter`, `Ctrl-X`).

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
cp /srv/oktours-repo/ok-tours/admin-service/admin-service.service /etc/systemd/system/oktours-admin.service
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
Should print: `{"ok":true,"dryRun":false,"repo":"/srv/oktours-repo","version":"0.1.0"}`

If `dryRun` is true, your env file didn't apply — check `/etc/oktours-admin.env`.

---

## Step 11 — Update Caddyfile

**Why:** Two new vhosts/routes:
- `/admin/*` on `oktours.cz` (or `oktours.diginew.cz` until cutover) → reverse-proxy to admin-service with basic auth.
- `oktours-staging.diginew.cz` → file_server with basic auth + robots disallow.

Open the Caddyfile:
```bash
ssh root@77.42.39.133 "nano /etc/caddy/Caddyfile"
```

Find the existing block for `oktours.diginew.cz` (or `oktours.cz` if cutover is done) and add the `handle_path /admin/*` block. Then add the staging vhost. Example final structure:

```caddyfile
oktours.diginew.cz {
    encode gzip
    log {
        output file /var/log/caddy/access.log
    }

    # NEW — admin chat UI + API.
    handle_path /admin/* {
        basic_auth {
            client PASTE_BCRYPT_HASH_FROM_STEP_7
        }
        reverse_proxy 127.0.0.1:3000
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

# NEW — staging preview vhost. Behind same basic auth.
oktours-staging.diginew.cz {
    basic_auth {
        client PASTE_BCRYPT_HASH_FROM_STEP_7
    }
    header /robots.txt Content-Type text/plain
    respond /robots.txt "User-agent: *\nDisallow: /\n" 200
    root * /var/www/oktours-staging
    file_server
}
```

**Verify Caddyfile syntax, then reload:**
```bash
ssh root@77.42.39.133 "caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
```

---

## Step 12 — DNS for staging subdomain

**Why:** `oktours-staging.diginew.cz` needs an A record so Caddy can serve TLS on it. Add at **web4u** (the registrar for `diginew.cz`):

1. Log in to web4u admin.
2. Open the DNS zone for `diginew.cz`.
3. Add A record:
   - Host: `oktours-staging`
   - Type: A
   - Value: `77.42.39.133`
   - TTL: 300 (low for first 24h, then increase to 3600)
4. Save.

**Verify (wait ~5 min for propagation):**
```bash
dig +short oktours-staging.diginew.cz
# → 77.42.39.133
```

**Verify TLS auto-issues:**
```bash
ssh root@77.42.39.133 "tail -20 /var/log/caddy/access.log"
# Look for tls.handshake successful for oktours-staging.diginew.cz
curl -I https://oktours-staging.diginew.cz/
# Should return 401 Unauthorized (basic auth gate working).
```

---

## Step 13 — Initial staging deploy

**Why:** The staging dir is currently empty. Seed it with the current `main` content so first preview works.

```bash
ssh root@77.42.39.133 'bash -s' <<'REMOTE'
curl -X POST -H "X-Admin-Token: $(grep ^REDEPLOY_TOKEN= /etc/oktours-admin.env | cut -d= -f2)" \
  http://127.0.0.1:3000/admin/api/redeploy-main
REMOTE
```

**Verify:**
- `https://oktours-staging.diginew.cz/` (after basic auth) shows the current site.
- `https://oktours.diginew.cz/admin/` (after basic auth) shows the chat UI.

---

## Step 14 — First chat-driven edit (smoke test)

Open `https://oktours.diginew.cz/admin/` in your browser.

1. Enter basic-auth credentials (user: `client`, password from step 7).
2. Send: *"Změň text v hlavičce na 'Cestovní agentura OK TOURS Praha'"* (or something trivial).
3. Wait for Claude's confirmation prompt.
4. Click **Ano, použít**.
5. Click the staging preview link, verify the change.
6. Back in chat, click **Publikovat na živý web**.
7. Open `https://oktours.diginew.cz/` in a private window — confirm the change is live.
8. Check your inbox for the `[OK TOURS] …` email notification.

If all 8 pass, MVP is in production.

---

## Updating Martin's workflow

After this lands, **retire the manual rsync from `ok-tours/CLAUDE.md`**. To deploy your claude.ai edits:

```bash
# From your laptop, after `git push origin main`:
ssh root@77.42.39.133 \
  'curl -s -X POST -H "X-Admin-Token: $(grep ^REDEPLOY_TOKEN= /etc/oktours-admin.env | cut -d= -f2)" \
        http://127.0.0.1:3000/admin/api/redeploy-main'
```

Stick that in `ok-tours/scripts/deploy.sh` so it's a one-liner. The admin-service handles the smoke test, atomic swap, staging sync, and (eventually) screenshot capture.

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
# Then re-edit /etc/caddy/Caddyfile to remove the /admin/* handler and staging vhost, and `systemctl reload caddy`.
```

The site is back to its pre-admin state. All data lives in `/srv/oktours-repo/.git` and is recoverable.

---

## Operational maintenance

- **Logs:** `journalctl -u oktours-admin -f` (live), `journalctl -u oktours-admin --since=today` (today's events).
- **Restart:** `systemctl restart oktours-admin`.
- **Updating the service code:** `cd /srv/oktours-repo && sudo -u oktours-admin git pull && cd ok-tours/admin-service && sudo -u oktours-admin npm ci --omit=dev && systemctl restart oktours-admin`.
- **Rotating the Anthropic key:** edit `/etc/oktours-admin.env`, `systemctl restart oktours-admin`.
- **Rotating the redeploy token:** same. Update your laptop's `deploy.sh` afterwards.
- **Disk usage:** `du -sh /srv/admin-service/data /var/www/oktours*` — screenshots and session history grow slowly; should stay well under 1 GB.

---

## After this is stable

- [ ] Add a GitHub webhook so `git push origin main` automatically calls `/admin/api/redeploy-main` (replaces the manual SSH curl).
- [ ] Switch staging URL from `oktours-staging.diginew.cz` to `staging.oktours.cz` after the `oktours.cz` cutover.
- [ ] Add Playwright screenshot capture (currently structural smoke only).
- [ ] Add the "Request developer help" button for structural client asks.
- [ ] Magic-link auth for two named users (Pavel Trejtnar + Marek Plášil) instead of shared password.

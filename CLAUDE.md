# oktours

**Live URL (temporary):** https://oktours.diginew.cz/
**English version:** https://oktours.diginew.cz/index-en.html
**Future URL (after client approval):** https://oktours.cz/
**GitHub repo:** `martinbergercz-diginew/oktours`

---

## What is OK Tours?

Static HTML site for OK Tours corporate travel agency. Has Czech + English language versions, a subpage for long-term rentals (`dlouhodobe-pronajmy.html`), 5 legal PDFs in `docs/`, and a PHP-backed contact form (`send-mail.php`) that sends to `chumpitaz@oktours.cz` and `plasil@oktours.cz` via the server's local Postfix.

This project lives in its own dedicated repo (history was extracted from the `prototypes` monorepo's `ok-tours/` subdirectory using `git subtree split`, preserving all 45 commits of edit history).

---

## Tech Stack
- Static HTML + CSS (no build step, no React, no Vite)
- One PHP file: `send-mail.php` (contact form handler, uses `mail()` via Postfix)
- Caddy v2 + PHP-FPM 8.3 + Postfix on the server
- Images: `image.png`, `logo_w.png`, `logo.svg`, hotel photos in `hotel_photos/`, legal logos in `logos/`, team portraits in `team/`, section banners in `sections/`

---

## Files

### Public (deployed)
- `index.html` — Czech homepage
- `index-en.html` — English homepage
- `dlouhodobe-pronajmy.html` — long-term rentals subpage
- `send-mail.php` — contact form handler
- `404.html` — custom branded 404 page
- `robots.txt`, `sitemap.xml` — SEO basics
- `og-image.jpg`, `apple-touch-icon.png`, `logo.svg` — share previews + favicons
- `docs/*.pdf` — 5 legal PDFs (obchodní podmínky, GDPR, pojistka, IATA, koncesní listina)
- `logos/ack-cr.png`, `logos/iata.png` — footer association logos
- `hotel_photos/*.jpg` — carousel images for `dlouhodobe-pronajmy.html`
- `team/*.jpg` — 4 leadership portraits
- `sections/*.jpg` — section banner photos
- Misc PNGs (icons, hero images)

### Internal (NOT deployed to production)
- `offer.html` — internal client checklist
- `offer-api.php`, `offer-state.json` — backing the offer.html state
- `index-v1.html` — old version reference
- `CLAUDE.md` — this file
- `SETUP_GA4.md` — instructions for the next Claude session that wires up Google Analytics
- `ADMIN_CHAT_SPEC.md` — design spec for a future chat-driven admin panel

### Not in git (per-machine)
- `.claude/` — per-machine Claude Code config
- `team/_source/` — ~190 MB of original high-res photos before web compression. Kept locally as source material; never commit, never deploy.

---

## Git Workflow

Standalone repo on `main`. After every change: **commit → push → deploy** (all three, every time).

Run all git commands from the **repo root** (`/Users/martinberger/Documents/Prototypes/oktours/`):

```bash
cd /Users/martinberger/Documents/Prototypes/oktours
git add .
git commit -m "Description of changes"
git push
```

Work directly on `main`. No feature branches needed for routine changes.

---

## Deploying to production VPS (Hetzner)

Production server: **`77.42.39.133`** (Hetzner CX22, Helsinki, Ubuntu 24.04, hostname `oktours-prod`).
Stack: Caddy + PHP-FPM 8.3 + Postfix. Files served from `/var/www/oktours/`.

### Quick deploy (one-liner)

Run from the repo root:

```bash
rsync -avz --delete \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='.DS_Store' \
  --exclude='.claude' \
  --exclude='.last-deploy-marker' \
  --exclude='_source' \
  --exclude='CLAUDE.md' \
  --exclude='SETUP_GA4.md' \
  --exclude='ADMIN_CHAT_SPEC.md' \
  --exclude='offer.html' \
  --exclude='offer-api.php' \
  --exclude='offer-state.json' \
  --exclude='index-v1.html' \
  ./ root@77.42.39.133:/var/www/oktours/ && \
ssh root@77.42.39.133 "chown -R caddy:caddy /var/www/oktours"
```

### Important notes
- No build step — files are served as-is
- SSH access to `root@77.42.39.133` requires the `~/.ssh/id_ed25519` key (already authorized)
- The `chown` is needed because rsync runs as `root` but Caddy reads as the `caddy` user
- Caddy auto-renews TLS via Let's Encrypt; no cert maintenance needed
- DNS: `oktours.diginew.cz` (web4u, A record at the registrar) → `77.42.39.133`. After client approval, point `oktours.cz` here too.
- The contact form uses local Postfix (`mail()`); deliverability is not great until SPF/DKIM are added or we relay through the client's SMTP. Currently watch the spam folder when testing.

### Server admin

```bash
# Reload Caddy after Caddyfile changes
ssh root@77.42.39.133 "caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"

# Check mail queue / delivery
ssh root@77.42.39.133 "mailq && tail -50 /var/log/mail.log"

# Caddy access log
ssh root@77.42.39.133 "tail -50 /var/log/caddy/access.log"
```

---

## Cutover from `oktours.diginew.cz` → `oktours.cz` (when client approves)

The site currently uses the staging domain in all SEO meta, canonical links, og:url, sitemap, JSON-LD `@id`s, and `robots.txt`. There's also a temporary `<meta name="robots" content="noindex, nofollow">` on every page so Google doesn't index the staging copy.

When ready to cut over:

1. **Replace all references to the staging domain** (one find-and-replace across the whole repo):

   ```bash
   cd /Users/martinberger/Documents/Prototypes/oktours
   grep -rl --exclude-dir=.git --exclude-dir=_source "oktours.diginew.cz" . | xargs sed -i '' 's|oktours\.diginew\.cz|oktours.cz|g'
   ```

   Verify zero matches remain: `grep -r --exclude-dir=.git --exclude-dir=_source "diginew.cz" .` should be empty.

2. **Remove the noindex meta tag** from `index.html`, `index-en.html`, `dlouhodobe-pronajmy.html`. Search for the marker comment `<!-- TEMPORARY (staging on oktours.diginew.cz)` and delete the marker + the `<meta name="robots">` line beneath it (3 occurrences total).

3. **Update the Caddyfile on the server** to add `oktours.cz` (and ideally `www.oktours.cz`) as the site name; keep `oktours.diginew.cz` as an alias for at least 2 weeks as a safety net (Caddy will then issue certs for both names automatically).

4. **Flip DNS for `oktours.cz`** at the registrar to `77.42.39.133`. Lower the TTL to 300 at least 24h before the change to avoid stale caches.

5. **Verify SPF/MX records on `oktours.cz` are NOT touched** — the client's email is on that domain. Only A and AAAA records change.

6. **Set up Google Search Console** for `oktours.cz` (DNS TXT verification — cleanest), submit `sitemap.xml`.

7. **Then run the GA4 setup** — see `SETUP_GA4.md`.

8. **After 2 weeks of stable traffic on the new domain**, remove `oktours.diginew.cz` from the Caddyfile and from DNS.

---

## Handoff

When Martin says "handoff" — write `HANDOFF.md` to the repo root with the current state: what's done, what's in progress, what's the next step, key files. The handoff file should be self-contained for the next session to pick up.

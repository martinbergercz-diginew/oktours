# ok-tours

**Live URL:** https://dev.signi.com/prototypes/ok-tours/
**Light version:** https://dev.signi.com/prototypes/ok-tours/index-light.html
**Part of:** `martinbergercz-diginew/prototypes` monorepo

---

## What is OK Tours?

Static HTML prototype for OK Tours corporate travel website.

---

## Tech Stack
- Static HTML + CSS (no build step, no React, no Vite)
- Images: `image.png`, `logo_w.png`, `logo.svg`

---

## Files
- `index.html` — main dark version
- `index-light.html` — light version
- `image.png` — hero image
- `logo_w.png` — white logo (PNG)
- `logo.svg` — logo (SVG)

---

## Git Workflow

This project is part of a monorepo. After every change: **commit → push → deploy** (all three, every time).

Run all git commands from the **repo root**:

```bash
cd /Users/martinberger/Documents/Prototypes/prototypes
git add ok-tours/
git commit -m "Description of changes"
git push
```

Work directly on `main`. No feature branches needed for routine changes.

---

## Deploying to VPS (dev.signi.com)

This is a static HTML project — no build step needed. Just rsync the files directly.

### Quick deploy (one-liner)

Run from the `ok-tours/` directory:

```bash
rsync -avz --delete --exclude='.DS_Store' --exclude='CLAUDE.md' --exclude='.claude' . root@dev.signi.com:/var/www/dev/prototypes/ok-tours/
```

### Important notes
- No build step — files are served as-is
- SSH access to `root@dev.signi.com` is required
- No server config changes needed — Caddy serves static files automatically
- The `--exclude='CLAUDE.md'` prevents uploading this file to the server

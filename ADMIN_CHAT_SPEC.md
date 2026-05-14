# OK TOURS — chat-driven admin spec

**Status:** design phase, not yet built.
**Owner:** Martin (developer). Future Claude session will build this from the spec below.
**Target user:** the OK TOURS client (single non-technical person), making small content updates to https://oktours.cz/ — text edits, photo swaps, swapping legal PDFs, adding/removing team members.

The big idea: instead of a WordPress-style admin with forms and dashboards, the client chats with a Claude instance running on the production VPS. Claude makes the code change, commits to GitHub, deploys. The client never sees code, never logs into a server, never knows git exists.

---

## 1. Why not WordPress / Strapi / Sanity / a normal CMS

- The site is 3 static HTML pages. A CMS is heavyweight for that surface.
- WordPress brings security maintenance, plugin sprawl, and a UI nobody likes.
- Headless CMS (Strapi, Sanity) requires the developer to pre-define every editable region upfront. Adding a new editable field later is a code change.
- A chat interface backed by Claude can handle any change the developer didn't anticipate, with zero schema upfront.
- The maintenance burden is a single Node service + one Claude API key.

---

## 2. Goals and non-goals

### Goals
- Client can make content edits (text, photos, PDFs, contact details, team members, sections) **without leaving a single chat window**.
- Every change is committed to GitHub and deployed to the live site automatically.
- Client can revert any change with one click.
- The developer (Martin) can keep editing the same repo from claude.ai sessions without conflicts.
- Cost: under €10/month in API + hosting costs at typical usage.

### Non-goals
- **Approval gate by a human reviewer.** There is no second person to approve. The client is the only operator. Safety comes from staging preview + one-click rollback + auto-screenshot history, not from a code-review step.
- **Multi-user accounts / role permissions.** Single shared login. Add later only if the client team grows.
- **Visual page builder / drag-drop layout.** Out of scope. If the client wants a new section type, Martin builds it; chat is for content within existing sections.
- **Editing analytics, server config, DNS, mail settings, the Caddyfile, or anything outside `/var/www/oktours/`.** Hard blocked at the tool level.
- **Direct shell access for Claude.** No `bash` tool. No `exec`. Only the predefined typed tools below.

---

## 3. User flow (happy path)

1. Client opens https://oktours.cz/admin/ → basic auth prompt → enters shared password.
2. Lands on a single-page chat UI with a sidebar showing recent change history.
3. Types: *"Change Silvie's role to Marketing & Customer Relations"*.
4. Server-side Claude reads the relevant files, makes the edit, commits to a `staging` branch, rsyncs to `oktours-staging.diginew.cz`.
5. UI replies with: *"Done. Preview here: [link to staging]. Looks good?"* and two buttons: **Publish to live** / **Undo**.
6. Client clicks the staging link in a new tab, sees the change.
7. Returns to chat, clicks **Publish to live** → server merges `staging` into `main`, pushes to GitHub, rsyncs to production.
8. History sidebar gets a new entry with timestamp, summary, screenshot thumbnail, and a **Revert** button.

### If the client clicks **Undo** instead
- Server discards the staging commit, redeploys staging from `main`. No live change.
- History sidebar still records the attempted change (for audit / for Claude to learn the client's preferences).

### If the client uploads an image
- Drag-drop zone at the top of the chat area.
- Auto-resized to ≤1600px wide, JPEG q75, stored at `uploads/<sanitized-name>.jpg`.
- Returns a server path. Claude is told *"the user just uploaded `uploads/foo.jpg`"* as a system message at the next turn so it can reference it.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  oktours.cz/admin (HTML+JS, no framework)                           │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────────┐        │
│  │ chat pane  │  │ image drop │  │ history sidebar         │        │
│  └────────────┘  └────────────┘  └─────────────────────────┘        │
└──────────────────────────────│──────────────────────────────────────┘
                               │  HTTPS, basic auth
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  VPS (77.42.39.133)                                                 │
│                                                                     │
│  Caddy reverse-proxies /admin/* → admin-service:3000                │
│                                                                     │
│  admin-service (Node.js, systemd unit)                              │
│   ├── POST /admin/api/chat   — runs one Claude turn                 │
│   ├── POST /admin/api/upload — image upload + resize                │
│   ├── GET  /admin/api/history — list of past commits                │
│   ├── POST /admin/api/publish — merge staging → main, deploy live   │
│   ├── POST /admin/api/revert  — revert a specific commit            │
│   └── POST /admin/api/undo    — discard staging                     │
│                                                                     │
│  Each chat turn spawns a Claude API call (NOT Agent SDK — too open) │
│  with a typed tool set, no shell.                                   │
│                                                                     │
│  Repos on disk:                                                     │
│   /srv/oktours-repo/        — checked-out copy, Claude edits here   │
│   /var/www/oktours-staging/ — rsync target for staging              │
│   /var/www/oktours/         — rsync target for production           │
└─────────────────────────────────────────────────────────────────────┘
            │                              │
            │  git push/pull (main+staging branches)
            ▼
       GitHub (martinbergercz-diginew/prototypes, ok-tours/ subdir)
```

### Why Claude API directly, not Agent SDK
The Agent SDK is more open-ended — it has powerful default tools (bash, computer-use, web-search) that we'd have to disable. Easier to just use the API with our own typed tool list and not introduce capabilities we need to lock down. Trade-off: we implement the agent loop ourselves (10-20 lines).

---

## 5. Tool definitions (Claude can call these, nothing else)

All tools validate path arguments against the allowlist `/srv/oktours-repo/`. Any path traversal (`..`, absolute paths outside the allowlist, symlinks) is rejected with an error returned to Claude.

```
list_files(directory: string) → string[]
  Lists files in /srv/oktours-repo/<directory>.

read_file(path: string) → string
  Returns file contents. Max 200 KB.

write_file(path: string, content: string) → void
  Overwrites file. Allowed paths: *.html, *.css, *.md (non-spec), *.txt,
  *.xml (sitemap), *.json (klaro config etc.), files under /docs/,
  /uploads/, /team/, /sections/, /hotel_photos/, /logos/.
  BLOCKED: Caddyfile (not in repo anyway), *.php, *.sh, anything starting
  with a dot, anything under .git/.

delete_file(path: string) → void
  Same allowlist as write_file. Refuses to delete index.html, index-en.html,
  dlouhodobe-pronajmy.html, send-mail.php, CLAUDE.md, the .gitignore.

commit_to_staging(message: string) → { commit: string, staging_url: string }
  git add → commit on the staging branch → push → rsync to staging server.
  Returns the commit hash and the staging URL to show the client.

revert_commit(commit_hash: string) → void
  Only allowed for commits within the last 90 days. Creates an inverse commit
  (never hard-resets — keeps history intact).

list_uploads() → { path: string, original_name: string, uploaded_at: string }[]
  Returns recent images the client has uploaded but Claude hasn't placed yet.
```

Notably absent: `bash`, `exec`, `http_fetch`, `read_url`, `web_search`, anything that touches `/etc/`, the systemd unit, the Caddyfile, the Postfix config, the `.ssh/` dir, the GA4 setup doc, or the auto-deploy scripts.

---

## 6. Safety model (replacing the missing approval gate)

Since there's no second-party reviewer, we layer multiple cheaper safeguards:

### 6.1 Staging-first, never direct-to-live
Every change Claude makes goes to a `staging` branch and rsyncs to `oktours-staging.diginew.cz`. The client has to consciously click **Publish to live**. This IS the approval gate, but it's *visual* not *technical* — the client looks at the staging page and decides if it's correct. They never read a diff.

### 6.2 One-click revert from history
Every past commit on the production branch has a **Revert** button in the sidebar. Clicking it creates an inverse commit and redeploys. If the client realises 30 minutes later that something is off, they can undo without help.

### 6.3 Auto-screenshot before and after
After every staging deploy and every production deploy, the server uses Playwright to screenshot the affected page (Claude tells the server which page it changed). Thumbnails appear in history. The client can scroll history and spot visually when things went wrong.

### 6.4 Smoke tests block bad deploys
After staging deploy, the server hits the staging URL with HTTP HEAD. If it doesn't return 200, the deploy is rolled back automatically and Claude is told to try again. Same check on production deploy. Catches "Claude broke the HTML so the page won't parse" cases.

### 6.5 Conservative system prompt
Claude is instructed to:
- Make the smallest possible change to satisfy the request.
- Never restructure HTML, CSS, or page layout.
- Never delete content unless explicitly asked.
- Always edit both `index.html` and `index-en.html` together when the change is content the user can see in both (e.g., team member info), but only one of them when the change is language-specific.
- Ask the user before doing anything destructive (deleting a section, removing a team member, replacing more than 3 images at once).

### 6.6 Rate limit
Per-session limit: 30 commits-to-staging per day, 10 publish-to-live per day. Prevents both runaway API costs and accidental spam-clicking.

### 6.7 Email notification to Martin
Every publish-to-live triggers an email to `martinbergercz@gmail.com`:
- Subject: `[OK TOURS] <client name>: <commit subject>`
- Body: client's prompt, Claude's summary, diff (≤200 lines), link to commit on GitHub, link to revert.

Martin stays in the loop without having to gate anything.

### 6.8 No write-access to dangerous files (already in §5)
Tool design prevents Claude from touching the Caddyfile, PHP, scripts, or anything that could compromise the server.

---

## 7. UI (browser side)

Single HTML file (`/admin/index.html`), vanilla JS, no framework. ~500 lines total.

### Layout
- Left 70%: chat pane (message list + input box at bottom).
- Right 30%: history sidebar (vertical timeline of past commits with screenshot thumbnails and revert buttons).
- Top: image drop zone (collapsed by default, expands when client drags a file).

### After Claude responds with a staging commit
The reply renders as:
```
✓ Done. I changed Silvie's role to "Marketing & Customer Relations" in
 both Czech and English versions.

  Preview: https://oktours-staging.diginew.cz/#o-nas  →  [open in new tab]

  [Publish to live]   [Undo]
```

Buttons are styled inline in the message, not in a modal. Once clicked, the buttons gray out and the action runs.

### Mobile
Sidebar collapses behind a button. Drop zone supports tap-to-upload (file picker fallback) since drag-drop doesn't exist on mobile.

---

## 8. Data model

### Filesystem state (no separate database needed)
- `/srv/oktours-repo/` — the canonical repo, `main` and `staging` branches.
- `/srv/admin-service/data/sessions.json` — current chat history per session (last 50 turns per user).
- `/srv/admin-service/data/uploads-pending.json` — recent uploads not yet referenced in a commit.
- `/srv/admin-service/data/screenshots/<commit-hash>.jpg` — Playwright screenshots, one per commit.

Why no SQLite/Postgres: nothing here needs relational queries. Git is already the database for "what changed when". JSON files cover the rest.

---

## 9. Authentication

### MVP
HTTP basic auth in Caddy, single shared password. Stored as bcrypt hash in the Caddyfile:
```
@admin path /admin/*
handle @admin {
    basic_auth {
        client $2a$14$....
    }
    reverse_proxy localhost:3000
}
```

Pros: zero new code, well-tested, easy to revoke.

### v2 (later)
Magic-link email login, two named users (Pavel Trejtnar + Marek Plášil), per-user history attribution in the email notifications. Skip until needed.

---

## 10. Image upload pipeline

### Client side
Drag-drop zone or tap-to-upload. Max 1 file per drop. Files >10 MB rejected client-side.

### Server side (`POST /admin/api/upload`)
1. Validate MIME type — only `image/jpeg`, `image/png`, `image/webp`.
2. Strip EXIF (privacy + smaller files).
3. Sanitize filename: lowercase, ASCII-fold (`Trejtnářová` → `trejtnarova`), spaces→dashes, dedupe with `-2`, `-3` suffix if collision.
4. Resize: longer dimension ≤ 1600 px, JPEG q75. Use `sharp` (Node) for this.
5. Save to `/srv/oktours-repo/uploads/<sanitized>.jpg`.
6. Return `{ path: "uploads/<sanitized>.jpg", size_kb: N }` to the client.
7. Append to `uploads-pending.json` with a 24-hour TTL.
8. Inject into the next Claude turn as a system message: *"The user uploaded uploads/<sanitized>.jpg. Reference this file by its path if relevant to their request."*

Originals are NOT kept. The compressed version IS the canonical version. If the client wants a higher-res original, they re-upload it.

---

## 11. The two-developer problem (Martin + client)

Both edit the same `main` branch on the same GitHub repo. Standard distributed git conflict scenario.

### Rules
- The admin service always does `git pull --rebase origin main` *before* every commit-to-staging.
- After `commit_and_deploy` (publish-to-live), it does `git push origin main` immediately.
- If a push fails with a non-fast-forward error, the service auto-pulls and retries once. If it fails again, it tells the client *"Martin made changes a moment ago. Refreshing… try sending your message again."*
- Martin's discipline: when editing from claude.ai, push frequently in small commits. Don't sit on uncommitted changes that touch the same files the client touches (team mottos, photos, contact info).
- The staging branch is OK to force-push — it's a scratch space. Production (`main`) is never force-pushed.

---

## 12. Cost estimate

### Claude API
Per turn: ~5-10 K tokens input (system prompt + history + relevant file context) + 1-2 K tokens output (response + tool calls).
At Sonnet 4.6 pricing with prompt caching (system prompt + unchanged files cached): **€0.02-0.05 per turn**.

Typical month, conservatively 200 turns: **€5-10 in API**.

### Hosting
Same CX22 VPS, no extra cost. The admin service adds ~150 MB resident memory; fits comfortably in the existing 4 GB.

### Total
**Under €10/month** including hosting overhead from the OG VPS. Compared to a managed CMS (€20-50/month) plus dev time to maintain, this wins easily.

---

## 13. Failure modes and how they're handled

| Failure | Detection | Recovery |
|---|---|---|
| Claude generates broken HTML | smoke test (HTTP 200 + key elements present) on staging fails | Auto-revert staging commit; tell user "preview broke, try again" |
| Claude tries to write outside allowlist | tool refuses, returns error to Claude | Claude apologises and tries differently |
| Git push conflict | non-fast-forward error from `git push` | Auto pull+rebase, retry once; if still fails, surface to user |
| Disk full | upload fails | Tell user, log alert |
| Claude API down | HTTP error from anthropic.com | Show banner "Service temporarily unavailable, try again in a minute" |
| Image too large | size check fails | Reject before upload starts |
| Client deletes their entire homepage | passes smoke test but is wrong | One-click revert from history sidebar |
| Client unhappy with last 5 changes | needs bulk undo | History sidebar lets them revert one at a time (no bulk button in MVP) |

---

## 14. MVP scope vs. v1.1+

### MVP (must-ship for the client to actually use this)
- Chat UI + basic auth
- Tools: list/read/write/delete + commit-to-staging + publish + revert
- Staging-first workflow with Publish/Undo buttons
- History sidebar with revert buttons (text only, no thumbnails yet)
- Path allowlist enforced at tool level
- Smoke tests before deploy
- Email notifications to Martin
- Rate limit (30 staging / 10 publish per day)

### v1.1 (after MVP works)
- Image upload pipeline
- Playwright screenshots in history
- Conservative system prompt fine-tuning (after observing real usage)
- Magic-link auth for two named users

### v2 (only if there's demand)
- Help mode (read-only Claude that answers questions about the site without changing anything)
- Templates for common requests (one-click "Change team member's motto" etc.)
- Multi-site (sell this as a product to other freelancers)

---

## 15. Build plan (rough)

Estimated total: **3–5 focused days of dev**.

1. **Day 1** — Caddy auth route + Node service skeleton + tool plumbing with path-allowlist tests
2. **Day 2** — Chat UI + Claude API integration with the typed tool loop
3. **Day 3** — Staging branch workflow + smoke tests + publish/revert buttons + email notifications
4. **Day 4** — History sidebar + image upload pipeline + Playwright screenshots
5. **Day 5** — Polish + dogfood (Martin uses it for an afternoon as the "client" before handing over)

Then onboarding the client: 30-minute call, show them the chat interface, do 3 sample edits together, leave them with a one-page cheatsheet.

---

## 16. Things to revisit before building

- **Staging URL TLS** — Caddy auto-issues for `oktours-staging.diginew.cz` once DNS exists. Add the DNS A record at web4u alongside the production cutover.
- **The `oktours.cz` cutover** — this admin spec assumes the production site has already moved to `oktours.cz`. Build this *after* cutover, not before, otherwise we're building against a moving target.
- **Client onboarding** — make a 60-second screen-recording showing the loop (chat → staging → publish) so the client has a reference.
- **Backup off-VPS** — the admin service relies on GitHub for source-of-truth backup. If GitHub itself goes down, the VPS still has the local repo. If both go down simultaneously, the screenshots and uploads-pending JSON are unrecoverable. Acceptable risk for this tier — but mention it to the client.

---

## 17. What's intentionally NOT covered by this spec

- The actual UI styling — that gets designed in code during the build, not specced upfront.
- The exact wording of the system prompt — same; iterate during dogfooding on day 5.
- WordPress migration — there's nothing to migrate.
- SLA / uptime guarantees to the client — informal best-effort, single VPS, no HA.
- GDPR for the admin service itself — basic auth doesn't set tracking cookies; chat history stored only on the VPS in `sessions.json`; no third parties involved. Probably fine without explicit disclosure beyond the existing GDPR PDF, but ask a lawyer if the client has compliance questions.

---

## Open questions to settle before building

1. **Languages of the chat interface itself** — Czech only? Czech + English? The client is Czech, default to Czech but make it easy to toggle.
2. **Who owns the API key?** — Martin's Anthropic account, billed monthly to Martin, presumably re-billed to the client as part of a maintenance retainer. Or: client creates their own Anthropic account, Martin gets API key access. Cleaner long-term; messier setup.
3. **Domain for staging** — `oktours-staging.diginew.cz`? `staging.oktours.cz`? The latter is nicer but means another DNS record at the client's `oktours.cz` registrar after cutover.
4. **What if the client wants to edit content Martin considers structural** — e.g. "delete the entire Portfolio section". The conservative system prompt has Claude ask first; should there also be a hardcoded list of sections that can't be deleted? Probably yes — `<nav>`, `<footer>`, the legal links — even if the client insists.

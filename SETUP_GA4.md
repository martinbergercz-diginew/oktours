# OK TOURS — Google Analytics 4 Setup Guide

**For: a future Claude session that picks this up after the cutover from `oktours.diginew.cz` → `oktours.cz` is complete.**

---

## Values to use (already provisioned)

| Variable | Value | Notes |
|---|---|---|
| **Measurement ID** | `G-YFBKZHVLZ3` | Property already created in Google Analytics. Paste this everywhere this guide says `G-XXXXXXXXXX`. |

The GA4 property at `analytics.google.com` is already set up (Part 1 below was already done). Skip Part 1 — go straight to **Part 2**.

---

This document explains everything needed to add Google Analytics 4 (GA4) tracking to the OK TOURS website.

The plan is: GA4 + Google **Consent Mode v2** + a lightweight cookie banner ([Klaro!](https://klaro.kiprotect.com/)). This is the GDPR-compliant path required for EU traffic since March 2024.

---

## Part 1 — What Martin needs to do in Google's UI (before any code changes)

These steps cannot be automated. The output is a **Measurement ID** that Claude will then wire into the site.

1. Go to https://analytics.google.com/ and sign in with the same Google account that will own the property long-term (probably Martin's, then transferred to OK TOURS at handover — see "Transferring ownership" below).
2. Admin → **Create** → **Account** (top of left column). Account name: `OK TOURS`. Accept default data-sharing settings (uncheck anything you don't want).
3. **Create property** inside the account. Name: `oktours.cz`. Reporting time zone: `Czech Republic — GMT+01:00`. Currency: `CZK`. Click Next.
4. Business details: Industry = `Travel`, Size = `Small`. Click Create.
5. **Set up a data stream**: choose **Web**.
   - Website URL: `https://oktours.cz/`
   - Stream name: `oktours.cz — main`
   - Leave **Enhanced measurement ON** (it auto-tracks scrolls, outbound clicks, file downloads — covers most of what we'd otherwise hand-roll).
6. Copy the **Measurement ID** shown in the right-hand drawer (`G-XXXXXXXXXX`). Save it somewhere — you'll need it in Part 2.
7. **Disable Google Signals for now**: Admin → Data Settings → Data Collection → toggle off "Google signals data collection". (Reduces GDPR scope. Re-enable only if remarketing/audience export becomes useful.)
8. **Set data retention to 14 months** (the maximum on the free tier): Admin → Data Settings → Data Retention. Then save.
9. **Internal traffic filter** (optional but recommended): Admin → Data Streams → click the stream → Configure tag settings → Show all → Define internal traffic. Add Martin's office IP and any client IPs to be excluded. Then Admin → Data Settings → Data Filters → enable the "Internal traffic" filter (it's created in "Testing" mode by default — switch to "Active").
10. **Skip audience setup, conversions, and Search Console linking for now** — those can be done later once data is flowing.

### Transferring ownership at handover

When the OK TOURS engagement ends, transfer the GA4 property to the client:

1. Admin → Account Access Management → Add user with **Administrator** role using the client's Google email.
2. Have the client confirm they can log in.
3. Remove Martin's account from Account Access Management.

The property and its data stay intact; only the owner changes. Same procedure works for the Google Tag Manager container if one is added later.

---

## Part 2 — What the next Claude session needs to do (code changes)

### Pre-requisites

Before starting:
- ✅ Cutover to production domain `oktours.cz` is complete (canonical URLs, og:url, sitemap.xml, JSON-LD `@id` all already point to `oktours.cz` — verify before proceeding).
- ✅ The `<meta name="robots" content="noindex, nofollow">` has been removed from all three HTML files.
- ✅ Martin has the Measurement ID (`G-XXXXXXXXXX`) and pastes it into the chat.

If any of these is not done, **stop and ask**.

### Files to touch

```
/Users/martinberger/Documents/Prototypes/prototypes/ok-tours/
├── index.html                # add: consent default, gtag bootstrap, klaro init
├── index-en.html             # same as index.html, English banner copy
├── dlouhodobe-pronajmy.html  # same as index.html, Czech banner copy
├── analytics.js              # NEW — gtag config + custom event listeners
├── klaro-config.js           # NEW — Klaro! consent banner config (CZ + EN)
└── klaro.js                  # NEW — Klaro! library, downloaded from CDN once and self-hosted
```

Do NOT inline the gtag/Klaro logic into each HTML file. Factor into shared JS files. Three reasons: single Measurement ID source of truth, easier to update event handlers, browser caches one file across all three pages.

### Step-by-step

#### 1. Download Klaro library

```bash
cd /Users/martinberger/Documents/Prototypes/prototypes/ok-tours/
curl -L -o klaro.js "https://cdn.kiprotect.com/klaro/v0.7/klaro.js"
```

Verify the file is ~50 KB. Self-hosting (vs. loading from CDN) avoids a third-party DNS hop and removes a cookie-consent dependency on a third party (which would itself need disclosure).

#### 2. Create `klaro-config.js`

This is the cookie banner configuration — texts, services, default-deny, language selection. Detect language from `<html lang>` and pick CZ vs EN copy.

Recommended minimum config:

```js
window.klaroConfig = {
  version: 1,
  elementID: "klaro",
  storageMethod: "cookie",
  storageName: "klaro-consent",
  cookieExpiresAfterDays: 180,
  htmlTexts: true,
  default: false,
  mustConsent: false,           // false = passive banner, true = blocking modal
  acceptAll: true,
  hideDeclineAll: false,        // GDPR: "Reject" must be as prominent as "Accept"
  hideLearnMore: false,
  noticeAsModal: false,
  lang: document.documentElement.lang === "en" ? "en" : "cs",

  translations: {
    cs: {
      consentNotice: {
        title: "Souhlas s cookies",
        description:
          "Používáme analytické cookies (Google Analytics) k tomu, abychom rozuměli, jak návštěvníci používají náš web. Bez vašeho souhlasu nic nesbíráme.",
        learnMore: "Podrobnosti",
      },
      consentModal: {
        title: "Nastavení cookies",
        description:
          "Vyberte, které cookies můžeme používat. Volbu můžete kdykoliv změnit kliknutím na odkaz „Cookies\" v patičce.",
      },
      acceptAll: "Přijmout vše",
      decline: "Odmítnout",
      ok: "Uložit volbu",
      privacyPolicy: { name: "Zásadami GDPR", text: "Souhlasem potvrzujete znalost našich {privacyPolicy}." },
      service: {
        purpose: "účel",
        purposes: "účely",
      },
      purposes: {
        analytics: { title: "Analytika" },
      },
    },
    en: {
      consentNotice: {
        title: "Cookie consent",
        description:
          "We use analytics cookies (Google Analytics) to understand how visitors use the site. We collect nothing without your consent.",
        learnMore: "Details",
      },
      consentModal: {
        title: "Cookie settings",
        description:
          "Choose which cookies we may use. You can change this at any time via the \"Cookies\" link in the footer.",
      },
      acceptAll: "Accept all",
      decline: "Reject",
      ok: "Save selection",
      privacyPolicy: { name: "GDPR Policy", text: "By accepting you confirm familiarity with our {privacyPolicy}." },
      service: { purpose: "purpose", purposes: "purposes" },
      purposes: { analytics: { title: "Analytics" } },
    },
  },

  privacyPolicy: { cs: "/docs/gdpr.pdf", en: "/docs/gdpr.pdf" },

  services: [
    {
      name: "googleAnalytics",
      title: "Google Analytics",
      purposes: ["analytics"],
      cookies: [/^_ga/, /^_gid$/, /^_gat/],
      onAccept: `
        gtag('consent', 'update', {
          analytics_storage: 'granted',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied'
        });
      `,
      onDecline: `
        gtag('consent', 'update', {
          analytics_storage: 'denied'
        });
      `,
    },
  ],
};
```

#### 3. Create `analytics.js`

Replace `G-XXXXXXXXXX` with the actual Measurement ID Martin provides.

```js
// 1. Bootstrap gtag with consent denied by default (Consent Mode v2)
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
window.gtag = gtag;

gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500,
});

gtag('js', new Date());
gtag('config', 'G-XXXXXXXXXX', {
  anonymize_ip: true,
  send_page_view: true,
});

// 2. Custom events
document.addEventListener('DOMContentLoaded', () => {
  // form_submit on success
  const form = document.getElementById('contactForm');
  if (form) {
    // The existing form handler in index.html already calls fetch('send-mail.php').
    // We hook AFTER the success branch — see the patches in step 4 below.
  }

  // language_switch — bind to flag links in nav
  document.querySelectorAll('a[href$="index.html"], a[href$="index-en.html"], a[href="/"]').forEach((a) => {
    a.addEventListener('click', () => {
      const target = a.href.includes('-en') ? 'en' : 'cs';
      const from = document.documentElement.lang;
      if (from !== target) {
        gtag('event', 'language_switch', { from, to: target, transport_type: 'beacon' });
      }
    });
  });

  // file_download — delegated, matches all PDF links
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href$=".pdf"]');
    if (!a) return;
    gtag('event', 'file_download', {
      file_name: a.href.split('/').pop(),
      file_extension: 'pdf',
      link_url: a.href,
    });
  });

  // Note: GA4 Enhanced Measurement already auto-tracks outbound_click and scroll,
  // so we don't manually emit those.
});
```

#### 4. Patch each HTML `<head>` (insert at the END of `<head>`, just before `</head>`)

**Order matters.** Klaro config first, then library, then gtag.js, then analytics.js (which calls gtag('consent', 'default') BEFORE gtag.js registers — that's the trick that makes Consent Mode v2 work).

Insert this block in `index.html`, `index-en.html`, and `dlouhodobe-pronajmy.html`:

```html
<!-- Cookie banner (Klaro!) and analytics — Consent Mode v2 -->
<script defer src="/klaro-config.js"></script>
<script defer src="/klaro.js" data-klaro-config="klaroConfig"></script>
<script>
  // Inline consent default — must run synchronously BEFORE gtag.js loads
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500,
  });
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script defer src="/analytics.js"></script>
```

(Yes, `gtag('consent', 'default', ...)` is duplicated in both the inline block and `analytics.js`. The inline copy is what matters — it must execute before `gtag.js` loads. The one in `analytics.js` is harmless redundancy.)

#### 5. Patch the contact form to fire `form_submit` events

In `index.html` and `index-en.html` (the contact form is identical in structure on both), find the success branch in the existing fetch handler:

```js
if (data.success === true) {
  // success messaging
}
```

Add a `gtag` call inside the success branch:

```js
if (data.success === true) {
  if (window.gtag) {
    gtag('event', 'form_submit', {
      form_id: 'contactForm',
      topic: f.topic ? f.topic.value : '',
    });
  }
  // ... existing success messaging
}
```

And in the `catch` block:

```js
} catch {
  if (window.gtag) {
    gtag('event', 'form_submit_failure', { form_id: 'contactForm' });
  }
  // ... existing failure messaging
}
```

In `dlouhodobe-pronajmy.html` the contact form has fewer fields (no topic) — fire the same event with `form_id: 'contactFormDlouhodobe'`.

#### 6. Add a "Cookies" link in the footer

So users can re-open the consent panel after their first choice. In each footer's `.footer-legal` div, add:

```html
<a href="javascript:void(0)" onclick="klaro.show()">Cookies</a>
```

(In `index-en.html`: text = `Cookies` — same word in both languages, works fine.)

#### 7. Deploy and verify

```bash
cd /Users/martinberger/Documents/Prototypes/prototypes
git add ok-tours/
git commit -m "ok-tours: add GA4 with Consent Mode v2 and Klaro cookie banner"
git push
cd ok-tours
rsync -avz --delete \
  --exclude='.DS_Store' --exclude='.claude' --exclude='.last-deploy-marker' \
  --exclude='CLAUDE.md' --exclude='SETUP_GA4.md' --exclude='offer.html' \
  --exclude='offer-api.php' --exclude='offer-state.json' --exclude='index-v1.html' \
  ./ root@77.42.39.133:/var/www/oktours/
ssh root@77.42.39.133 "chown -R caddy:caddy /var/www/oktours"
```

Then verify:

1. Open `https://oktours.cz/` in a private window.
2. **Cookie banner should appear within 1 second.** It should NOT be covering the contact form button or any CTA.
3. Open DevTools → Application → Cookies. With "Reject" clicked, no `_ga*` cookies should exist. With "Accept" clicked, `_ga` and `_ga_<measurement-id-suffix>` should appear.
4. DevTools → Network → filter `collect`. After accept, you should see `POST` requests to `https://www.google-analytics.com/g/collect?...` firing on page view, scroll, and form submit.
5. In GA4 → Reports → Realtime, you should see your own session within 30 seconds.
6. Submit the contact form (with a real test email). The `form_submit` event should appear in Realtime.
7. Click a PDF link. The `file_download` event should appear.
8. Click the language flag. The `language_switch` event should appear.
9. Page Lighthouse score should still be ≥ 95 on Best Practices (Klaro + gtag together add ~50 KB; that's fine).

#### 8. Mark events as conversions in GA4 (Martin)

Once the events show up in Realtime (give it a few hours so they appear in Configure → Events):

- Mark `form_submit` as a **Key Event** (formerly "conversion"). This is the primary success metric for the site.
- Optionally mark `file_download` as a Key Event if Martin wants to track legal-doc-curiosity as a soft signal.

---

## Part 3 — Notes for the future Claude

- **The Klaro version pinned in step 1 is `v0.7`.** If the URL 404s when this guide is followed later, get the latest from https://github.com/klaro-org/klaro-js/releases — the API has been stable since v0.6.
- **GDPR/UOOÚ check at the end**: the cookie banner must (a) appear before any non-essential cookie is set, (b) make Reject as prominent as Accept, (c) have a way to withdraw consent later. Klaro with the config above satisfies all three.
- **Don't add Google Tag Manager** unless Martin specifically wants it. For a 3-page static site, GTM is overhead with no payoff.
- **If the client wants Search Console linked**: GA4 → Admin → Product Links → Search Console links. They have to verify ownership of `oktours.cz` in GSC first (DNS TXT method recommended — see the SEO setup notes elsewhere in this repo).
- **Before this whole exercise, also reconsider Plausible/Umami**: if all the client really wants is "how many visitors and from where", a privacy-first analytics tool skips this entire setup, including the cookie banner. Worth raising as a question. See the original SEO/Analytics plan in `ok-tours/CLAUDE.md` for the trade-off.

---

## Reference: file structure after these changes

```
ok-tours/
├── index.html               (modified: <head> patched, contact form patched, footer Cookies link)
├── index-en.html            (modified: same as index.html)
├── dlouhodobe-pronajmy.html (modified: same)
├── analytics.js             (NEW: gtag config + event listeners)
├── klaro-config.js          (NEW: cookie banner config)
├── klaro.js                 (NEW: ~50 KB Klaro library, self-hosted)
└── SETUP_GA4.md             (this file — keep in repo for future reference)
```

The `SETUP_GA4.md` file should NOT be deployed to the production server (it's documentation only). It's already excluded by the `--exclude='SETUP_GA4.md'` flag in the rsync command in step 7.

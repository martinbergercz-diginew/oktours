// GA4 + Consent Mode v2 — custom event listeners.
// The inline <head> block already calls gtag('consent','default','denied') and
// loads gtag.js. This file adds custom events. Measurement ID is set at the
// gtag('config', …) call below.

window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
window.gtag = gtag;

// Consent default is already set in the inline <head> block (must run BEFORE
// gtag.js). Repeating here is harmless redundancy in case this file loads first.
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500,
});

gtag('js', new Date());
gtag('config', 'G-YFBKZHVLZ3', {
  anonymize_ip: true,
  send_page_view: true,
});

// Custom events
document.addEventListener('DOMContentLoaded', () => {
  // language_switch — bind to flag/language links in nav (CS↔EN)
  document.querySelectorAll('a[href$="index.html"], a[href$="index-en.html"], a[href="/"]').forEach((a) => {
    a.addEventListener('click', () => {
      const target = a.href.includes('-en') ? 'en' : 'cs';
      const from = document.documentElement.lang;
      if (from !== target) {
        gtag('event', 'language_switch', { from, to: target, transport_type: 'beacon' });
      }
    });
  });

  // file_download — delegated, matches all PDF links anywhere on the page
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href$=".pdf"]');
    if (!a) return;
    gtag('event', 'file_download', {
      file_name: a.href.split('/').pop(),
      file_extension: 'pdf',
      link_url: a.href,
    });
  });
});

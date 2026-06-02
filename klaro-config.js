// Klaro! cookie banner config — bilingual (CS default, EN if <html lang="en">).
// Loaded BEFORE klaro.js by the <head> patch.
window.klaroConfig = {
  version: 1,
  elementID: "klaro",
  storageMethod: "cookie",
  storageName: "klaro-consent",
  cookieExpiresAfterDays: 180,
  htmlTexts: true,
  default: false,
  mustConsent: false,           // passive banner, not a blocking modal
  acceptAll: true,
  hideDeclineAll: false,        // GDPR requires Reject as prominent as Accept
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
      privacyPolicy: {
        name: "Zásadami GDPR",
        text: "Souhlasem potvrzujete znalost našich {privacyPolicy}.",
      },
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
      privacyPolicy: {
        name: "GDPR Policy",
        text: "By accepting you confirm familiarity with our {privacyPolicy}.",
      },
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

// Registry of visible site pages and their language variants. Used by
// list_pages tool. Pulled into Claude's context so it knows where things
// live.
//
// If a new page is added to the site, add it here. Future improvement:
// auto-detect by scanning the repo for top-level *.html files with
// <html lang="..."> headers.

export const SITE_CONFIG = {
  pages: [
    {
      path: "index.html",
      language: "cs",
      title: "Hlavní stránka (CZ)",
      counterpart: "index-en.html",
    },
    {
      path: "index-en.html",
      language: "en",
      title: "Homepage (EN)",
      counterpart: "index.html",
    },
    {
      path: "dlouhodobe-pronajmy.html",
      language: "cs",
      title: "Dlouhodobé pronájmy (CZ)",
      counterpart: null,
    },
  ],
  // Top-level dirs Claude is likely to touch.
  content_dirs: ["sections/", "team/", "hotel_photos/", "logos/", "docs/", "uploads/"],
};

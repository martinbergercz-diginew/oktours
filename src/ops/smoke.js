// Smoke tests for a deployed directory. Run against the rendered files
// directly (file:// or via a temporary file_server), not the public URL,
// so we can test before exposing to the network.
//
// MVP version: parse the HTML and check for basic structural markers.
// v1.1 will load each page in headless Chromium and check console errors.

import fs from "node:fs/promises";
import path from "node:path";
import { SITE_CONFIG } from "../site-config.js";

const REQUIRED_PAGES = SITE_CONFIG.pages.map(p => p.path);

export async function smokeCheck(deployRoot) {
  const failures = [];
  for (const relPath of REQUIRED_PAGES) {
    const full = path.join(deployRoot, relPath);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) {
        failures.push(`${relPath}: not a regular file`);
        continue;
      }
      const html = await fs.readFile(full, "utf8");
      if (html.length < 500) {
        failures.push(`${relPath}: suspiciously small (${html.length} bytes)`);
      }
      if (!/<title>[^<]+<\/title>/i.test(html)) {
        failures.push(`${relPath}: missing <title>`);
      }
      if (!/<h1\b[^>]*>/i.test(html) && !/<header\b/i.test(html)) {
        failures.push(`${relPath}: missing <h1> or <header>`);
      }
      const openTags = (html.match(/<(div|section|main|header|footer|nav)\b/gi) || []).length;
      const closeTags = (html.match(/<\/(div|section|main|header|footer|nav)>/gi) || []).length;
      if (Math.abs(openTags - closeTags) > 2) {
        failures.push(`${relPath}: unbalanced structural tags (${openTags} open / ${closeTags} close)`);
      }
    } catch (err) {
      failures.push(`${relPath}: ${err.message}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// Path validation. All Claude file ops route through here.
// Rejects: path traversal, absolute paths outside repo, symlinks, dotfiles,
// .git/, anything not under the repo root.

import path from "node:path";
import fs from "node:fs";

const WRITABLE_EXTENSIONS = new Set([
  ".html", ".css", ".md", ".txt", ".xml", ".json",
  ".jpg", ".jpeg", ".png", ".webp", ".pdf", ".svg",
]);

const WRITABLE_DIR_PREFIXES = [
  "docs/", "uploads/", "team/", "sections/", "hotel_photos/", "logos/",
];

// Files that may be OVERWRITTEN but NEVER deleted. Includes the 3 pages,
// the contact form, repo-internal files, and the 5 legal PDFs.
export const PROTECTED_FILES = new Set([
  "index.html",
  "index-en.html",
  "dlouhodobe-pronajmy.html",
  "send-mail.php",
  "CLAUDE.md",
  ".gitignore",
  "robots.txt",
  "sitemap.xml",
  // Legal PDFs — names may differ from the actual repo; tune after first run.
  "docs/GDPR.pdf",
  "docs/obchodni-podminky.pdf",
  "docs/pojisteni.pdf",
  "docs/iata.pdf",
  "docs/koncesni-listina.pdf",
]);

// Files Claude cannot touch at all (write OR delete).
const BLOCKED_PATTERNS = [
  /\.php$/i,
  /\.sh$/i,
  /^\.[^/]+/,           // dotfiles at root (except .gitignore handled below)
  /(^|\/)\.git\//,
  /(^|\/)\.env/,
  /(^|\/)\.claude\//,
  /(^|\/)node_modules\//,
  /^Caddyfile/i,
  /^admin-service\//,   // never edit ourselves
];

// Files which are READ-only for Claude (but not blocked) — these can be
// read but writes are refused.
const READ_ONLY_PATTERNS = [
  /^ADMIN_CHAT_SPEC\.md$/,
  /^SETUP_GA4\.md$/,
  /^CLAUDE\.md$/,
];

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Normalize a user-supplied repo-relative path and reject anything unsafe.
 * Returns the absolute path under the repo root.
 */
export function resolveRepoPath(repoRoot, relative) {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new PathError("Path is required.");
  }
  if (relative.startsWith("/")) {
    throw new PathError("Absolute paths are not allowed.");
  }
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (normalized.includes("..") || normalized.startsWith("../")) {
    throw new PathError(`Path traversal rejected: ${relative}`);
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new PathError(`Path is blocked: ${relative}`);
    }
  }
  const absolute = path.resolve(repoRoot, normalized);
  const repoRootResolved = path.resolve(repoRoot);
  if (!absolute.startsWith(repoRootResolved + path.sep) && absolute !== repoRootResolved) {
    throw new PathError(`Path escapes repo root: ${relative}`);
  }
  // Reject if any segment resolves through a symlink to outside the repo.
  // Compare realpaths on BOTH sides so symlinked roots (e.g. /tmp →
  // /private/tmp on macOS) don't falsely trip this.
  if (fs.existsSync(absolute)) {
    const realRoot = fs.realpathSync(repoRootResolved);
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      throw new PathError(`Symlink escapes repo root: ${relative}`);
    }
  }
  return absolute;
}

/**
 * Check that a path is writable by Claude. Returns the absolute path
 * or throws PathError.
 */
export function assertWritable(repoRoot, relative) {
  const absolute = resolveRepoPath(repoRoot, relative);
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new PathError(`File is read-only for Claude: ${relative}`);
    }
  }
  const ext = path.extname(normalized).toLowerCase();
  const hasAllowedExt = WRITABLE_EXTENSIONS.has(ext);
  const hasAllowedDir = WRITABLE_DIR_PREFIXES.some(prefix => normalized.startsWith(prefix));
  // Top-level HTML / CSS / robots / sitemap / klaro-config etc. allowed by extension.
  if (!hasAllowedExt && !hasAllowedDir) {
    throw new PathError(`Path is not in the writable allowlist: ${relative}`);
  }
  return absolute;
}

/**
 * Check that a path is deletable. Same as writable but additionally rejects
 * PROTECTED_FILES.
 */
export function assertDeletable(repoRoot, relative) {
  const absolute = assertWritable(repoRoot, relative);
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (PROTECTED_FILES.has(normalized)) {
    throw new PathError(`Protected file cannot be deleted: ${relative}`);
  }
  return absolute;
}

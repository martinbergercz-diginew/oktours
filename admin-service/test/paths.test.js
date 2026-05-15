import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRepoPath, assertWritable, assertDeletable, PathError, PROTECTED_FILES } from "../src/paths.js";

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ok-paths-"));

test("resolveRepoPath: allows nested relative path", () => {
  const p = resolveRepoPath(repoRoot, "team/photo.jpg");
  assert.equal(p, path.join(repoRoot, "team/photo.jpg"));
});

test("resolveRepoPath: rejects path traversal", () => {
  assert.throws(() => resolveRepoPath(repoRoot, "../etc/passwd"), PathError);
  assert.throws(() => resolveRepoPath(repoRoot, "team/../../etc/passwd"), PathError);
});

test("resolveRepoPath: rejects absolute paths", () => {
  assert.throws(() => resolveRepoPath(repoRoot, "/etc/passwd"), PathError);
});

test("resolveRepoPath: rejects .git/", () => {
  assert.throws(() => resolveRepoPath(repoRoot, ".git/HEAD"), PathError);
  assert.throws(() => resolveRepoPath(repoRoot, "foo/.git/objects"), PathError);
});

test("resolveRepoPath: rejects .env", () => {
  assert.throws(() => resolveRepoPath(repoRoot, ".env"), PathError);
});

test("resolveRepoPath: rejects admin-service/", () => {
  assert.throws(() => resolveRepoPath(repoRoot, "admin-service/src/server.js"), PathError);
});

test("assertWritable: allows index.html", () => {
  assert.doesNotThrow(() => assertWritable(repoRoot, "index.html"));
});

test("assertWritable: allows files under team/", () => {
  assert.doesNotThrow(() => assertWritable(repoRoot, "team/silvie.jpg"));
});

test("assertWritable: rejects .php", () => {
  assert.throws(() => assertWritable(repoRoot, "send-mail.php"), PathError);
});

test("assertWritable: rejects .sh", () => {
  assert.throws(() => assertWritable(repoRoot, "deploy.sh"), PathError);
});

test("assertWritable: rejects unknown extension at root", () => {
  assert.throws(() => assertWritable(repoRoot, "random.config"), PathError);
});

test("assertWritable: rejects CLAUDE.md (read-only)", () => {
  assert.throws(() => assertWritable(repoRoot, "CLAUDE.md"), PathError);
});

test("assertDeletable: blocks all PROTECTED_FILES", () => {
  for (const protectedPath of PROTECTED_FILES) {
    assert.throws(
      () => assertDeletable(repoRoot, protectedPath),
      PathError,
      `Expected ${protectedPath} to be undeletable`
    );
  }
});

test("assertDeletable: allows deleting an uploads/ image", () => {
  assert.doesNotThrow(() => assertDeletable(repoRoot, "uploads/test.jpg"));
});

test("assertWritable: still allows overwriting a legal PDF (write OK, delete NO)", () => {
  assert.doesNotThrow(() => assertWritable(repoRoot, "docs/pojisteni.pdf"));
  assert.throws(() => assertDeletable(repoRoot, "docs/pojisteni.pdf"), PathError);
});

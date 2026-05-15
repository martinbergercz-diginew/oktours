import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTool } from "../src/tools/index.js";
import { UploadsStore } from "../src/uploads-store.js";
import { SITE_CONFIG } from "../src/site-config.js";

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ok-edit-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Hello world</h1>\n<p>foo bar</p>");
  return root;
}

function makeCtx(repoRoot) {
  return {
    repoRoot,
    draft: { writes: {}, deletes: [], summary_cs: "", affected_pages: [], is_destructive: false, awaiting_confirmation: false },
    siteConfig: SITE_CONFIG,
    uploadsStore: new UploadsStore(),
  };
}

test("edit_text_in_file: simple substring swap", async () => {
  const ctx = makeCtx(makeRepo());
  const r = await runTool("edit_text_in_file", { path: "index.html", old_text: "Hello world", new_text: "Ahoj světe" }, ctx);
  assert.equal(r.is_error, false);
  assert.match(ctx.draft.writes["index.html"], /Ahoj světe/);
  assert.doesNotMatch(ctx.draft.writes["index.html"], /Hello world/);
});

test("edit_text_in_file: rejects substring not in file", async () => {
  const ctx = makeCtx(makeRepo());
  const r = await runTool("edit_text_in_file", { path: "index.html", old_text: "Goodbye", new_text: "X" }, ctx);
  assert.equal(r.is_error, true);
  assert.match(r.content, /not found/);
});

test("edit_text_in_file: rejects ambiguous (multi-occurrence)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ok-edit-"));
  fs.writeFileSync(path.join(root, "index.html"), "<p>foo</p><p>foo</p>");
  const ctx = makeCtx(root);
  const r = await runTool("edit_text_in_file", { path: "index.html", old_text: "<p>foo</p>", new_text: "<p>bar</p>" }, ctx);
  assert.equal(r.is_error, true);
  assert.match(r.content, /appears 2 times/);
});

test("edit_text_in_file: edits against prior draft, not disk", async () => {
  const ctx = makeCtx(makeRepo());
  await runTool("edit_text_in_file", { path: "index.html", old_text: "Hello world", new_text: "Ahoj" }, ctx);
  // Second edit must see "Ahoj" (staged) not "Hello world" (disk).
  const r2 = await runTool("edit_text_in_file", { path: "index.html", old_text: "Ahoj", new_text: "Nazdar" }, ctx);
  assert.equal(r2.is_error, false);
  assert.match(ctx.draft.writes["index.html"], /Nazdar/);
});

test("edit_text_in_file: refuses empty old_text", async () => {
  const ctx = makeCtx(makeRepo());
  const r = await runTool("edit_text_in_file", { path: "index.html", old_text: "", new_text: "x" }, ctx);
  assert.equal(r.is_error, true);
});

test("edit_text_in_file: respects path allowlist", async () => {
  const ctx = makeCtx(makeRepo());
  const r = await runTool("edit_text_in_file", { path: "send-mail.php", old_text: "x", new_text: "y" }, ctx);
  assert.equal(r.is_error, true);
});

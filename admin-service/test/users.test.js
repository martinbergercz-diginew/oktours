import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the user store in a throwaway DATA_DIR before importing users.js.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oktours-users-"));
process.env.SESSION_SECRET = "test-secret-test-secret-0123456789";

const users = await import("../src/users.js");

test("seedFirstAdmin creates one admin, then is a no-op", async () => {
  const a = await users.seedFirstAdmin({ email: "Admin@OKTOURS.cz", password: "seedpass123" });
  assert.equal(a.seeded, true);
  assert.equal(a.email, "admin@oktours.cz");          // normalized
  const b = await users.seedFirstAdmin({ email: "other@x.cz", password: "whatever1" });
  assert.equal(b.seeded, false);
  const list = await users.listUsers();
  assert.equal(list.length, 1);
  assert.equal(list[0].role, "admin");
});

test("verifyLogin accepts the seeded admin, rejects bad password", async () => {
  const ok = await users.verifyLogin("admin@oktours.cz", "seedpass123");
  assert.equal(ok.ok, true);
  assert.equal(ok.user.role, "admin");
  const bad = await users.verifyLogin("admin@oktours.cz", "nope");
  assert.equal(bad.ok, false);
});

test("createUser enforces email, role, password length, uniqueness", async () => {
  const u = await users.createUser({ email: "editor@oktours.cz", role: "editor", password: "editorpass1" });
  assert.equal(u.role, "editor");
  await assert.rejects(() => users.createUser({ email: "editor@oktours.cz", role: "editor", password: "editorpass1" }), /už existuje/);
  await assert.rejects(() => users.createUser({ email: "bad", role: "editor", password: "editorpass1" }), /e-mail/i);
  await assert.rejects(() => users.createUser({ email: "x@y.cz", role: "editor", password: "short" }), /8 znaků/);
  await assert.rejects(() => users.createUser({ email: "x@y.cz", role: "boss", password: "longenough1" }), /role/i);
});

test("setPassword bumps credentialVersion (invalidates old sessions)", async () => {
  const before = await users.findByEmail("editor@oktours.cz");
  const cvBefore = before.credentialVersion;          // snapshot the number
  await users.setPassword(before.id, "newpassword1");
  const after = await users.findById(before.id);
  assert.equal(after.credentialVersion, cvBefore + 1);
  assert.equal((await users.verifyLogin("editor@oktours.cz", "newpassword1")).ok, true);
});

test("cannot demote or delete the last admin", async () => {
  const admin = await users.findByEmail("admin@oktours.cz");
  await assert.rejects(() => users.setRole(admin.id, "editor"), /poslední/);
  await assert.rejects(() => users.deleteUser(admin.id), /poslední/);
});

test("reset token is one-time and returns the right user", async () => {
  const editor = await users.findByEmail("editor@oktours.cz");
  const token = await users.createResetToken(editor.id);
  assert.equal(await users.consumeResetToken(token), editor.id);
  assert.equal(await users.consumeResetToken(token), null);   // already spent
  assert.equal(await users.consumeResetToken("bogus"), null);
});

test.after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

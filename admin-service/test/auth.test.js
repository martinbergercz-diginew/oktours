import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = "test-secret-test-secret-0123456789";

const {
  hashPassword, verifyPassword, issueToken, readToken,
  parseCookies, sessionCookie, clearCookie, COOKIE_NAME,
} = await import("../src/auth.js");

test("hashPassword / verifyPassword round-trips", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
  assert.equal(verifyPassword("", hash), false);
});

test("two hashes of the same password differ (random salt)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("verifyPassword rejects malformed stored hashes", () => {
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", undefined), false);
});

const fakeUser = { id: "u_123", credentialVersion: 4 };

test("issued token carries the user id + credential version", () => {
  const payload = readToken(issueToken(fakeUser));
  assert.equal(payload.uid, "u_123");
  assert.equal(payload.cv, 4);
});

test("readToken rejects tampered / malformed tokens", () => {
  const token = issueToken(fakeUser);
  assert.equal(readToken(token + "x"), null);
  assert.equal(readToken(token.replace(/^./, "A")), null);
  assert.equal(readToken("garbage"), null);
  assert.equal(readToken(""), null);
  assert.equal(readToken(undefined), null);
});

test("readToken rejects an expired token", () => {
  const body = Buffer.from(JSON.stringify({ uid: "u_1", cv: 1, iat: 0, exp: 1 })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(body).digest("base64url");
  assert.equal(readToken(`${body}.${sig}`), null);
});

test("parseCookies handles the session cookie", () => {
  const token = issueToken(fakeUser);
  const parsed = parseCookies(`foo=bar; ${COOKIE_NAME}=${token}; baz=qux`);
  assert.equal(parsed[COOKIE_NAME], token);
  assert.equal(parsed.foo, "bar");
  assert.deepEqual(parseCookies(undefined), {});
});

test("sessionCookie / clearCookie produce expected attributes", () => {
  const c = sessionCookie("tok", { secure: true });
  assert.match(c, /^oktours_admin_session=tok/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(sessionCookie("tok", { secure: false }), /Secure/);
  assert.match(clearCookie({ secure: false }), /Max-Age=0/);
});

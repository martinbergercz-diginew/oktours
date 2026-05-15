import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = "test-secret-test-secret-0123456789";
process.env.ADMIN_PASSWORD = "hunter2-correct-horse";

const {
  checkPassword, isAuthConfigured, issueToken, verifyToken,
  parseCookies, sessionCookie, clearCookie, COOKIE_NAME,
} = await import("../src/auth.js");

test("isAuthConfigured reflects ADMIN_PASSWORD", () => {
  assert.equal(isAuthConfigured(), true);
});

test("checkPassword accepts the right password, rejects others", () => {
  assert.equal(checkPassword("hunter2-correct-horse"), true);
  assert.equal(checkPassword("wrong"), false);
  assert.equal(checkPassword(""), false);
  assert.equal(checkPassword(undefined), false);
  assert.equal(checkPassword("hunter2-correct-horse "), false); // length mismatch
});

test("issued token verifies", () => {
  const token = issueToken();
  assert.equal(verifyToken(token), true);
});

test("verifyToken rejects tampered / malformed tokens", () => {
  const token = issueToken();
  assert.equal(verifyToken(token + "x"), false);          // bad signature
  assert.equal(verifyToken(token.replace(/^./, "A")), false); // bad payload
  assert.equal(verifyToken("garbage"), false);
  assert.equal(verifyToken(""), false);
  assert.equal(verifyToken(undefined), false);
});

test("verifyToken rejects an expired token", () => {
  // Hand-build a token with a past expiry, signed with the real secret.
  const body = Buffer.from(JSON.stringify({ iat: 0, exp: 1 })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(body).digest("base64url");
  assert.equal(verifyToken(`${body}.${sig}`), false);
});

test("parseCookies handles the session cookie", () => {
  const token = issueToken();
  const header = `foo=bar; ${COOKIE_NAME}=${token}; baz=qux`;
  const parsed = parseCookies(header);
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
  assert.match(c, /Path=\/admin/);

  const insecure = sessionCookie("tok", { secure: false });
  assert.doesNotMatch(insecure, /Secure/);

  const cleared = clearCookie({ secure: false });
  assert.match(cleared, /Max-Age=0/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveExpiresAt } = require("../../src/expiration");

test("resolveExpiresAt accepts an absolute expiresAt", () => {
  assert.equal(resolveExpiresAt({ expiresAt: "2026-08-01T00:00:00.000Z" }), "2026-08-01T00:00:00.000Z");
});

test("resolveExpiresAt accepts expirationHours from now", () => {
  const before = Date.now();
  const resolved = new Date(resolveExpiresAt({ expirationHours: 24 })).getTime();
  const after = Date.now();
  assert.ok(resolved >= before + 24 * 60 * 60 * 1000);
  assert.ok(resolved <= after + 24 * 60 * 60 * 1000);
});

test("resolveExpiresAt allows negative hours so admins can force-expire", () => {
  const resolved = new Date(resolveExpiresAt({ expirationHours: -1 })).getTime();
  assert.ok(resolved < Date.now());
});

test("resolveExpiresAt rejects malformed input with status 400", () => {
  for (const input of [{}, { expiresAt: "not-a-date" }, { expirationHours: 0 }, { expirationHours: "abc" }, null]) {
    try {
      resolveExpiresAt(input);
      assert.fail("expected resolveExpiresAt to throw");
    } catch (err) {
      assert.equal(err.status, 400);
    }
  }
});

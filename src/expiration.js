// Shared by the Node server (server.js) and the Cloudflare Worker
// (cloudflare-worker.ts): resolves the payload of POST /instance/:code/expiration
// into an EXPIRES_AT ISO timestamp. Accepts either an absolute expiresAt or an
// expirationHours offset from now. Negative hours are allowed so an admin can
// force-expire an instance early.
function resolveExpiresAt(input) {
  if (input && input.expiresAt !== undefined && input.expiresAt !== "") {
    const date = new Date(input.expiresAt);
    if (Number.isNaN(date.getTime())) throw badExpiration("Invalid expiresAt");
    return date.toISOString();
  }
  const hours = Number(input && input.expirationHours);
  if (!Number.isFinite(hours) || hours === 0) throw badExpiration("Provide expiresAt or a non-zero expirationHours");
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function badExpiration(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = { resolveExpiresAt };

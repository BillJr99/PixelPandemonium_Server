// Single source of truth for the deployed application version reported by the
// /health endpoint on both runtimes (Node server and Cloudflare Worker).
// Bump this on every deploy so /health can be used to confirm what is live.
const APP_VERSION = "0.0.5";

module.exports = { APP_VERSION };

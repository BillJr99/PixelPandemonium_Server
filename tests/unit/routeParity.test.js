const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The Node server and the Cloudflare Worker are two deployments of the same
// API. The integration suite (test.sh) only exercises the Node server, so a
// route added there but forgotten in the Worker 404s in production while every
// test stays green (this is exactly how POST /pictures/custom regressed).
// This test extracts the Express route table and asserts the Worker source
// contains a matcher for each path.

const serverSource = fs.readFileSync(path.join(__dirname, "../../src/server.js"), "utf8");
const workerSource = fs.readFileSync(path.join(__dirname, "../../src/cloudflare-worker.ts"), "utf8");

function expressRoutes() {
  const routes = [];
  const pattern = /app\.(get|post)\(\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(serverSource))) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

function workerInstanceActions() {
  const alternation = workerSource.match(/\/instance\S*\\\/\((?<actions>[a-z|-]+)\)\$\//);
  assert.ok(alternation, "worker per-instance action alternation not found");
  return alternation.groups.actions.split("|");
}

function workerEventActions() {
  const alternation = workerSource.match(/event\S*\\\/\((?<actions>[a-z|]+)\)\$\//);
  assert.ok(alternation, "worker per-event action alternation not found");
  return alternation.groups.actions.split("|");
}

function workerHandles(routePath) {
  if (routePath === "/pictures/:id/spec.js") return /\/pictures\S*spec\\\.js\$\//.test(workerSource);
  if (routePath === "/pictures/:id/spec-files.zip") return /\/pictures\S*spec-files\\\.zip\$\//.test(workerSource);
  const instanceAction = routePath.match(/^\/instance\/:code\/([a-z-]+)$/);
  if (instanceAction) return workerInstanceActions().includes(instanceAction[1]);
  const eventAction = routePath.match(/^\/instance\/:code\/event\/:id\/([a-z-]+)$/);
  if (eventAction) return workerEventActions().includes(eventAction[1]);
  return workerSource.includes(`url.pathname === "${routePath}"`);
}

test("every Express route has a Cloudflare Worker counterpart", () => {
  const routes = expressRoutes();
  assert.ok(routes.length >= 15, `expected the Express route extraction to find the API surface, got ${routes.length}`);
  const missing = routes.filter((route) => !workerHandles(route.path)).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(missing, [], `Routes present in server.js but not matched in cloudflare-worker.ts: ${missing.join(", ")}`);
});

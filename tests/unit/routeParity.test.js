const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The Node server and the Cloudflare Worker are two deployments of the same
// API. The integration suite (test.sh) only exercises the Node server, so a
// route added there but forgotten in the Worker 404s in production while every
// test stays green (this is exactly how POST /pictures/custom regressed).
// This test extracts the Express route table (path AND method) and asserts the
// Worker source contains a matcher for each — a same-path handler restricted
// to the wrong method is treated as missing.

const serverSource = fs.readFileSync(path.join(__dirname, "../../src/server.js"), "utf8");
const workerSource = fs.readFileSync(path.join(__dirname, "../../src/cloudflare-worker.ts"), "utf8");
const workerLines = workerSource.split("\n");

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

function linesContaining(needle) {
  return workerLines.filter((line) => line.includes(needle));
}

function anyLineWithMethod(lines, method) {
  // A matcher with no method restriction accepts every method.
  if (lines.some((line) => !line.includes("request.method"))) return true;
  return lines.some((line) => line.includes(`request.method === "${method}"`));
}

function workerHandles(routePath, method) {
  if (routePath === "/pictures/:id/spec.js") {
    return anyLineWithMethod(linesContaining("specMatch && "), method);
  }
  if (routePath === "/pictures/:id/spec-files.zip") {
    return anyLineWithMethod(linesContaining("zipMatch && "), method);
  }
  const instanceAction = routePath.match(/^\/instance\/:code\/([a-z-]+)$/);
  if (instanceAction) {
    if (!workerInstanceActions().includes(instanceAction[1])) return false;
    return anyLineWithMethod(linesContaining(`action === "${instanceAction[1]}"`), method);
  }
  const eventAction = routePath.match(/^\/instance\/:code\/event\/:id\/([a-z-]+)$/);
  if (eventAction) {
    if (!workerEventActions().includes(eventAction[1])) return false;
    return anyLineWithMethod(linesContaining("eventMatch && "), method);
  }
  const literalLines = linesContaining(`url.pathname === "${routePath}"`);
  if (!literalLines.length) return false;
  return anyLineWithMethod(literalLines, method);
}

test("every Express route has a Cloudflare Worker counterpart with a matching method", () => {
  const routes = expressRoutes();
  assert.ok(routes.length >= 15, `expected the Express route extraction to find the API surface, got ${routes.length}`);
  const missing = routes
    .filter((route) => !workerHandles(route.path, route.method))
    .map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(missing, [], `Routes present in server.js but not matched (path + method) in cloudflare-worker.ts: ${missing.join(", ")}`);
});

test("the parity check notices a wrong-method handler", () => {
  // Self-test of the matcher: /pictures/custom exists only as POST in the
  // Worker, so asking for GET must fail — otherwise the method check is inert.
  assert.equal(workerHandles("/pictures/custom", "POST"), true);
  assert.equal(workerHandles("/pictures/custom", "GET"), false);
});

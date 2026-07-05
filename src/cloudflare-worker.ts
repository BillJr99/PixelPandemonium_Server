import { APP_VERSION } from "./version";
import { isTetrisDemoCode, tetrisInsertError } from "./tetrisDemo";
import { customPictureId, validateSpec, specToJs, generateArtifacts, zipFiles } from "./customPictures";
import { resolveExpiresAt } from "./expiration";

export interface Env {
  DB: D1Database;
  PUBSUB: DurableObjectNamespace<PubSubRoom>;
  RATELIMIT: DurableObjectNamespace<RateLimitBucket>;
  ALLOWED_ORIGINS: string;
  CLIENT_BASE_URL: string;
  DEFAULT_EXPIRATION_HOURS: string;
  RATE_LIMIT_MAX_PER_SECOND: string;
  RATE_LIMIT_MAX_PER_MINUTE: string;
  RATE_LIMIT_MAX_PER_DAY: string;
  ADMIN_PASSWORD: string;
  DEFAULT_TEACHER_KEY: string;
  LEGACY_ROUTES_ENABLED: string;
  AUTH_FAILURE_LIMIT: string;
  AUTH_FAILURE_WINDOW_MINUTES: string;
  AUTH_ADMIN_BAN_DAYS: string;
  AUTH_TEACHER_BAN_MINUTES: string;
  AUTH_STUDENT_BAN_MINUTES: string;
}

interface ClientAttachment {
  channel: string;
  windowStart?: number;
  count?: number;
}

// Per-connection realtime guards. The WebSocket upgrade itself is already IP
// rate limited like every other request; these bound abuse over an open socket.
const WS_MAX_MESSAGE_BYTES = 64 * 1024;
const WS_MAX_MESSAGES_PER_SECOND = 50;

interface RateLimitState {
  secondBucket: number;
  secondCount: number;
  minuteBucket: number;
  minuteCount: number;
  dayBucket: number;
  dayCount: number;
}

// Predefined catalog metadata only. The actual spec content lives in D1 (seeded by
// migrations/0003_seed_picture_specs.sql) and is served from /pictures/:id/spec.js —
// it is intentionally NOT bundled here, to keep the Worker script small.
// ensurePictures() upserts only id/title/script/enabled and never touches SPEC_JSON.
const PICTURES = [
  { id: "tetris", title: "Demo (Tetris)" },
  { id: "cs4allpa2022", title: "CS4AllPA-2022" },
  { id: "cs4philly2021", title: "CS4Philly-2021" },
  { id: "cs4philly2022", title: "CS4Philly-2022" },
  { id: "eagles", title: "Eagles" },
  { id: "eagles2", title: "Eagles2" },
  { id: "ghopper", title: "GHopper" },
  { id: "lovestatue", title: "LoveStatue" },
  { id: "mikewazowski", title: "MikeWazowski" },
  { id: "phillyscifest", title: "PhillySciFest-2022" },
  { id: "pixar2022", title: "Pixar-2022" },
  { id: "robotspringboard", title: "RobotSpringboard" },
  { id: "robotspringboard2022", title: "RobotSpringboard-2022" },
  { id: "rocky2022", title: "Rocky-2022" },
  { id: "yellowsubmarine", title: "YellowSubmarine" },
  { id: "yellowsubmarine2022", title: "YellowSubmarine-2022" }
].map((p) => ({ ...p, script: `/pictures/${encodeURIComponent(p.id)}/spec.js` }));

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const candidate = origin.toLowerCase();
  return allowedOrigins(env).some((entry) => {
    const allowed = entry.toLowerCase();
    return candidate === allowed || candidate.endsWith(allowed);
  });
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin && originAllowed(request, env) ? origin : "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With, X-Instance-Key, X-Teacher-Key, X-Admin-Password",
    "access-control-allow-credentials": "true"
  };
}

function json(request: Request, env: Env, body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

async function rateLimitResponse(request: Request, env: Env): Promise<Response | null> {
  if (request.method === "OPTIONS") return null;
  const id = env.RATELIMIT.idFromName(clientIp(request));
  const response = await env.RATELIMIT.get(id).fetch("https://rate-limit/check", {
    method: "POST",
    body: JSON.stringify({
      now: Date.now(),
      second: positiveInt(env.RATE_LIMIT_MAX_PER_SECOND, 10),
      minute: positiveInt(env.RATE_LIMIT_MAX_PER_MINUTE, 60),
      day: positiveInt(env.RATE_LIMIT_MAX_PER_DAY, 10000)
    })
  });
  if (response.status !== 429) return null;
  const body = await response.json().catch(() => ({ limit: "rate-limit" }));
  return json(request, env, { error: "Too many requests from this IP. Please slow down and try again later.", ...body }, { status: 429 });
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function luhnCheckDigit(payloadDigits: string): string {
  const digits = digitsOnly(payloadDigits);
  let sum = 0;
  let alternate = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return String((10 - (sum % 10)) % 10);
}

// Realtime channels are "/faye/messages/<instanceCode>"; returns the instance
// code so the channel can be authorized with that instance's access key.
function realtimeChannelInstanceCode(channel: string): string | null {
  const match = String(channel || "").match(/^\/faye\/messages\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function validateCheckDigit(code: string): boolean {
  if (isTetrisDemoCode(code)) return true;
  const digits = digitsOnly(code);
  if (digits.length < 11) return false;
  const suffix = digits.slice(-11);
  return luhnCheckDigit(suffix.slice(0, -1)) === suffix.slice(-1);
}

function normalizeToken(value: string, fallback: string, length: number): string {
  const token = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (token || fallback).slice(0, length).padEnd(length, fallback[0]);
}

function dateToken(dateTime: string): string {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) {
    // Mirrors the Node server: salvage any digits from the raw value.
    return normalizeToken(dateTime, "00000000", 8).replace(/\D/g, "").padEnd(8, "0").slice(0, 8);
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

function generateInstanceCode(pictureId: string, teacherName: string, dateTime: string): string {
  const picture = normalizeToken(pictureId, "PIC", 3);
  const teacher = normalizeToken(teacherName, "TCH", 4);
  const when = dateToken(dateTime);
  const random = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100).padStart(2, "0");
  const check = luhnCheckDigit(when + random);
  return `${picture}-${teacher}-${when.slice(0, 4)}-${when.slice(4, 6)}${when.slice(6, 8)}-${random}-${check}`;
}

function adminCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function accessKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function studentUrls(env: Env, instanceCode: string, key: string) {
  const base = (env.CLIENT_BASE_URL || "").replace(/\/$/, "");
  if (isTetrisDemoCode(instanceCode)) {
    return {
      studentUrl: `${base}/instructions.html?instance=tetris`,
      replayUrl: `${base}/replay.html?instance=tetris`
    };
  }
  const encodedKey = encodeURIComponent(key || "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}&key=${encodedKey}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}&key=${encodedKey}`
  };
}

function urls(env: Env, instanceCode: string, admin: string, key: string, teacherKey: string) {
  const base = (env.CLIENT_BASE_URL || "").replace(/\/$/, "");
  if (isTetrisDemoCode(instanceCode)) {
    return {
      ...studentUrls(env, instanceCode, key),
      teacherUrl: `${base}/teacher-dashboard.html?instance=tetris`,
      adminUrl: `${base}/admin.html?instance=tetris`
    };
  }
  const encodedTeacherKey = encodeURIComponent(teacherKey || "");
  return {
    ...studentUrls(env, instanceCode, key),
    teacherUrl: `${base}/teacher-dashboard.html?instance=${encodeURIComponent(instanceCode)}&teacherKey=${encodedTeacherKey}&admin=${encodeURIComponent(admin)}`,
    adminUrl: `${base}/admin.html?instance=${encodeURIComponent(instanceCode)}&teacherKey=${encodedTeacherKey}&admin=${encodeURIComponent(admin)}`
  };
}

// Thrown while streaming a request body that exceeds MAX_BODY_BYTES; the fetch
// wrapper turns it into a 413. Content-Length alone is not enough — clients can
// omit or misstate it.
class PayloadTooLargeError extends Error {}

async function readBodyTextCapped(request: Request): Promise<string> {
  const reader = request.body ? request.body.getReader() : null;
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError("Payload too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readRequestBody(request: Request): Promise<Record<string, any>> {
  const text = await readBodyTextCapped(request);
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return text ? JSON.parse(text) : {};
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  return text ? { data: text } : {};
}

function adminPasswordFromRequest(request: Request, url: URL, body?: Record<string, any>): string {
  return request.headers.get("x-admin-password") || body?.adminPassword || url.searchParams.get("adminPassword") || "";
}

function authFailureKey(request: Request, category: string): string {
  return `${category}:${clientIp(request)}`;
}

function authFailureLimit(env: Env): number {
  return positiveInt(env.AUTH_FAILURE_LIMIT, 5);
}

function authFailureWindowMs(env: Env): number {
  return positiveInt(env.AUTH_FAILURE_WINDOW_MINUTES, 10) * 60 * 1000;
}

function authBanMs(env: Env, category: string): number {
  if (category === "teacher") return positiveInt(env.AUTH_TEACHER_BAN_MINUTES, 10) * 60 * 1000;
  if (category === "student") return positiveInt(env.AUTH_STUDENT_BAN_MINUTES, 10) * 60 * 1000;
  return positiveInt(env.AUTH_ADMIN_BAN_DAYS, 1) * 24 * 60 * 60 * 1000;
}

async function requireNotAuthBanned(request: Request, env: Env, category: string): Promise<Response | null> {
  const key = authFailureKey(request, category);
  const row = await env.DB.prepare("SELECT * FROM AUTH_FAILURES WHERE IP = ?").bind(key).first<any>();
  if (!row || !row.BANNED_UNTIL) return null;
  if (new Date(row.BANNED_UNTIL).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM AUTH_FAILURES WHERE IP = ?").bind(key).run();
    return null;
  }
  return json(request, env, { error: `Too many failed ${category} authentication attempts. Try again later.` }, { status: 429 });
}

async function recordAuthFailure(request: Request, env: Env, category: string, reason: string): Promise<void> {
  const key = authFailureKey(request, category);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = await env.DB.prepare("SELECT * FROM AUTH_FAILURES WHERE IP = ?").bind(key).first<any>();
  let count = 1;
  let firstAt = nowIso;
  if (row && !row.BANNED_UNTIL && now - new Date(row.FIRST_FAILURE_AT).getTime() <= authFailureWindowMs(env)) {
    count = Number(row.FAILURE_COUNT || 0) + 1;
    firstAt = row.FIRST_FAILURE_AT;
  }
  const bannedUntil = count >= authFailureLimit(env) ? new Date(now + authBanMs(env, category)).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO AUTH_FAILURES (IP, FAILURE_COUNT, FIRST_FAILURE_AT, BANNED_UNTIL)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(IP) DO UPDATE SET
       FAILURE_COUNT = excluded.FAILURE_COUNT,
       FIRST_FAILURE_AT = excluded.FIRST_FAILURE_AT,
       BANNED_UNTIL = excluded.BANNED_UNTIL`
  ).bind(key, count, firstAt, bannedUntil).run();
  console.warn(JSON.stringify({ level: "warn", message: "Authentication failure recorded", ip: clientIp(request), category, reason, count, bannedUntil }));
}

async function clearAuthFailures(request: Request, env: Env, category: string): Promise<void> {
  await env.DB.prepare("DELETE FROM AUTH_FAILURES WHERE IP = ?").bind(authFailureKey(request, category)).run();
}

async function authError(request: Request, env: Env, category: string, reason: string, message: string): Promise<Response> {
  await recordAuthFailure(request, env, category, reason);
  return json(request, env, { error: message }, { status: 403 });
}

async function adminPasswordError(request: Request, env: Env, url: URL, body?: Record<string, any>): Promise<Response | null> {
  const banned = await requireNotAuthBanned(request, env, "admin");
  if (banned) return banned;
  const expected = env.ADMIN_PASSWORD || "admin";
  if (!expected || adminPasswordFromRequest(request, url, body) === expected) {
    await clearAuthFailures(request, env, "admin");
    return null;
  }
  return authError(request, env, "admin", "admin-password", "Invalid admin password");
}

function accessKeyFromRequest(request: Request, url: URL, body?: Record<string, any>): string {
  return request.headers.get("x-instance-key") || body?.accessKey || url.searchParams.get("key") || url.searchParams.get("accessKey") || "";
}

function teacherKeyFromRequest(request: Request, url: URL, body?: Record<string, any>): string {
  return request.headers.get("x-teacher-key") || body?.teacherKey || url.searchParams.get("teacherKey") || "";
}

async function instanceAccessError(request: Request, env: Env, url: URL, row: any, body?: Record<string, any>): Promise<Response | null> {
  if (isTetrisDemoCode(row.INSTANCE_CODE)) return null;
  const banned = await requireNotAuthBanned(request, env, "student");
  if (banned) return banned;
  if (accessKeyFromRequest(request, url, body) === String(row.ACCESS_KEY || "")) {
    await clearAuthFailures(request, env, "student");
    return null;
  }
  return authError(request, env, "student", "instance-access-key", "Invalid instance access key");
}

async function teacherAccessError(request: Request, env: Env, url: URL, row: any, body?: Record<string, any>): Promise<Response | null> {
  if (isTetrisDemoCode(row.INSTANCE_CODE)) return null;
  const banned = await requireNotAuthBanned(request, env, "teacher");
  if (banned) return banned;
  if (teacherKeyFromRequest(request, url, body) === String(row.TEACHER_KEY || "")) {
    await clearAuthFailures(request, env, "teacher");
    return null;
  }
  return authError(request, env, "teacher", "teacher-key", "Invalid teacher key");
}

function teacherAccessKeyFromRequest(request: Request, url: URL, body?: Record<string, any>): string {
  return request.headers.get("x-teacher-access-key") || body?.teacherAccessKey || url.searchParams.get("teacherAccessKey") || "";
}

async function teacherKeyExists(env: Env, teacherKey: string): Promise<boolean> {
  const key = String(teacherKey || "").trim();
  if (!key) return false;
  const row = await env.DB.prepare("SELECT ID FROM TEACHER_KEYS WHERE TEACHER_KEY = ?").bind(key).first();
  return !!row;
}

async function ensureTeacherKey(env: Env, teacherKey: string, label = "Default Teacher"): Promise<void> {
  const key = String(teacherKey || "").trim();
  if (!key) return;
  await env.DB.prepare(
    `INSERT INTO TEACHER_KEYS (TEACHER_KEY, LABEL)
     VALUES (?, ?)
     ON CONFLICT(TEACHER_KEY) DO UPDATE SET LABEL = COALESCE(TEACHER_KEYS.LABEL, excluded.LABEL)`
  ).bind(key, label).run();
}

async function ensureDefaultTeacherKey(env: Env): Promise<void> {
  if (env.DEFAULT_TEACHER_KEY) await ensureTeacherKey(env, env.DEFAULT_TEACHER_KEY, "Default Teacher");
}

// Validates a global teacher-portal key. Returns the validated key, or an error
// Response (with the teacher IP-ban + auth-failure accounting applied).
async function teacherPortalAccess(request: Request, env: Env, url: URL, body?: Record<string, any>): Promise<{ response?: Response; teacherAccessKey?: string }> {
  const banned = await requireNotAuthBanned(request, env, "teacher");
  if (banned) return { response: banned };
  await ensureDefaultTeacherKey(env);
  const teacherAccessKey = teacherAccessKeyFromRequest(request, url, body);
  if (await teacherKeyExists(env, teacherAccessKey)) {
    await clearAuthFailures(request, env, "teacher");
    return { teacherAccessKey };
  }
  return { response: await authError(request, env, "teacher", "teacher-access-key", "Invalid teacher access key") };
}

// Authorizes a teacher-portal action by either the admin password or a valid
// global teacher key (the public Tetris demo needs neither).
async function adminOrTeacherPortalAccess(request: Request, env: Env, url: URL, body: Record<string, any> | undefined, code?: string): Promise<{ response?: Response; mode?: "demo" | "admin" | "teacher"; teacherAccessKey?: string }> {
  if (code && isTetrisDemoCode(code)) return { mode: "demo", teacherAccessKey: "" };
  if (adminPasswordFromRequest(request, url, body)) {
    const passwordError = await adminPasswordError(request, env, url, body);
    if (passwordError) return { response: passwordError };
    return { mode: "admin", teacherAccessKey: "" };
  }
  const portal = await teacherPortalAccess(request, env, url, body);
  if (portal.response) return { response: portal.response };
  return { mode: "teacher", teacherAccessKey: portal.teacherAccessKey };
}

async function activeInstance(env: Env, code: string) {
  if (!validateCheckDigit(code)) return { error: "Invalid instance code", status: 400 };
  if (isTetrisDemoCode(code)) await ensureDemoInstance(env);
  const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
  if (!row) return { error: "Instance not found", status: 404 };
  if (row.ACTIVE === 0) return { error: "Instance not found", status: 404 };
  if (new Date(row.EXPIRES_AT).getTime() <= Date.now()) return { error: "Instance expired", status: 410, row };
  return { row };
}

async function adminInstance(env: Env, code: string, admin: string | null, request?: Request) {
  if (!validateCheckDigit(code)) return { error: "Invalid instance code", status: 400 };
  if (isTetrisDemoCode(code)) await ensureDemoInstance(env);
  const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
  if (!row || row.ACTIVE === 0) return { error: "Instance not found", status: 404 };
  if (isTetrisDemoCode(row.INSTANCE_CODE)) return { row };
  if (request) {
    const banned = await requireNotAuthBanned(request, env, "admin");
    if (banned) return { response: banned };
  }
  if (row.ADMIN_CODE !== admin) {
    if (request) await recordAuthFailure(request, env, "admin", "admin-code");
    return { error: "Invalid admin code", status: 403 };
  }
  if (request) await clearAuthFailures(request, env, "admin");
  return { row };
}

// Mirrors publicInstanceWithPicture() in server.js: picture metadata merged into
// instance-facing responses so the client can load custom and predefined specs
// the same way (it prefers pictureSpecUrl when replaying an instance).
async function pictureEnrichment(env: Env, pictureId: string): Promise<Record<string, unknown>> {
  const picture = await env.DB.prepare("SELECT TITLE, SCRIPT, CUSTOM FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(pictureId).first<any>();
  if (!picture) return {};
  return {
    pictureTitle: picture.TITLE,
    pictureScript: picture.SCRIPT,
    pictureCustom: !!picture.CUSTOM,
    pictureSpecUrl: `/pictures/${encodeURIComponent(pictureId)}/spec.js`,
    ...(picture.CUSTOM ? { pictureZipUrl: `/pictures/${encodeURIComponent(pictureId)}/spec-files.zip` } : {})
  };
}

async function ensurePictures(env: Env): Promise<void> {
  for (const picture of PICTURES) {
    await env.DB.prepare(
      `INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(ID) DO UPDATE SET
         TITLE = excluded.TITLE,
         SCRIPT = excluded.SCRIPT,
         ENABLED = 1`
    ).bind(picture.id, picture.title, picture.script).run();
  }
  await ensureDemoInstance(env);
  await ensureDefaultTeacherKey(env);
}

// Seeds (or repairs) the bundled public Tetris demo instance. The demo uses the
// reserved instance code "tetris" with empty student/teacher keys so it never
// requires an access key. This is invoked on the student-facing read paths too
// (not just /pictures), so a freshly migrated or stale database self-heals and
// the demo stays keyless for both students and teachers.
async function ensureDemoInstance(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE INSTANCES SET INSTANCE_NAME = INSTANCE_CODE WHERE LOWER(INSTANCE_NAME) = 'tetris' AND INSTANCE_CODE <> 'tetris'").run();
  await env.DB.prepare(
    `INSERT INTO INSTANCES
      (INSTANCE_CODE, ADMIN_CODE, INSTANCE_NAME, ACCESS_KEY, TEACHER_KEY, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT, ACTIVE)
      VALUES ('tetris', 'tetris-demo', 'tetris', '', '', 'tetris', 'Public Demo', '2026-01-01T00:00:00', '9999-12-31T23:59:59.999Z', 1)
      ON CONFLICT(INSTANCE_CODE) DO UPDATE SET
        ADMIN_CODE = excluded.ADMIN_CODE,
        INSTANCE_NAME = excluded.INSTANCE_NAME,
        ACCESS_KEY = '',
        TEACHER_KEY = '',
        PICTURE_ID = 'tetris',
        TEACHER_NAME = 'Public Demo',
        EXPIRES_AT = excluded.EXPIRES_AT,
        ACTIVE = 1`
  ).run();
}

// Mirrors the Node server's express.json({ limit: "10mb" }).
const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function handleFetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    // Fast-path reject on declared size; readBodyTextCapped() enforces the same
    // limit while streaming for bodies that omit or misstate Content-Length.
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
      return json(request, env, { error: "Payload too large" }, { status: 413 });
    }
    const limited = await rateLimitResponse(request, env);
    if (limited) return limited;
    if (url.pathname !== "/health" && url.pathname !== "/faye" && !originAllowed(request, env)) {
      return json(request, env, { error: "Forbidden: Invalid origin" }, { status: 403 });
    }

    if (url.pathname === "/health") {
      return json(request, env, { status: "ok", version: APP_VERSION, runtime: "cloudflare-worker", routes: ["/instance/create", "/instance/:code/status", "/instance/:code/insert", "/instance/:code/retrieve", "/instance/:code/reset", "/faye"] });
    }

    if (url.pathname === "/pictures" && request.method === "GET") {
      await ensurePictures(env);
      const result = await env.DB.prepare("SELECT ID as id, TITLE as title, SCRIPT as script, CUSTOM as custom, SPEC_JSON as specJson FROM PICTURES WHERE ENABLED = 1 ORDER BY TITLE ASC").all<any>();
      const pictures = (result.results || []).map((row: any) => {
        const out: any = { id: row.id, title: row.title, script: row.script, custom: row.custom };
        if (row.specJson) {
          try {
            const spec = JSON.parse(row.specJson);
            out.numRows = Number(spec.numRows) || 0;
            out.numCols = Number(spec.numCols) || 0;
          } catch (err) { /* leave dims unset on malformed spec */ }
        }
        return out;
      });
      return json(request, env, pictures);
    }

    // Serve spec.js for any enabled picture that has a stored spec — predefined
    // (CUSTOM=0, seeded by migration 0003) and custom alike. This is how the client
    // loads ALL picture content from the server.
    const specMatch = url.pathname.match(/^\/pictures\/([^/]+)\/spec\.js$/);
    if (specMatch && request.method === "GET") {
      await ensurePictures(env);
      const id = decodeURIComponent(specMatch[1]);
      const row = await env.DB.prepare("SELECT SPEC_JSON as specJson FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(id).first<any>();
      if (!row || !row.specJson) return json(request, env, { error: "Picture not found" }, { status: 404 });
      return new Response(specToJs(JSON.parse(row.specJson)), {
        headers: { "content-type": "application/javascript; charset=utf-8", ...corsHeaders(request, env) }
      });
    }

    // Downloadable bundle of the generated Post-It/ColorMap files. Custom
    // pictures store artifacts at upload time; predefined pictures generate
    // them on demand from their seeded spec (mirrors pictureArtifacts() in
    // instanceManager.js).
    const zipMatch = url.pathname.match(/^\/pictures\/([^/]+)\/spec-files\.zip$/);
    if (zipMatch && request.method === "GET") {
      await ensurePictures(env);
      const id = decodeURIComponent(zipMatch[1]);
      const row = await env.DB.prepare("SELECT TITLE as title, SPEC_JSON as specJson, ARTIFACTS_JSON as artifactsJson FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(id).first<any>();
      if (!row || (!row.artifactsJson && !row.specJson)) return json(request, env, { error: "Picture not found" }, { status: 404 });
      const artifacts = row.artifactsJson ? JSON.parse(row.artifactsJson) : generateArtifacts(row.title, JSON.parse(row.specJson));
      const filename = `${String(row.title).replace(/[^a-z0-9_-]+/gi, "_") || "custom"}_spec_files.zip`;
      return new Response(zipFiles(artifacts), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"`,
          ...corsHeaders(request, env)
        }
      });
    }

    // Registers a teacher-uploaded custom picture (the client posts the
    // analyzed spec here before /instance/create). Mirrors POST /pictures/custom
    // in server.js + createCustomPicture() in instanceManager.js. The custom-
    // prefixed id requirement protects the seeded predefined rows from overwrite.
    if (url.pathname === "/pictures/custom" && request.method === "POST") {
      await ensurePictures(env);
      const body = await readRequestBody(request);
      const access = await adminOrTeacherPortalAccess(request, env, url, body);
      if (access.response) return access.response;
      const title = String(body.title || "Custom Picture").trim().slice(0, 120) || "Custom Picture";
      let spec: any;
      try {
        spec = validateSpec(body.spec);
      } catch (err: any) {
        return json(request, env, { error: err.message }, { status: err.status || 400 });
      }
      const id = body.id ? String(body.id).trim() : customPictureId(title);
      if (!/^custom-[a-z0-9-]+$/i.test(id)) {
        return json(request, env, { error: "Custom picture id must start with custom- and contain only letters, numbers, and hyphens" }, { status: 400 });
      }
      const script = `/pictures/${encodeURIComponent(id)}/spec.js`;
      const artifacts = body.artifacts && typeof body.artifacts === "object" ? body.artifacts : generateArtifacts(title, spec);
      await env.DB.prepare(
        `INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED, CUSTOM, SPEC_JSON, ARTIFACTS_JSON)
         VALUES (?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT(ID) DO UPDATE SET
           TITLE = excluded.TITLE,
           SCRIPT = excluded.SCRIPT,
           ENABLED = 1,
           CUSTOM = 1,
           SPEC_JSON = excluded.SPEC_JSON,
           ARTIFACTS_JSON = excluded.ARTIFACTS_JSON`
      ).bind(id, title, script, JSON.stringify(spec), JSON.stringify(artifacts)).run();
      return json(request, env, {
        id,
        title,
        script,
        custom: true,
        specUrl: script,
        zipUrl: `/pictures/${encodeURIComponent(id)}/spec-files.zip`
      }, { status: 201 });
    }

    if (url.pathname === "/instances" && request.method === "GET") {
      await ensurePictures(env);
      // Parity with the Node server: the full list is available to the admin
      // password or any valid global teacher key. Admins also see soft-deleted
      // (expired/cleaned-up) instances so they can restore them.
      const access = await adminOrTeacherPortalAccess(request, env, url);
      if (access.response) return access.response;
      const result = await env.DB.prepare(
        `SELECT i.*, p.TITLE as PICTURE_TITLE, p.SCRIPT as PICTURE_SCRIPT, p.CUSTOM as PICTURE_CUSTOM
         FROM INSTANCES i
         LEFT JOIN PICTURES p ON p.ID = i.PICTURE_ID
         ${access.mode === "admin" ? "" : "WHERE i.ACTIVE = 1"}
         ORDER BY i.CREATED_AT DESC, i.ID DESC`
      ).all<any>();
      const instances = (result.results || []).map((row: any) => ({
        active: !!row.ACTIVE,
        instanceCode: row.INSTANCE_CODE,
        instanceName: row.INSTANCE_NAME || row.INSTANCE_CODE,
        pictureId: row.PICTURE_ID,
        teacherName: row.TEACHER_NAME,
        requestedDateTime: row.REQUESTED_DATETIME,
        createdAt: row.CREATED_AT,
        expiresAt: row.EXPIRES_AT,
        pictureTitle: row.PICTURE_TITLE,
        pictureScript: row.PICTURE_SCRIPT,
        pictureCustom: !!row.PICTURE_CUSTOM,
        pictureSpecUrl: `/pictures/${encodeURIComponent(row.PICTURE_ID)}/spec.js`,
        ...(row.PICTURE_CUSTOM ? { pictureZipUrl: `/pictures/${encodeURIComponent(row.PICTURE_ID)}/spec-files.zip` } : {}),
        adminCode: row.ADMIN_CODE,
        accessKey: row.ACCESS_KEY,
        teacherKey: row.TEACHER_KEY,
        ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY)
      }));
      return json(request, env, { instances });
    }

    if (url.pathname === "/download" && request.method === "GET") {
      await ensurePictures(env);
      const passwordError = await adminPasswordError(request, env, url);
      if (passwordError) return passwordError;
      // Full export gated on the admin password: instances (with their class/admin/
      // teacher keys), replay data, global teacher keys, and custom pictures.
      const [instances, data, teacherKeys, customPictures] = await Promise.all([
        env.DB.prepare("SELECT * FROM INSTANCES ORDER BY ID ASC").all<any>(),
        env.DB.prepare("SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC").all<any>(),
        env.DB.prepare("SELECT * FROM TEACHER_KEYS ORDER BY ID ASC").all<any>(),
        env.DB.prepare("SELECT * FROM PICTURES WHERE CUSTOM = 1 ORDER BY ID ASC").all<any>()
      ]);
      return json(request, env, {
        exportedAt: new Date().toISOString(),
        version: APP_VERSION,
        instances: instances.results || [],
        data: data.results || [],
        teacherKeys: teacherKeys.results || [],
        customPictures: customPictures.results || []
      }, { headers: { "content-disposition": "attachment; filename=\"data-export.json\"" } });
    }

    if (url.pathname === "/teacher/validate" && request.method === "GET") {
      await ensurePictures(env);
      const portal = await teacherPortalAccess(request, env, url);
      if (portal.response) return portal.response;
      return json(request, env, { valid: true });
    }

    if (url.pathname === "/teacher/instances" && request.method === "GET") {
      await ensurePictures(env);
      const portal = await teacherPortalAccess(request, env, url);
      if (portal.response) return portal.response;
      const result = await env.DB.prepare(
        `SELECT i.*, p.TITLE as PICTURE_TITLE, p.SCRIPT as PICTURE_SCRIPT, p.CUSTOM as PICTURE_CUSTOM
         FROM INSTANCES i
         LEFT JOIN PICTURES p ON p.ID = i.PICTURE_ID
         WHERE i.ACTIVE = 1 AND i.TEACHER_ACCESS_KEY = ?
         ORDER BY i.CREATED_AT DESC, i.ID DESC`
      ).bind(portal.teacherAccessKey).all<any>();
      const instances = (result.results || []).map((row: any) => ({
        active: true,
        instanceCode: row.INSTANCE_CODE,
        instanceName: row.INSTANCE_NAME || row.INSTANCE_CODE,
        pictureId: row.PICTURE_ID,
        teacherName: row.TEACHER_NAME,
        requestedDateTime: row.REQUESTED_DATETIME,
        createdAt: row.CREATED_AT,
        expiresAt: row.EXPIRES_AT,
        pictureTitle: row.PICTURE_TITLE,
        pictureScript: row.PICTURE_SCRIPT,
        pictureCustom: !!row.PICTURE_CUSTOM,
        pictureSpecUrl: `/pictures/${encodeURIComponent(row.PICTURE_ID)}/spec.js`,
        ...(row.PICTURE_CUSTOM ? { pictureZipUrl: `/pictures/${encodeURIComponent(row.PICTURE_ID)}/spec-files.zip` } : {}),
        adminCode: row.ADMIN_CODE,
        accessKey: row.ACCESS_KEY,
        teacherKey: row.TEACHER_KEY,
        ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY)
      }));
      return json(request, env, { instances });
    }

    if (url.pathname === "/teacher-keys" && request.method === "GET") {
      await ensurePictures(env);
      const passwordError = await adminPasswordError(request, env, url);
      if (passwordError) return passwordError;
      const result = await env.DB.prepare("SELECT ID as id, TEACHER_KEY as teacherKey, LABEL as label, CREATED_AT as createdAt FROM TEACHER_KEYS ORDER BY CREATED_AT ASC, ID ASC").all();
      return json(request, env, { teacherKeys: result.results || [] });
    }

    if (url.pathname === "/teacher-keys" && request.method === "POST") {
      await ensurePictures(env);
      const body = await readRequestBody(request);
      const passwordError = await adminPasswordError(request, env, url, body);
      if (passwordError) return passwordError;
      const key = String(body.teacherKey || "").trim();
      if (!key) return json(request, env, { error: "teacherKey is required" }, { status: 400 });
      const existing = await env.DB.prepare("SELECT ID FROM TEACHER_KEYS WHERE TEACHER_KEY = ?").bind(key).first();
      if (existing) return json(request, env, { error: "Teacher key already exists" }, { status: 409 });
      await env.DB.prepare("INSERT INTO TEACHER_KEYS (TEACHER_KEY, LABEL) VALUES (?, ?)").bind(key, String(body.label || "").trim()).run();
      const created = await env.DB.prepare("SELECT ID as id, TEACHER_KEY as teacherKey, LABEL as label, CREATED_AT as createdAt FROM TEACHER_KEYS WHERE TEACHER_KEY = ?").bind(key).first();
      return json(request, env, created, { status: 201 });
    }

    if (url.pathname === "/instance/create" && request.method === "POST") {
      await ensurePictures(env);
      const body = await readRequestBody(request);
      const access = await adminOrTeacherPortalAccess(request, env, url, body);
      if (access.response) return access.response;
      if (!body.pictureId || !body.teacherName || !body.dateTime) {
        return json(request, env, { error: "Missing: pictureId, teacherName, dateTime" }, { status: 400 });
      }
      const picture = await env.DB.prepare("SELECT ID FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(body.pictureId).first();
      if (!picture) return json(request, env, { error: "Unknown pictureId" }, { status: 400 });
      // Mirrors the Node server: the random component only has 100 values per
      // picture/teacher/minute, so retry on collision instead of failing.
      let code: string | null = null;
      for (let i = 0; i < 100; i++) {
        const candidate = generateInstanceCode(body.pictureId, body.teacherName, body.dateTime);
        const existing = await env.DB.prepare("SELECT ID FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(candidate).first();
        if (!existing) {
          code = candidate;
          break;
        }
      }
      if (!code) return json(request, env, { error: "Could not generate a unique instance code for that picture, teacher, and date/time" }, { status: 409 });
      const instanceName = String(body.instanceName || code).trim();
      if (instanceName.toLowerCase() === "tetris") return json(request, env, { error: "Instance name is reserved" }, { status: 409 });
      const existingName = await env.DB.prepare("SELECT ID FROM INSTANCES WHERE INSTANCE_NAME = ?").bind(instanceName).first();
      if (existingName) return json(request, env, { error: "Instance name already exists" }, { status: 409 });
      const admin = adminCode();
      const key = accessKey();
      const teacherKey = accessKey();
      const teacherAccessKey = access.mode === "teacher" ? (access.teacherAccessKey || null) : null;
      const hours = Number(body.expirationHours || env.DEFAULT_EXPIRATION_HOURS || 8760);
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO INSTANCES (INSTANCE_CODE, ADMIN_CODE, INSTANCE_NAME, ACCESS_KEY, TEACHER_KEY, TEACHER_ACCESS_KEY, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(code, admin, instanceName, key, teacherKey, teacherAccessKey, body.pictureId, body.teacherName, body.dateTime, expiresAt).run();
      return json(request, env, { instanceCode: code, adminCode: admin, accessKey: key, teacherKey, instanceName, pictureId: body.pictureId, teacherName: body.teacherName, requestedDateTime: body.dateTime, expiresAt, ...urls(env, code, admin, key, teacherKey) }, { status: 201 });
    }

    const instanceMatch = url.pathname.match(/^\/instance\/([^/]+)\/(status|insert|retrieve|reset|admin|deactivate|delete|rotate-key|expiration)$/);
    if (instanceMatch) {
      const code = decodeURIComponent(instanceMatch[1]);
      const action = instanceMatch[2];
      if (action === "admin" && request.method === "GET") {
        const passwordError = code === "tetris" ? null : await adminPasswordError(request, env, url);
        if (passwordError) return passwordError;
        const found = await adminInstance(env, code, url.searchParams.get("admin"), request);
        if (found.response) return found.response;
        if (found.error) return json(request, env, { error: found.error }, { status: found.status });
        const row = found.row!;
        const teacherError = await teacherAccessError(request, env, url, row);
        if (teacherError) return teacherError;
        const result = await env.DB.prepare("SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC").bind(code).all();
        return json(request, env, {
          instanceCode: row.INSTANCE_CODE,
          instanceName: row.INSTANCE_NAME || row.INSTANCE_CODE,
          pictureId: row.PICTURE_ID,
          teacherName: row.TEACHER_NAME,
          requestedDateTime: row.REQUESTED_DATETIME,
          createdAt: row.CREATED_AT,
          expiresAt: row.EXPIRES_AT,
          accessKey: row.ACCESS_KEY,
          ...(await pictureEnrichment(env, row.PICTURE_ID)),
          ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY),
          rows: result.results
        });
      }

      if (action === "deactivate" && request.method === "POST") {
        return json(request, env, { error: "Instances cannot be deactivated or deleted" }, { status: 403 });
      }

      // Expired instances only: authorized by the admin password or the owning
      // teacher key. Active (non-expired) instances still cannot be deleted.
      if (action === "delete" && request.method === "POST") {
        if (isTetrisDemoCode(code)) return json(request, env, { error: "The public Tetris demo cannot be deleted" }, { status: 403 });
        if (!validateCheckDigit(code)) return json(request, env, { error: "Invalid instance code" }, { status: 400 });
        const body = await readRequestBody(request);
        const access = await adminOrTeacherPortalAccess(request, env, url, body);
        if (access.response) return access.response;
        const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
        if (!row || row.ACTIVE === 0) return json(request, env, { error: "Instance not found" }, { status: 404 });
        if (access.mode === "teacher" && String(row.TEACHER_ACCESS_KEY || "") !== String(access.teacherAccessKey || "")) {
          return authError(request, env, "teacher", "teacher-instance-owner", "Teacher key does not own this instance");
        }
        if (new Date(row.EXPIRES_AT).getTime() > Date.now()) {
          return json(request, env, { error: "Only expired instances can be deleted" }, { status: 403 });
        }
        await env.DB.prepare("UPDATE INSTANCES SET ACTIVE = 0 WHERE INSTANCE_CODE = ?").bind(code).run();
        const result = await env.DB.prepare("DELETE FROM DATA WHERE INSTANCE_CODE = ?").bind(code).run();
        return json(request, env, { status: "deleted", instanceCode: code, deletedRows: result.meta.changes || 0 });
      }

      // Change an instance's expiration date. Admin password: any instance,
      // including soft-deleted ones (setting a new expiration restores them to
      // ACTIVE). Teacher key: only that teacher's own still-active instances.
      if (action === "expiration" && request.method === "POST") {
        if (isTetrisDemoCode(code)) return json(request, env, { error: "The public Tetris demo never expires" }, { status: 403 });
        if (!validateCheckDigit(code)) return json(request, env, { error: "Invalid instance code" }, { status: 400 });
        const body = await readRequestBody(request);
        const access = await adminOrTeacherPortalAccess(request, env, url, body);
        if (access.response) return access.response;
        const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
        if (!row || (access.mode === "teacher" && row.ACTIVE === 0)) {
          return json(request, env, { error: "Instance not found" }, { status: 404 });
        }
        if (access.mode === "teacher" && String(row.TEACHER_ACCESS_KEY || "") !== String(access.teacherAccessKey || "")) {
          return authError(request, env, "teacher", "teacher-instance-owner", "Teacher key does not own this instance");
        }
        let expiresAt: string;
        try {
          expiresAt = resolveExpiresAt(body);
        } catch (err: any) {
          return json(request, env, { error: err.message }, { status: err.status || 400 });
        }
        // A past expiration makes the instance immediately deletable, which
        // would let a teacher bypass the active-instance delete protection.
        // Only admins may force-expire.
        if (access.mode === "teacher" && new Date(expiresAt).getTime() <= Date.now()) {
          return json(request, env, { error: "Only admins can set an expiration in the past" }, { status: 403 });
        }
        await env.DB.prepare("UPDATE INSTANCES SET EXPIRES_AT = ?, ACTIVE = 1 WHERE INSTANCE_CODE = ?").bind(expiresAt, code).run();
        return json(request, env, { status: "updated", instanceCode: code, expiresAt, active: true });
      }

      if (action === "rotate-key" && request.method === "POST") {
        if (code === "tetris") return json(request, env, { error: "The public Tetris demo does not use keys" }, { status: 403 });
        const body = await readRequestBody(request);
        const passwordError = await adminPasswordError(request, env, url, body);
        if (passwordError) return passwordError;
        const found = await adminInstance(env, code, body.adminCode || url.searchParams.get("admin"), request);
        if (found.response) return found.response;
        if (found.error) return json(request, env, { error: found.error }, { status: found.status });
        const teacherError = await teacherAccessError(request, env, url, found.row, body);
        if (teacherError) return teacherError;
        const keyType = String(body.keyType || url.searchParams.get("keyType") || "");
        if (keyType !== "student" && keyType !== "teacher") return json(request, env, { error: "keyType must be student or teacher" }, { status: 400 });
        const newKey = accessKey();
        const column = keyType === "student" ? "ACCESS_KEY" : "TEACHER_KEY";
        await env.DB.prepare(`UPDATE INSTANCES SET ${column} = ? WHERE INSTANCE_CODE = ?`).bind(newKey, code).run();
        const updated = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
        return json(request, env, {
          status: "rotated",
          keyType,
          accessKey: updated.ACCESS_KEY,
          teacherKey: updated.TEACHER_KEY,
          ...urls(env, updated.INSTANCE_CODE, updated.ADMIN_CODE, updated.ACCESS_KEY, updated.TEACHER_KEY)
        });
      }

      const found = await activeInstance(env, code);
      if (found.error) {
        // Expired /status mirrors the Node server: the class key is still
        // required, and the 410 body carries the instance + picture metadata
        // so the client can say what expired.
        if (found.row && action === "status" && request.method === "GET") {
          const accessError = await instanceAccessError(request, env, url, found.row);
          if (accessError) return accessError;
          return json(request, env, {
            valid: false,
            error: found.error,
            instanceCode: found.row.INSTANCE_CODE,
            instanceName: found.row.INSTANCE_NAME || found.row.INSTANCE_CODE,
            pictureId: found.row.PICTURE_ID,
            teacherName: found.row.TEACHER_NAME,
            requestedDateTime: found.row.REQUESTED_DATETIME,
            createdAt: found.row.CREATED_AT,
            expiresAt: found.row.EXPIRES_AT,
            ...(await pictureEnrichment(env, found.row.PICTURE_ID))
          }, { status: found.status });
        }
        return json(request, env, { valid: false, error: found.error }, { status: found.status });
      }
      const row = found.row!;

      if (action === "status" && request.method === "GET") {
        const accessError = await instanceAccessError(request, env, url, row);
        if (accessError) return accessError;
        return json(request, env, {
          valid: true,
          instanceCode: row.INSTANCE_CODE,
          instanceName: row.INSTANCE_NAME || row.INSTANCE_CODE,
          pictureId: row.PICTURE_ID,
          teacherName: row.TEACHER_NAME,
          requestedDateTime: row.REQUESTED_DATETIME,
          createdAt: row.CREATED_AT,
          expiresAt: row.EXPIRES_AT,
          ...(await pictureEnrichment(env, row.PICTURE_ID)),
          ...studentUrls(env, row.INSTANCE_CODE, row.ACCESS_KEY)
        });
      }

      if (action === "insert" && request.method === "POST") {
        const body = await readRequestBody(request);
        const accessError = await instanceAccessError(request, env, url, row, body);
        if (accessError) return accessError;
        if (isTetrisDemoCode(code)) {
          const pic = await env.DB.prepare("SELECT SPEC_JSON FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(row.PICTURE_ID).first<any>();
          const spec = pic?.SPEC_JSON ? JSON.parse(pic.SPEC_JSON) : null;
          const demoError = tetrisInsertError(spec, body.data ?? null);
          if (demoError) return json(request, env, { error: demoError }, { status: 400 });
        }
        await env.DB.prepare("INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)").bind(code, code, body.data ?? null).run();
        return json(request, env, { status: "created" }, { status: 201 });
      }

      if (action === "retrieve" && request.method === "GET") {
        const accessError = await instanceAccessError(request, env, url, row);
        if (accessError) return accessError;
        const result = await env.DB.prepare("SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC").bind(code).all();
        return json(request, env, result.results);
      }

      if (action === "reset" && request.method === "POST") {
        const body = await readRequestBody(request);
        const passwordError = code === "tetris" ? null : await adminPasswordError(request, env, url, body);
        if (passwordError) return passwordError;
        const supplied = body.adminCode || url.searchParams.get("admin");
        if (code !== "tetris" && supplied !== row.ADMIN_CODE) {
          const banned = await requireNotAuthBanned(request, env, "admin");
          if (banned) return banned;
          await recordAuthFailure(request, env, "admin", "admin-code");
          return json(request, env, { error: "Invalid admin code" }, { status: 403 });
        }
        if (code !== "tetris") await clearAuthFailures(request, env, "admin");
        const teacherError = code === "tetris" ? null : await teacherAccessError(request, env, url, row, body);
        if (teacherError) return teacherError;
        const result = await env.DB.prepare("DELETE FROM DATA WHERE INSTANCE_CODE = ?").bind(code).run();
        return json(request, env, { status: "reset", deletedRows: result.meta.changes || 0 });
      }
    }

    const eventMatch = url.pathname.match(/^\/instance\/([^/]+)\/event\/([^/]+)\/(update|delete)$/);
    if (eventMatch && request.method === "POST") {
      const code = decodeURIComponent(eventMatch[1]);
      const id = decodeURIComponent(eventMatch[2]);
      const action = eventMatch[3];
      const body = await readRequestBody(request);
      const passwordError = await adminPasswordError(request, env, url, body);
      if (passwordError) return passwordError;
      const found = await adminInstance(env, code, body.adminCode || url.searchParams.get("admin"), request);
      if (found.response) return found.response;
      if (found.error) return json(request, env, { error: found.error }, { status: found.status });
      const teacherError = await teacherAccessError(request, env, url, found.row, body);
      if (teacherError) return teacherError;
      if (action === "update") {
        const result = await env.DB.prepare("UPDATE DATA SET DATA = ? WHERE ID = ? AND INSTANCE_CODE = ?").bind(body.data ?? "", id, code).run();
        if (!result.meta.changes) return json(request, env, { error: "Event not found" }, { status: 404 });
        return json(request, env, { status: "updated", updatedRows: result.meta.changes || 0 });
      }
      const result = await env.DB.prepare("DELETE FROM DATA WHERE ID = ? AND INSTANCE_CODE = ?").bind(id, code).run();
      if (!result.meta.changes) return json(request, env, { error: "Event not found" }, { status: 404 });
      return json(request, env, { status: "deleted", deletedRows: result.meta.changes || 0 });
    }

    if (env.LEGACY_ROUTES_ENABLED === "true" && url.pathname === "/insert" && request.method === "POST") {
      const body = await readRequestBody(request);
      await env.DB.prepare("INSERT INTO DATA (NAME, DATA) VALUES (?, ?)").bind(url.searchParams.get("name"), body.data ?? null).run();
      return json(request, env, { status: "created" }, { status: 201 });
    }

    if (env.LEGACY_ROUTES_ENABLED === "true" && url.pathname === "/retrieve" && request.method === "GET") {
      const name = url.searchParams.get("name");
      const result = name
        ? await env.DB.prepare("SELECT * FROM DATA WHERE NAME = ? ORDER BY TIMESTAMP ASC, ID ASC").bind(name).all()
        : await env.DB.prepare("SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC").all();
      return json(request, env, result.results);
    }

    if (url.pathname === "/faye") {
      const channelCode = realtimeChannelInstanceCode(url.searchParams.get("channel") || "");
      if (channelCode && !isTetrisDemoCode(channelCode)) {
        const banned = await requireNotAuthBanned(request, env, "student");
        if (banned) return banned;
        const row = await env.DB.prepare("SELECT ACCESS_KEY, TEACHER_KEY FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(channelCode).first<any>();
        const provided = accessKeyFromRequest(request, url);
        if (!row || (provided !== String(row.ACCESS_KEY || "") && provided !== String(row.TEACHER_KEY || ""))) {
          return authError(request, env, "student", "realtime-channel-key", "Invalid realtime channel key");
        }
        await clearAuthFailures(request, env, "student");
      }
      const id = env.PUBSUB.idFromName("default-room");
      return env.PUBSUB.get(id).fetch(request);
    }

    return json(request, env, { error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return json(request, env, { error: "Payload too large" }, { status: 413 });
      }
      throw err;
    }
  },

  // Mirrors the Node server's periodic cleanupExpired(): purge replay data for
  // expired instances and soft-delete them. Soft-deleted instances stay
  // visible to admins, who can restore them with a new expiration date via
  // POST /instance/:code/expiration. Driven by the cron trigger in wrangler.jsonc.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "DELETE FROM DATA WHERE INSTANCE_CODE IN (SELECT INSTANCE_CODE FROM INSTANCES WHERE EXPIRES_AT <= ?)"
    ).bind(now).run();
    await env.DB.prepare("UPDATE INSTANCES SET ACTIVE = 0 WHERE EXPIRES_AT <= ? AND ACTIVE = 1").bind(now).run();
  }
};

export class PubSubRoom implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ error: "Expected WebSocket Upgrade" }), { status: 426 });
    }
    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") || "/default";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ channel } satisfies ClientAttachment);
    server.send(JSON.stringify({ type: "connected", channel }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const source = ws.deserializeAttachment() as ClientAttachment | undefined;
    const ownChannel = source?.channel || "/default";

    if (text.length > WS_MAX_MESSAGE_BYTES) {
      ws.send(JSON.stringify({ type: "error", error: "Message too large." }));
      return;
    }

    // Per-connection message rate limit (fixed one-second window).
    const now = Date.now();
    const windowStart = source?.windowStart || 0;
    if (now - windowStart >= 1000) {
      ws.serializeAttachment({ channel: ownChannel, windowStart: now, count: 1 } satisfies ClientAttachment);
    } else {
      const count = (source?.count || 0) + 1;
      ws.serializeAttachment({ channel: ownChannel, windowStart, count } satisfies ClientAttachment);
      if (count > WS_MAX_MESSAGES_PER_SECOND) {
        ws.send(JSON.stringify({ type: "error", error: "Too many messages. Please slow down." }));
        return;
      }
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid message." }));
      return;
    }
    // Always broadcast on the channel this connection was authorized for at
    // upgrade time; ignore any channel a client puts in the message body so it
    // cannot publish into another instance's channel.
    const channel = ownChannel;
    const payload = JSON.stringify({ channel, data: parsed.data ?? parsed, timestamp: new Date().toISOString() });
    for (const client of this.state.getWebSockets()) {
      const target = client.deserializeAttachment() as ClientAttachment | undefined;
      if (target?.channel === channel) client.send(payload);
    }
  }
}

export class RateLimitBucket implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const body: any = await request.json().catch(() => ({}));
    const now = Number(body.now || Date.now());
    const limits = {
      second: positiveInt(String(body.second || ""), 3),
      minute: positiveInt(String(body.minute || ""), 20),
      day: positiveInt(String(body.day || ""), 10000)
    };
    const buckets = {
      second: Math.floor(now / 1000),
      minute: Math.floor(now / 60000),
      day: Math.floor(now / 86400000)
    };
    const current = await this.state.storage.get<RateLimitState>("state") || {
      secondBucket: buckets.second,
      secondCount: 0,
      minuteBucket: buckets.minute,
      minuteCount: 0,
      dayBucket: buckets.day,
      dayCount: 0
    };

    if (current.secondBucket !== buckets.second) {
      current.secondBucket = buckets.second;
      current.secondCount = 0;
    }
    if (current.minuteBucket !== buckets.minute) {
      current.minuteBucket = buckets.minute;
      current.minuteCount = 0;
    }
    if (current.dayBucket !== buckets.day) {
      current.dayBucket = buckets.day;
      current.dayCount = 0;
    }

    current.secondCount++;
    current.minuteCount++;
    current.dayCount++;
    await this.state.storage.put("state", current);

    if (current.secondCount > limits.second) return rateLimited("per-second", current.secondCount, limits.second);
    if (current.minuteCount > limits.minute) return rateLimited("per-minute", current.minuteCount, limits.minute);
    if (current.dayCount > limits.day) return rateLimited("per-day", current.dayCount, limits.day);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
}

function rateLimited(limit: string, count: number, max: number): Response {
  return new Response(JSON.stringify({ limit, count, max }), {
    status: 429,
    headers: { "content-type": "application/json" }
  });
}

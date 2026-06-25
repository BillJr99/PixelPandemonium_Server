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
  DOWNLOAD_TOKEN: string;
  LEGACY_ROUTES_ENABLED: string;
  AUTH_FAILURE_LIMIT: string;
  AUTH_FAILURE_WINDOW_MINUTES: string;
  AUTH_ADMIN_BAN_DAYS: string;
  AUTH_TEACHER_BAN_MINUTES: string;
  AUTH_STUDENT_BAN_MINUTES: string;
}

interface ClientAttachment {
  channel: string;
}

interface RateLimitState {
  secondBucket: number;
  secondCount: number;
  minuteBucket: number;
  minuteCount: number;
  dayBucket: number;
  dayCount: number;
}

const PICTURES = [
  { id: "tetris", title: "Demo (Tetris)", script: "files/drawingcanvas-tetris/Post-It_tetris_composite.js" },
  { id: "cs4allpa2022", title: "CS4AllPA-2022", script: "files/drawingcanvas-cs4allpa2022/Post-It_CSforALLinPA_RWB_bk_v6x_composite.js" },
  { id: "cs4philly2021", title: "CS4Philly-2021", script: "files/drawingcanvas-cs4philly2021/Post-It_CS4Philly_2021_v0_composite.js" },
  { id: "cs4philly2022", title: "CS4Philly-2022", script: "files/drawingcanvas-cs4philly2022/Post-It_CS4Philly_2022_composite.js" },
  { id: "eagles", title: "Eagles", script: "files/drawingcanvas-eagles/Post-It_Eagles_Logo_composite.js" },
  { id: "eagles2", title: "Eagles2", script: "files/drawingcanvas-eagles2/Post-It_Eagles_Logo2_composite.js" },
  { id: "ghopper", title: "GHopper", script: "files/drawingcanvas-ghopper/Post-It_CS4Philly_GHopper_composite.js" },
  { id: "lovestatue", title: "LoveStatue", script: "files/drawingcanvas-lovestatue/Post-It_LOVE_Statue_composite.js" },
  { id: "mikewazowski", title: "MikeWazowski", script: "files/drawingcanvas-mikewazowski/Post-It_MikeWazowski2_composite.js" },
  { id: "phillyscifest", title: "PhillySciFest-2022", script: "files/drawingcanvas-phillyscifest/Post-It_Banner_PhillySciFest_v4_composite.js" },
  { id: "pixar2022", title: "Pixar-2022", script: "files/drawingcanvas-pixar2022/Post-It_CS4Philly_Pixar_2022_composite.js" },
  { id: "robotspringboard", title: "RobotSpringboard", script: "files/drawingcanvas-robotspringboard/Post-It_RobotSpringboard_2018_v2a_composite.js" },
  { id: "robotspringboard2022", title: "RobotSpringboard-2022", script: "files/drawingcanvas-robotspringboard2022/Post-It_RobotSpringboard_2022_composite.js" },
  { id: "rocky2022", title: "Rocky-2022", script: "files/drawingcanvas-rocky2022/Post-It_Rocky_ArtMuseum_2022_composite.js" },
  { id: "yellowsubmarine", title: "YellowSubmarine", script: "files/drawingcanvas-yellowsubmarine/Post-It_YellowSubmarine_composite.js" },
  { id: "yellowsubmarine2022", title: "YellowSubmarine-2022", script: "files/drawingcanvas-yellowsubmarine2022/Post-It_YellowSubmarine_2022_composite.js" }
];

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowedOrigins(env).some((allowed) => origin === allowed || origin.endsWith(allowed));
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
      second: positiveInt(env.RATE_LIMIT_MAX_PER_SECOND, 3),
      minute: positiveInt(env.RATE_LIMIT_MAX_PER_MINUTE, 20),
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

function isTetrisDemoCode(code: string): boolean {
  return String(code || "").toLowerCase() === "tetris";
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
  if (Number.isNaN(date.getTime())) return "00000000";
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

async function readRequestBody(request: Request): Promise<Record<string, any>> {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return await request.json();
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  const text = await request.text();
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const limited = await rateLimitResponse(request, env);
    if (limited) return limited;
    if (url.pathname !== "/health" && url.pathname !== "/faye" && !originAllowed(request, env)) {
      return json(request, env, { error: "Forbidden: Invalid origin" }, { status: 403 });
    }

    if (url.pathname === "/health") {
      return json(request, env, { status: "ok", runtime: "cloudflare-worker", routes: ["/instance/create", "/instance/:code/status", "/instance/:code/insert", "/instance/:code/retrieve", "/instance/:code/reset", "/faye"] });
    }

    if (url.pathname === "/pictures" && request.method === "GET") {
      await ensurePictures(env);
      const result = await env.DB.prepare("SELECT ID as id, TITLE as title, SCRIPT as script FROM PICTURES WHERE ENABLED = 1 ORDER BY TITLE ASC").all();
      return json(request, env, result.results);
    }

    if (url.pathname === "/instances" && request.method === "GET") {
      await ensurePictures(env);
      const passwordError = await adminPasswordError(request, env, url);
      if (passwordError) return passwordError;
      const result = await env.DB.prepare(
        `SELECT i.*, p.TITLE as PICTURE_TITLE, p.SCRIPT as PICTURE_SCRIPT, p.CUSTOM as PICTURE_CUSTOM
         FROM INSTANCES i
         LEFT JOIN PICTURES p ON p.ID = i.PICTURE_ID
         WHERE i.ACTIVE = 1
         ORDER BY i.CREATED_AT DESC, i.ID DESC`
      ).all<any>();
      const instances = (result.results || []).map((row: any) => ({
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
        adminCode: row.ADMIN_CODE,
        accessKey: row.ACCESS_KEY,
        teacherKey: row.TEACHER_KEY,
        ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY)
      }));
      return json(request, env, { instances });
    }

    if (url.pathname === "/instance/create" && request.method === "POST") {
      await ensurePictures(env);
      const body = await readRequestBody(request);
      if (!body.pictureId || !body.teacherName || !body.dateTime) {
        return json(request, env, { error: "Missing: pictureId, teacherName, dateTime" }, { status: 400 });
      }
      const picture = await env.DB.prepare("SELECT ID FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(body.pictureId).first();
      if (!picture) return json(request, env, { error: "Unknown pictureId" }, { status: 400 });
      const code = generateInstanceCode(body.pictureId, body.teacherName, body.dateTime);
      const instanceName = String(body.instanceName || code).trim();
      if (instanceName.toLowerCase() === "tetris") return json(request, env, { error: "Instance name is reserved" }, { status: 409 });
      const existingName = await env.DB.prepare("SELECT ID FROM INSTANCES WHERE INSTANCE_NAME = ?").bind(instanceName).first();
      if (existingName) return json(request, env, { error: "Instance name already exists" }, { status: 409 });
      const admin = adminCode();
      const key = accessKey();
      const teacherKey = accessKey();
      const hours = Number(body.expirationHours || env.DEFAULT_EXPIRATION_HOURS || 8760);
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO INSTANCES (INSTANCE_CODE, ADMIN_CODE, INSTANCE_NAME, ACCESS_KEY, TEACHER_KEY, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(code, admin, instanceName, key, teacherKey, body.pictureId, body.teacherName, body.dateTime, expiresAt).run();
      return json(request, env, { instanceCode: code, adminCode: admin, accessKey: key, teacherKey, instanceName, pictureId: body.pictureId, teacherName: body.teacherName, requestedDateTime: body.dateTime, expiresAt, ...urls(env, code, admin, key, teacherKey) }, { status: 201 });
    }

    const instanceMatch = url.pathname.match(/^\/instance\/([^/]+)\/(status|insert|retrieve|reset|admin|deactivate|delete|rotate-key)$/);
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
          ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY),
          rows: result.results
        });
      }

      if ((action === "deactivate" || action === "delete") && request.method === "POST") {
        return json(request, env, { error: "Instances cannot be deactivated or deleted" }, { status: 403 });
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
      if (found.error) return json(request, env, { valid: false, error: found.error, ...(found.row ? { pictureId: found.row.PICTURE_ID, expiresAt: found.row.EXPIRES_AT } : {}) }, { status: found.status });
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
          ...studentUrls(env, row.INSTANCE_CODE, row.ACCESS_KEY)
        });
      }

      if (action === "insert" && request.method === "POST") {
        const body = await readRequestBody(request);
        const accessError = await instanceAccessError(request, env, url, row, body);
        if (accessError) return accessError;
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
      const id = env.PUBSUB.idFromName("default-room");
      return env.PUBSUB.get(id).fetch(request);
    }

    return json(request, env, { error: "Not found" }, { status: 404 });
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
    const parsed = JSON.parse(text);
    const channel = parsed.channel || source?.channel || "/default";
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

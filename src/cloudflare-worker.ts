export interface Env {
  DB: D1Database;
  PUBSUB: DurableObjectNamespace<PubSubRoom>;
  ALLOWED_ORIGINS: string;
  CLIENT_BASE_URL: string;
  DEFAULT_EXPIRATION_HOURS: string;
  DOWNLOAD_TOKEN: string;
  LEGACY_ROUTES_ENABLED: string;
}

interface ClientAttachment {
  channel: string;
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
    "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With",
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

function validateCheckDigit(code: string): boolean {
  const digits = digitsOnly(code);
  return digits.length >= 2 && luhnCheckDigit(digits.slice(0, -1)) === digits.slice(-1);
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

function urls(env: Env, instanceCode: string, admin: string) {
  const base = (env.CLIENT_BASE_URL || "").replace(/\/$/, "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}`,
    adminUrl: `${base}/admin.html?instance=${encodeURIComponent(instanceCode)}&admin=${encodeURIComponent(admin)}`
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

async function activeInstance(env: Env, code: string) {
  if (!validateCheckDigit(code)) return { error: "Invalid instance code", status: 400 };
  const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
  if (!row) return { error: "Instance not found", status: 404 };
  if (row.ACTIVE === 0) return { error: "Instance not found", status: 404 };
  if (new Date(row.EXPIRES_AT).getTime() <= Date.now()) return { error: "Instance expired", status: 410, row };
  return { row };
}

async function adminInstance(env: Env, code: string, admin: string | null) {
  if (!validateCheckDigit(code)) return { error: "Invalid instance code", status: 400 };
  const row = await env.DB.prepare("SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?").bind(code).first<any>();
  if (!row || row.ACTIVE === 0) return { error: "Instance not found", status: 404 };
  if (row.ADMIN_CODE !== admin) return { error: "Invalid admin code", status: 403 };
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
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

    if (url.pathname === "/instance/create" && request.method === "POST") {
      await ensurePictures(env);
      const body = await readRequestBody(request);
      if (!body.pictureId || !body.teacherName || !body.dateTime) {
        return json(request, env, { error: "Missing: pictureId, teacherName, dateTime" }, { status: 400 });
      }
      const picture = await env.DB.prepare("SELECT ID FROM PICTURES WHERE ID = ? AND ENABLED = 1").bind(body.pictureId).first();
      if (!picture) return json(request, env, { error: "Unknown pictureId" }, { status: 400 });
      const code = generateInstanceCode(body.pictureId, body.teacherName, body.dateTime);
      const admin = adminCode();
      const hours = Number(body.expirationHours || env.DEFAULT_EXPIRATION_HOURS || 72);
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO INSTANCES (INSTANCE_CODE, ADMIN_CODE, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(code, admin, body.pictureId, body.teacherName, body.dateTime, expiresAt).run();
      return json(request, env, { instanceCode: code, adminCode: admin, pictureId: body.pictureId, teacherName: body.teacherName, requestedDateTime: body.dateTime, expiresAt, ...urls(env, code, admin) }, { status: 201 });
    }

    const instanceMatch = url.pathname.match(/^\/instance\/([^/]+)\/(status|insert|retrieve|reset|admin|deactivate|delete)$/);
    if (instanceMatch) {
      const code = decodeURIComponent(instanceMatch[1]);
      const action = instanceMatch[2];
      if (action === "admin" && request.method === "GET") {
        const found = await adminInstance(env, code, url.searchParams.get("admin"));
        if (found.error) return json(request, env, { error: found.error }, { status: found.status });
        const row = found.row!;
        const result = await env.DB.prepare("SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC").bind(code).all();
        return json(request, env, {
          instanceCode: row.INSTANCE_CODE,
          pictureId: row.PICTURE_ID,
          teacherName: row.TEACHER_NAME,
          requestedDateTime: row.REQUESTED_DATETIME,
          createdAt: row.CREATED_AT,
          expiresAt: row.EXPIRES_AT,
          rows: result.results
        });
      }

      if ((action === "deactivate" || action === "delete") && request.method === "POST") {
        const body = await readRequestBody(request);
        const found = await adminInstance(env, code, body.adminCode || url.searchParams.get("admin"));
        if (found.error) return json(request, env, { error: found.error }, { status: found.status });
        const result = await env.DB.prepare("UPDATE INSTANCES SET ACTIVE = 0 WHERE INSTANCE_CODE = ?").bind(code).run();
        return json(request, env, { status: "deactivated", deactivatedInstances: result.meta.changes || 0 });
      }

      const found = await activeInstance(env, code);
      if (found.error) return json(request, env, { valid: false, error: found.error, ...(found.row ? { pictureId: found.row.PICTURE_ID, expiresAt: found.row.EXPIRES_AT } : {}) }, { status: found.status });
      const row = found.row!;

      if (action === "status" && request.method === "GET") {
        return json(request, env, {
          valid: true,
          instanceCode: row.INSTANCE_CODE,
          pictureId: row.PICTURE_ID,
          teacherName: row.TEACHER_NAME,
          requestedDateTime: row.REQUESTED_DATETIME,
          createdAt: row.CREATED_AT,
          expiresAt: row.EXPIRES_AT,
          ...urls(env, row.INSTANCE_CODE, row.ADMIN_CODE)
        });
      }

      if (action === "insert" && request.method === "POST") {
        const body = await readRequestBody(request);
        await env.DB.prepare("INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)").bind(code, code, body.data ?? null).run();
        return json(request, env, { status: "created" }, { status: 201 });
      }

      if (action === "retrieve" && request.method === "GET") {
        const result = await env.DB.prepare("SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC").bind(code).all();
        return json(request, env, result.results);
      }

      if (action === "reset" && request.method === "POST") {
        const body = await readRequestBody(request);
        const supplied = body.adminCode || url.searchParams.get("admin");
        if (supplied !== row.ADMIN_CODE) return json(request, env, { error: "Invalid admin code" }, { status: 403 });
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
      const found = await adminInstance(env, code, body.adminCode || url.searchParams.get("admin"));
      if (found.error) return json(request, env, { error: found.error }, { status: found.status });
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

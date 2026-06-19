/**
 * cot.run edge worker.
 *
 * Serves the static marketing site (via the ASSETS binding) and accepts
 * opt-in telemetry from self-hosted collectors at POST /v1/telemetry, storing
 * each report as a row in D1 (free, serverless SQLite). Reports are content-free
 * aggregates by construction (see the collector's `_telemetry_payload`).
 *
 * Also accepts feedback at POST /v1/feedback with Cloudflare Turnstile verification.
 */

interface Env {
  ASSETS: Fetcher;
  TELEMETRY_DB: D1Database;
  MESSAGES_DB: D1Database;
  TURNSTILE_SECRET_KEY?: string;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  install_id  TEXT,
  version     TEXT,
  os          TEXT,
  arch        TEXT,
  country     TEXT,
  sessions    INTEGER,
  events      INTEGER,
  tool_calls  INTEGER,
  errors      INTEGER,
  error_rate  REAL,
  payload     TEXT NOT NULL
)`;

const CREATE_MESSAGES_TABLE = `CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  type        TEXT NOT NULL,
  email       TEXT,
  message     TEXT NOT NULL,
  country     TEXT,
  user_agent  TEXT
)`;

const INSERT_REPORT = `INSERT INTO reports
  (received_at, install_id, version, os, arch, country,
   sessions, events, tool_calls, errors, error_rate, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_MESSAGE = `INSERT INTO messages
  (received_at, type, email, message, country, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)`;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LEN = 5000;

const FEEDBACK_TYPES = new Set(['feature', 'feedback', 'other']);

// Cloudflare Turnstile test secret — always passes. Override in production.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 200) : null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  let payload: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return json({ error: 'invalid_payload' }, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const receivedAt = new Date().toISOString();
  const country = (request.cf?.country as string | undefined) ?? null;
  const metrics = (payload.metrics ?? {}) as Record<string, unknown>;
  const runtime = (payload.runtime ?? {}) as Record<string, unknown>;

  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(CREATE_TABLE),
    env.TELEMETRY_DB.prepare(INSERT_REPORT).bind(
      receivedAt,
      asString(payload.install_id),
      asString(payload.version),
      asString(runtime.os),
      asString(runtime.arch),
      country,
      asNumber(metrics.sessions),
      asNumber(metrics.events),
      asNumber(metrics.tool_calls),
      asNumber(metrics.errors),
      asNumber(metrics.error_rate),
      JSON.stringify(payload),
    ),
  ]);

  return json({ ok: true });
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  let payload: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return json({ error: 'invalid_payload' }, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const type = typeof payload.type === 'string' ? payload.type : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const emailRaw = typeof payload.email === 'string' ? payload.email.trim() : '';
  const token = typeof payload.turnstile_token === 'string' ? payload.turnstile_token : '';

  if (!FEEDBACK_TYPES.has(type)) {
    return json({ error: 'invalid_type' }, 400);
  }
  if (!message || message.length > MAX_MESSAGE_LEN) {
    return json({ error: 'invalid_message' }, 400);
  }
  if (emailRaw && !isValidEmail(emailRaw)) {
    return json({ error: 'invalid_email' }, 400);
  }
  if (!token) {
    return json({ error: 'captcha_required' }, 400);
  }

  const secret = env.TURNSTILE_SECRET_KEY || TURNSTILE_TEST_SECRET;
  const clientIp = request.headers.get('CF-Connecting-IP');
  const captchaOk = await verifyTurnstile(token, secret, clientIp);
  if (!captchaOk) {
    return json({ error: 'captcha_failed' }, 403);
  }

  const receivedAt = new Date().toISOString();
  const country = (request.cf?.country as string | undefined) ?? null;
  const userAgent = request.headers.get('User-Agent')?.slice(0, 300) ?? null;

  await env.MESSAGES_DB.batch([
    env.MESSAGES_DB.prepare(CREATE_MESSAGES_TABLE),
    env.MESSAGES_DB.prepare(INSERT_MESSAGE).bind(
      receivedAt,
      type,
      emailRaw || null,
      message,
      country,
      userAgent,
    ),
  ]);

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/telemetry') {
      return handleTelemetry(request, env);
    }
    if (url.pathname === '/v1/feedback') {
      return handleFeedback(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

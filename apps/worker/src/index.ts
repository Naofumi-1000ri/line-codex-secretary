import { jobResultSchema } from "@line-secretary/protocol";
import { z } from "zod";

interface Env {
  DB: D1Database;
  APP_VERSION: string;
  ENVIRONMENT: string;
  DEFAULT_WORKSPACE_KEY: string;
  AGENT_ID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  AGENT_TOKEN_SHA256: string;
}

type LineEvent = {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
};

type LineWebhook = { events?: LineEvent[] };

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 16_384;
const JOB_LEASE_SECONDS = 45 * 60;

const transitionSchema = z.object({
  leaseToken: z.string().min(32),
  threadId: z.string().max(200).optional(),
  progress: z.string().max(300).optional(),
  result: jobResultSchema.optional(),
  errorCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional()
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function error(code: string, status: number): Response {
  return response({ ok: false, error: code }, status);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string
): Promise<boolean> {
  if (!signature || !channelSecret) return false;
  const supplied = base64ToBytes(signature);
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  return constantTimeEqual(expected, supplied);
}

async function authenticateAgent(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token || !env.AGENT_TOKEN_SHA256) return false;
  const suppliedHash = await sha256(token);
  return constantTimeEqual(encoder.encode(suppliedHash), encoder.encode(env.AGENT_TOKEN_SHA256));
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function newJobId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const random = crypto.getRandomValues(new Uint8Array(6));
  return `J${time}${bytesToHex(random).toUpperCase()}`;
}

function sanitizeLineText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 4_000);
}

function lineStatus(status: string): string {
  const statuses: Record<string, string> = {
    QUEUED: "📨 PCへの送信待ち",
    LEASED: "🖥️ PCが受信済み",
    RUNNING: "🧠 Codexが確認中",
    WAITING_APPROVAL: "✋ 確認待ち",
    RETRY_WAIT: "🔄 再接続中",
    CANCEL_REQUESTED: "⏹️ 停止処理中",
    CANCELLED: "⏹️ 停止済み",
    COMPLETED: "✅ 完了",
    FAILED: "⚠️ 失敗"
  };
  return statuses[status] ?? status;
}

async function lineApi(
  env: Env,
  path: "/reply" | "/push",
  payload: Record<string, unknown>
): Promise<boolean> {
  const result = await fetch(`https://api.line.me/v2/bot/message${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return result.ok;
}

async function reply(env: Env, replyToken: string | undefined, text: string): Promise<void> {
  if (!replyToken) return;
  await lineApi(env, "/reply", {
    replyToken,
    messages: [{ type: "text", text: sanitizeLineText(text) }]
  });
}

async function push(env: Env, userId: string, text: string): Promise<boolean> {
  return lineApi(env, "/push", {
    to: userId,
    messages: [{ type: "text", text: sanitizeLineText(text) }]
  });
}

function linkCodeFrom(text: string): string | null {
  const match = text.trim().match(/^\/link\s+(\d{6})$/);
  return match?.[1] ?? null;
}

async function handleLink(
  event: LineEvent,
  userId: string,
  code: string,
  env: Env
): Promise<void> {
  const codeHash = await sha256(code);
  const timestamp = nowIso();
  const link = await env.DB.prepare(
    "SELECT code_hash FROM link_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?"
  ).bind(codeHash, timestamp).first();
  if (!link) {
    await reply(env, event.replyToken, "リンクコードを確認できませんでした。PCで新しいコードを作ってください。");
    return;
  }

  const existingOwner = await env.DB.prepare("SELECT user_id FROM owners WHERE active = 1 LIMIT 1").first();
  if (existingOwner && existingOwner.user_id !== userId) {
    await reply(env, event.replyToken, "この秘書にはすでに所有者が登録されています。");
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO owners(user_id, linked_at, active) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET active = 1"
    ).bind(userId, timestamp),
    env.DB.prepare("UPDATE link_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL").bind(
      timestamp,
      codeHash
    ),
    env.DB.prepare(
      "INSERT INTO audit_events(actor, action, metadata_json, created_at) VALUES ('line-user', 'owner.linked', '{}', ?)"
    ).bind(timestamp)
  ]);
  await reply(env, event.replyToken, "PC Codex秘書と安全にリンクできました。");
}

async function handleOwnerCommand(
  event: LineEvent,
  userId: string,
  text: string,
  env: Env
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed === "ヘルプ") {
    await reply(
      env,
      event.replyToken,
      "🤖 PC Codex秘書\n\n文章で依頼を送ってください。\n「状態」→ 直近の処理状況\n「キャンセル 受付番号」→ 処理を停止"
    );
    return true;
  }

  if (trimmed === "状態" || /^状態\s+J[A-Z0-9]+$/.test(trimmed)) {
    const requestedId = trimmed.split(/\s+/)[1];
    const query = requestedId
      ? env.DB.prepare("SELECT id, status FROM jobs WHERE id = ? AND user_id = ?").bind(requestedId, userId)
      : env.DB.prepare("SELECT id, status FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(userId);
    const job = await query.first<{ id: string; status: string }>();
    await reply(
      env,
      event.replyToken,
      job ? `${lineStatus(job.status)}\n受付番号: ${job.id}` : "まだ依頼はありません。"
    );
    return true;
  }

  const cancelMatch = trimmed.match(/^キャンセル\s+(J[A-Z0-9]+)$/);
  if (cancelMatch) {
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = 'CANCEL_REQUESTED', cancel_requested_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT')"
    ).bind(nowIso(), nowIso(), cancelMatch[1], userId).run();
    await reply(
      env,
      event.replyToken,
      result.meta.changes > 0 ? `${cancelMatch[1]} の停止を受け付けました。` : "停止できる依頼を確認できませんでした。"
    );
    return true;
  }
  return false;
}

async function createJob(event: LineEvent, userId: string, prompt: string, env: Env): Promise<string> {
  const eventId = event.webhookEventId ?? `local-${newJobId()}`;
  const existing = await env.DB.prepare("SELECT id FROM jobs WHERE webhook_event_id = ?").bind(eventId).first<{ id: string }>();
  if (existing) return existing.id;

  const jobId = newJobId();
  const timestamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO line_events(webhook_event_id, user_id, event_type, received_at) VALUES (?, ?, 'message', ?)"
    ).bind(eventId, userId, timestamp),
    env.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id, webhook_event_id, user_id, conversation_key, workspace_key, prompt, requested_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'read_only', 'QUEUED', ?, ?)"
    ).bind(jobId, eventId, userId, userId, env.DEFAULT_WORKSPACE_KEY, prompt.slice(0, 8_000), timestamp, timestamp)
  ]);
  const saved = await env.DB.prepare("SELECT id FROM jobs WHERE webhook_event_id = ?").bind(eventId).first<{ id: string }>();
  return saved?.id ?? jobId;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) return error("BODY_TOO_LARGE", 413);
  const rawBody = await request.text();
  if (encoder.encode(rawBody).byteLength > MAX_BODY_BYTES) return error("BODY_TOO_LARGE", 413);
  const valid = await verifyLineSignature(rawBody, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET);
  if (!valid) return error("INVALID_SIGNATURE", 401);

  let body: LineWebhook;
  try {
    body = JSON.parse(rawBody) as LineWebhook;
  } catch {
    return error("INVALID_JSON", 400);
  }

  for (const event of body.events ?? []) {
    const userId = event.source?.type === "user" ? event.source.userId : undefined;
    const text = event.message?.type === "text" ? event.message.text : undefined;
    if (!userId) continue;

    if (text) {
      const code = linkCodeFrom(text);
      if (code) {
        await handleLink(event, userId, code, env);
        continue;
      }
    }

    const owner = await env.DB.prepare("SELECT user_id FROM owners WHERE user_id = ? AND active = 1").bind(userId).first();
    if (!owner) {
      await reply(env, event.replyToken, "この秘書はまだこのLINEアカウントとリンクされていません。");
      continue;
    }

    if (!text) {
      await reply(env, event.replyToken, "今は文字のメッセージだけ受け付けています。");
      continue;
    }
    if (await handleOwnerCommand(event, userId, text, env)) continue;

    const jobId = await createJob(event, userId, text, env);
    await reply(
      env,
      event.replyToken,
      `📨 PC Codexへ送信しました\n\n受付番号: ${jobId}\n🔒 読み取り専用で確認します`
    );
  }
  return response({ ok: true });
}

async function parseJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new Error("CONTENT_TYPE");
  return request.json();
}

function requireIdempotency(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && /^[a-zA-Z0-9._:-]{8,128}$/.test(value) ? value : null;
}

async function recordEventOnce(
  env: Env,
  jobId: string,
  kind: string,
  idempotencyKey: string,
  publicMessage?: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO job_events(job_id, kind, public_message, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(jobId, kind, publicMessage ?? null, idempotencyKey, nowIso()).run();
  return result.meta.changes > 0;
}

async function validLease(env: Env, jobId: string, leaseToken: string): Promise<boolean> {
  const tokenHash = await sha256(leaseToken);
  const row = await env.DB.prepare(
    "SELECT id FROM jobs WHERE id = ? AND lease_token_hash = ? AND lease_expires_at > ?"
  ).bind(jobId, tokenHash, nowIso()).first();
  return Boolean(row);
}

async function claimJob(env: Env): Promise<Response> {
  const leaseToken = randomToken();
  const leaseHash = await sha256(leaseToken);
  const timestamp = nowIso();
  const leaseExpiresAt = new Date(Date.now() + JOB_LEASE_SECONDS * 1_000).toISOString();
  await env.DB.prepare(
    "UPDATE jobs SET status = 'QUEUED', lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE status IN ('LEASED','RUNNING') AND lease_expires_at <= ? AND attempt_count < 3"
  ).bind(timestamp, timestamp).run();
  await env.DB.prepare(
    "UPDATE jobs SET status = 'FAILED', error_code = 'RETRY_LIMIT', updated_at = ? WHERE status IN ('LEASED','RUNNING') AND lease_expires_at <= ? AND attempt_count >= 3"
  ).bind(timestamp, timestamp).run();

  const job = await env.DB.prepare(
    `UPDATE jobs
       SET status = 'LEASED', lease_token_hash = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = (
       SELECT candidate.id FROM jobs candidate
       WHERE candidate.status IN ('QUEUED','RETRY_WAIT')
         AND NOT EXISTS (
           SELECT 1 FROM jobs active
           WHERE active.conversation_key = candidate.conversation_key
             AND active.status IN ('LEASED','RUNNING','WAITING_APPROVAL')
         )
       ORDER BY candidate.created_at LIMIT 1
     )
     RETURNING id, prompt, conversation_key, workspace_key, requested_mode`
  ).bind(leaseHash, leaseExpiresAt, timestamp).first<{
    id: string;
    prompt: string;
    conversation_key: string;
    workspace_key: string;
    requested_mode: "read_only";
  }>();
  if (!job) return response({ job: null });
  return response({
    job: {
      id: job.id,
      prompt: job.prompt,
      conversationId: await sha256(job.conversation_key),
      workspaceKey: job.workspace_key,
      requestedMode: job.requested_mode,
      leaseToken,
      leaseExpiresAt
    }
  });
}

async function handleTransition(request: Request, env: Env, jobId: string, action: string): Promise<Response> {
  const key = requireIdempotency(request);
  if (!key) return error("IDEMPOTENCY_KEY_REQUIRED", 400);
  let body: z.infer<typeof transitionSchema>;
  try {
    body = transitionSchema.parse(await parseJson(request));
  } catch {
    return error("INVALID_REQUEST", 400);
  }
  if (!(await validLease(env, jobId, body.leaseToken))) return error("INVALID_LEASE", 409);
  if (!(await recordEventOnce(env, jobId, action, key, body.progress))) {
    const current = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first();
    return response({ ok: true, duplicate: true, status: current?.status });
  }

  const timestamp = nowIso();
  if (action === "start") {
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, ?), codex_thread_id = COALESCE(?, codex_thread_id), updated_at = ? WHERE id = ? AND status = 'LEASED' RETURNING user_id"
    ).bind(timestamp, body.threadId ?? null, timestamp, jobId).first<{ user_id: string }>();
    if (!result) return error("INVALID_STATE", 409);
    const delivered = await push(
      env,
      result.user_id,
      `🖥️ PC Codexが受信しました\n\n🧠 Codexが確認中です…\n受付番号: ${jobId}`
    );
    return response({ ok: true, notificationDelivered: delivered });
  }

  if (action === "heartbeat") {
    const leaseExpiresAt = new Date(Date.now() + JOB_LEASE_SECONDS * 1_000).toISOString();
    await env.DB.prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('LEASED','RUNNING','CANCEL_REQUESTED')")
      .bind(leaseExpiresAt, timestamp, jobId).run();
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    return response({ ok: true, cancelRequested: job?.status === "CANCEL_REQUESTED", leaseExpiresAt });
  }

  if (action === "complete") {
    if (!body.result) return error("RESULT_REQUIRED", 400);
    const savedResult = sanitizeLineText(body.result.summary);
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = 'COMPLETED', result = ?, prompt = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('LEASED','RUNNING') RETURNING user_id"
    ).bind(savedResult, timestamp, timestamp, jobId).first<{ user_id: string }>();
    if (!result) return error("INVALID_STATE", 409);
    const delivered = await push(
      env,
      result.user_id,
      `✅ Codexから返信が届きました\n\n${savedResult}\n\n受付番号: ${jobId}`
    );
    await env.DB.prepare("UPDATE jobs SET notification_status = ? WHERE id = ?")
      .bind(delivered ? "SENT" : "FAILED", jobId).run();
    return response({ ok: true, notificationDelivered: delivered });
  }

  if (action === "fail") {
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = CASE WHEN attempt_count < 3 THEN 'RETRY_WAIT' ELSE 'FAILED' END, error_code = ?, updated_at = ? WHERE id = ? AND status IN ('LEASED','RUNNING','CANCEL_REQUESTED')"
    ).bind(body.errorCode ?? "AGENT_ERROR", timestamp, jobId).run();
    return result.meta.changes ? response({ ok: true }) : error("INVALID_STATE", 409);
  }
  return error("NOT_FOUND", 404);
}

async function createLinkCode(env: Env): Promise<Response> {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const code = String((array[0]! % 900_000) + 100_000);
  const codeHash = await sha256(code);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM link_codes WHERE consumed_at IS NOT NULL OR expires_at <= ?").bind(createdAt),
    env.DB.prepare("INSERT INTO link_codes(code_hash, expires_at, created_at) VALUES (?, ?, ?)").bind(
      codeHash,
      expiresAt,
      createdAt
    )
  ]);
  return response({ code, expiresAt });
}

async function setupStatus(env: Env): Promise<Response> {
  const [owners, queued, completed, agents, schema] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM owners WHERE active = 1").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'QUEUED'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'COMPLETED'").first<{ count: number }>(),
    env.DB.prepare("SELECT agent_id, last_seen_at, version FROM agents ORDER BY last_seen_at DESC LIMIT 1").first(),
    env.DB.prepare("SELECT MAX(version) AS version FROM schema_versions").first<{ version: number }>()
  ]);
  return response({
    schemaVersion: schema?.version ?? null,
    ownerCount: owners?.count ?? 0,
    queuedJobs: queued?.count ?? 0,
    completedJobs: completed?.count ?? 0,
    latestAgent: agents ?? null
  });
}

async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    try {
      const schema = await env.DB.prepare("SELECT MAX(version) AS version FROM schema_versions").first<{ version: number }>();
      return response({ ok: true, version: env.APP_VERSION, environment: env.ENVIRONMENT, schemaVersion: schema?.version ?? null });
    } catch {
      return response({ ok: false, version: env.APP_VERSION, environment: env.ENVIRONMENT, error: "DB_NOT_READY" }, 503);
    }
  }
  if (request.method === "POST" && url.pathname === "/v1/line/webhook") return handleWebhook(request, env);

  if (url.pathname.startsWith("/v1/agent/") || url.pathname.startsWith("/v1/setup/")) {
    if (!(await authenticateAgent(request, env))) return error("UNAUTHORIZED", 401);
  }

  if (request.method === "GET" && url.pathname === "/v1/agent/health") {
    const timestamp = nowIso();
    await env.DB.prepare(
      "INSERT INTO agents(agent_id, last_seen_at, version) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, version = excluded.version"
    ).bind(env.AGENT_ID, timestamp, request.headers.get("x-agent-version") ?? "unknown").run();
    return response({ ok: true, serverTime: timestamp, version: env.APP_VERSION });
  }
  if (request.method === "POST" && url.pathname === "/v1/agent/jobs/claim") return claimJob(env);
  if (request.method === "POST" && url.pathname === "/v1/setup/link-code") return createLinkCode(env);
  if (request.method === "GET" && url.pathname === "/v1/setup/status") return setupStatus(env);

  const transition = url.pathname.match(/^\/v1\/agent\/jobs\/([^/]+)\/(start|heartbeat|complete|fail)$/);
  if (request.method === "POST" && transition) {
    return handleTransition(request, env, decodeURIComponent(transition[1]!), transition[2]!);
  }
  return error("NOT_FOUND", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await router(request, env);
    } catch {
      return error("INTERNAL_ERROR", 500);
    }
  }
} satisfies ExportedHandler<Env>;

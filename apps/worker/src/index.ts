import { RELEASE_VERSION, AGENT_PROTOCOL_VERSION } from "@line-secretary/protocol";
import { jobResultSchema, mediaSchema, type MediaAttachment } from "@line-secretary/protocol";
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
  timestamp?: number;
  message?: {
    type?: string; text?: string; id?: string;
    contentProvider?: { type?: string };
    imageSet?: { id?: string; index?: number; total?: number };
  };
};

type LineWebhook = { events?: LineEvent[] };

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 16_384;
const JOB_LEASE_SECONDS = 45 * 60;

const transitionSchema = z.object({
  leaseToken: z.string().min(32),
  threadId: z.string().max(200).optional(),
  progress: z.string().max(300).optional(),
  suppressStart: z.boolean().optional(),
  activity: z.enum(["analyze", "organize"]).optional(),
  imageCount: z.number().int().min(0).max(30).optional(),
  videoCount: z.number().int().min(0).max(30).optional(),
  notification: z.object({ mode: z.enum(["quiet", "detailed", "inherit"]), scope: z.enum(["turn", "conversation"]) }).optional(),
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
  if (trimmed === "ヘルプ" || trimmed === "できること") {
    await reply(
      env,
      event.replyToken,
      "🤖 PC Codex秘書\n\n文章での相談、画像・動画の保存と整理ができます。\n画像・動画はPCへ保存し、前後のご依頼に沿ってまとめて扱います。指示がなければ用途を確認します。動画は代表フレームを確認します（音声の文字起こしは未対応）。\n通常は返信だけをお届けします。「今回は詳細ログも出して」「これから詳細ログを出して」「ログはもういい」で表示を切り替えられます。\n画像20MB・動画200MBまで。PCを起動して送ってください。\n「状態」→ 直近の処理状況\n「キャンセル 受付番号」→ 処理を停止"
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
      "UPDATE jobs SET status = 'CANCEL_REQUESTED', cancel_requested_at = ?, updated_at = ? WHERE (id = ? OR lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?)) AND user_id = ? AND status IN ('QUEUED','LEASED','RUNNING','RETRY_WAIT')"
    ).bind(nowIso(), nowIso(), cancelMatch[1], cancelMatch[1], userId).run();
    await reply(
      env,
      event.replyToken,
      result.meta.changes > 0 ? `${cancelMatch[1]} の停止を受け付けました。` : "停止できる依頼を確認できませんでした。"
    );
    return true;
  }
  return false;
}

async function createJob(event: LineEvent, userId: string, prompt: string, env: Env, media?: MediaAttachment): Promise<string> {
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
      "INSERT OR IGNORE INTO jobs(id, webhook_event_id, user_id, conversation_key, workspace_key, prompt, requested_mode, status, created_at, updated_at, notice_group) VALUES (?, ?, ?, ?, ?, ?, 'read_only', 'QUEUED', ?, ?, (SELECT COALESCE(notice_group, id) FROM jobs WHERE conversation_key = ? AND status IN ('LEASED','RUNNING') ORDER BY created_at, id LIMIT 1))"
    ).bind(jobId, eventId, userId, userId, env.DEFAULT_WORKSPACE_KEY, prompt.slice(0, 8_000), timestamp, timestamp, userId),
    ...(media ? [env.DB.prepare(
      "INSERT OR IGNORE INTO job_media(job_id, message_id, metadata_json) SELECT id, ?, ? FROM jobs WHERE webhook_event_id = ?"
    ).bind(media.messageId, JSON.stringify(media), eventId)] : [])
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

    if (event.type === "message" && (event.message?.type === "image" || event.message?.type === "video")) {
      if (event.message.contentProvider?.type !== "line") {
        await reply(env, event.replyToken, "この画像・動画の取得元には対応していません。LINEの添付ボタンから送ってください。");
        continue;
      }
      const parsed = mediaSchema.safeParse({
        messageId: event.message.id,
        kind: event.message.type,
        receivedAt: typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
          && event.timestamp > 0 && event.timestamp < 8.64e15 ? new Date(event.timestamp).toISOString() : nowIso(),
        groupId: event.message.imageSet?.id,
        groupIndex: event.message.imageSet?.index,
        groupTotal: event.message.imageSet?.total
      });
      if (!parsed.success) {
        await reply(env, event.replyToken, "画像・動画の情報を確認できませんでした。もう一度送ってください。");
        continue;
      }
      const label = parsed.data.kind === "image" ? "画像" : "動画";
      await createJob(event, userId, `[添付受信: ${label}]`, env, parsed.data);
      // Receipt is recorded internally; the agent sends one conversational response.
      continue;
    }
    if (!text) {
      await reply(env, event.replyToken, "文字・画像・動画に対応しています。音声・その他のファイルはまだ受け付けていません。");
      continue;
    }
    if (await handleOwnerCommand(event, userId, text, env)) continue;

    await createJob(event, userId, text, env);

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

  // One atomic UPDATE leases the whole settled conversation burst. A concurrent
  // claimant cannot take a second item from the same conversation.
  const settled = new Date(Date.now() - 8_000).toISOString();
  const groupDeadline = new Date(Date.now() - 60_000).toISOString();
  const claimed = await env.DB.prepare(`
    UPDATE jobs SET status = 'LEASED', lease_token_hash = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, updated_at = ?
    WHERE id IN (
      SELECT id FROM jobs WHERE status IN ('QUEUED','RETRY_WAIT') AND conversation_key = (
        SELECT candidate.conversation_key FROM jobs candidate
        WHERE candidate.status IN ('QUEUED','RETRY_WAIT')
          AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.conversation_key = candidate.conversation_key
            AND active.status IN ('LEASED','RUNNING','WAITING_APPROVAL'))
          AND NOT EXISTS (SELECT 1 FROM jobs recent WHERE recent.conversation_key = candidate.conversation_key
            AND recent.status IN ('QUEUED','RETRY_WAIT') AND recent.created_at > ?)
          AND NOT EXISTS (
            SELECT 1 FROM jobs pending JOIN job_media m ON m.job_id = pending.id
            WHERE pending.conversation_key = candidate.conversation_key AND pending.status IN ('QUEUED','RETRY_WAIT')
              AND pending.created_at > ? AND json_extract(m.metadata_json, '$.groupTotal') > (
                SELECT COUNT(DISTINCT json_extract(s.metadata_json, '$.groupIndex'))
                FROM job_media s JOIN jobs sj ON sj.id = s.job_id
                WHERE sj.conversation_key = candidate.conversation_key
                  AND json_extract(s.metadata_json, '$.groupId') = json_extract(m.metadata_json, '$.groupId')
              )
          )
        ORDER BY candidate.created_at, candidate.rowid LIMIT 1
      ) ORDER BY created_at, rowid LIMIT 30
    ) RETURNING id, prompt, conversation_key, workspace_key, requested_mode, created_at, notice_group, rowid AS enqueue_order
  `).bind(leaseHash, leaseExpiresAt, timestamp, settled, groupDeadline).all<{
    id: string; prompt: string; conversation_key: string; workspace_key: string;
    requested_mode: "read_only"; created_at: string; notice_group: string | null; enqueue_order: number;
  }>();
  const rows = claimed.results.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.enqueue_order - b.enqueue_order);
  const job = rows[0];
  if (!job) return response({ job: null });
  const attachments: { jobId: string; media: MediaAttachment }[] = [];
  const texts: string[] = [];
  for (const row of rows) {
    const attachment = await env.DB.prepare("SELECT metadata_json FROM job_media WHERE job_id = ?")
      .bind(row.id).first<{ metadata_json: string }>();
    if (attachment) attachments.push({ jobId: row.id, media: mediaSchema.parse(JSON.parse(attachment.metadata_json)) });
    else texts.push(row.prompt);
  }
  attachments.sort((a, b) => a.media.receivedAt.localeCompare(b.media.receivedAt));
  attachments.sort((a, b) => a.media.groupId && a.media.groupId === b.media.groupId
    ? (a.media.groupIndex ?? 0) - (b.media.groupIndex ?? 0) : 0);
  const preference = await env.DB.prepare("SELECT notification_mode FROM conversation_preferences WHERE conversation_key = ?")
    .bind(job.conversation_key).first<{ notification_mode: string }>();
  const previous = job.notice_group ? await env.DB.prepare("SELECT DISTINCT result FROM jobs WHERE notice_group = ? AND notification_status = 'DEFERRED' AND result IS NOT NULL")
    .bind(job.notice_group).all<{ result: string }>() : { results: [] };
  return response({ job: {
    previousResults: previous.results.map((row) => row.result),
    id: job.id, prompt: texts.join("\n\n") || "添付ファイルが届きました。",
    conversationId: await sha256(job.conversation_key), workspaceKey: job.workspace_key,
    requestedMode: job.requested_mode, leaseToken, leaseExpiresAt,
    notificationMode: preference?.notification_mode ?? "quiet", attachments,
    continuation: Boolean(job.notice_group),
    ...(attachments.length === 1 ? { media: attachments[0]!.media } : {})
  } });
}

async function mediaContent(request: Request, env: Env, jobId: string): Promise<Response> {
  const lease = request.headers.get("x-job-lease");
  if (!lease || !(await validLease(env, jobId, lease))) return error("INVALID_LEASE", 409);
  const attachment = await env.DB.prepare(
    "SELECT m.message_id FROM job_media m JOIN jobs j ON j.id = m.job_id WHERE m.job_id = ? AND j.status IN ('LEASED','RUNNING')"
  ).bind(jobId).first<{ message_id: string }>();
  if (!attachment) return error("MEDIA_NOT_FOUND", 404);
  const upstream = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(attachment.message_id)}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    redirect: "manual"
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return error(upstream.status === 202 || upstream.status === 429 || upstream.status >= 500
      ? "MEDIA_NOT_READY" : "MEDIA_UNAVAILABLE", upstream.status === 202 || upstream.status === 429 || upstream.status >= 500 ? 503 : 410);
  }
  // LINE uses 202 while a video is being transcoded; it has no downloadable body yet.
  if (upstream.status === 202) {
    await upstream.body?.cancel();
    return error("MEDIA_NOT_READY", 503);
  }
  return new Response(upstream.body, { headers: {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  } });
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
      "UPDATE jobs SET status = 'RUNNING', started_at = COALESCE(started_at, ?), codex_thread_id = COALESCE(?, codex_thread_id), updated_at = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?) AND status = 'LEASED' RETURNING user_id"
    ).bind(timestamp, body.threadId ?? null, timestamp, jobId).first<{ user_id: string }>();
    if (!result) return error("INVALID_STATE", 409);
    return response({ ok: true });
  }

  if (action === "notification") {
    if (!body.notification) return error("NOTIFICATION_REQUIRED", 400);
    const job = await env.DB.prepare("SELECT user_id, conversation_key, notification_mode FROM jobs WHERE id = ? AND status = 'RUNNING'")
      .bind(jobId).first<{ user_id: string; conversation_key: string; notification_mode: string }>();
    if (!job) return error("INVALID_STATE", 409);
    const preference = await env.DB.prepare("SELECT notification_mode FROM conversation_preferences WHERE conversation_key = ?")
      .bind(job.conversation_key).first<{ notification_mode: string }>();
    const mode = body.notification.mode === "inherit" ? preference?.notification_mode ?? "quiet" : body.notification.mode;
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET notification_mode = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?)").bind(mode, jobId),
      ...(body.notification.scope === "conversation" && body.notification.mode !== "inherit" ? [
        env.DB.prepare("INSERT INTO conversation_preferences(conversation_key, notification_mode) VALUES (?, ?) ON CONFLICT(conversation_key) DO UPDATE SET notification_mode = excluded.notification_mode")
          .bind(job.conversation_key, mode)
      ] : [])
    ]);
    if (mode === "detailed" && !body.suppressStart) await push(env, job.user_id, `処理を開始しました。\n受付番号: ${jobId}`);
    return response({ ok: true });
  }

  if (action === "activity") {
    if (!body.activity || !(Number(body.imageCount) + Number(body.videoCount) > 0)) return error("ACTIVITY_REQUIRED", 400);
    const job = await env.DB.prepare("SELECT user_id, COALESCE(notice_group, id) AS notice_group FROM jobs WHERE id = ? AND status = 'RUNNING'")
      .bind(jobId).first<{ user_id: string; notice_group: string }>();
    if (!job) return error("INVALID_STATE", 409);
    await env.DB.prepare("UPDATE jobs SET notice_group = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?)")
      .bind(job.notice_group, jobId).run();
    const first = await recordEventOnce(env, jobId, "activity_notice", `activity:${job.notice_group}`);
    if (first) {
      const media = [body.imageCount ? `画像${body.imageCount}枚` : "", body.videoCount ? `動画${body.videoCount}本` : ""].filter(Boolean).join("・");
      const text = `${media}を受信しました。${body.activity === "analyze" ? "解析中です。" : "整理しています。"}\n追加があれば、回答を待たずに送信してください。`;
      return response({ ok: true, notificationDelivered: await push(env, job.user_id, text) });
    }
    return response({ ok: true, suppressed: true });
  }

  if (action === "progress") {
    const job = await env.DB.prepare("SELECT user_id, notification_mode FROM jobs WHERE id = ? AND status = 'RUNNING'")
      .bind(jobId).first<{ user_id: string; notification_mode: string }>();
    if (!job) return error("INVALID_STATE", 409);
    if (job.notification_mode === "detailed" && body.progress) await push(env, job.user_id, body.progress);
    return response({ ok: true });
  }

  if (action === "heartbeat") {
    const leaseExpiresAt = new Date(Date.now() + JOB_LEASE_SECONDS * 1_000).toISOString();
    await env.DB.prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?) AND status IN ('LEASED','RUNNING','CANCEL_REQUESTED')")
      .bind(leaseExpiresAt, timestamp, jobId).run();
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    return response({ ok: true, cancelRequested: job?.status === "CANCEL_REQUESTED", leaseExpiresAt });
  }

  if (action === "complete") {
    if (!body.result) return error("RESULT_REQUIRED", 400);
    const savedResult = sanitizeLineText(body.result.summary);
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = 'COMPLETED', result = ?, prompt = NULL, completed_at = ?, updated_at = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?) AND status IN ('LEASED','RUNNING') RETURNING user_id, notification_mode, notice_group"
    ).bind(savedResult, timestamp, timestamp, jobId).first<{ user_id: string; notification_mode: string; notice_group: string | null }>();
    if (!result) return error("INVALID_STATE", 409);
    const additions = result.notice_group ? await env.DB.prepare("SELECT id FROM jobs WHERE notice_group = ? AND status IN ('QUEUED','RETRY_WAIT') LIMIT 1")
      .bind(result.notice_group).first() : null;
    if (additions) {
      await env.DB.prepare("UPDATE jobs SET notification_status = 'DEFERRED' WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?)")
        .bind(jobId).run();
      return response({ ok: true, deferred: true });
    }
    const delivered = await push(
      env,
      result.user_id,
      result.notification_mode === "detailed" ? `${savedResult}\n\n処理完了・受付番号: ${jobId}` : savedResult
    );
    await env.DB.prepare("UPDATE jobs SET notification_status = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?)")
      .bind(delivered ? "SENT" : "FAILED", jobId).run();
    return response({ ok: true, notificationDelivered: delivered });
  }

  if (action === "fail") {
    const permanent = ["MEDIA_TOO_LARGE", "MEDIA_FORMAT_UNSUPPORTED", "MEDIA_UNAVAILABLE", "MEDIA_EMPTY"].includes(body.errorCode ?? "");
    const result = await env.DB.prepare(
      "UPDATE jobs SET status = CASE WHEN status = 'CANCEL_REQUESTED' THEN 'CANCELLED' WHEN attempt_count < 3 AND ? = 0 THEN 'RETRY_WAIT' ELSE 'FAILED' END, error_code = ?, updated_at = ? WHERE lease_token_hash = (SELECT lease_token_hash FROM jobs WHERE id = ?) AND status IN ('LEASED','RUNNING','CANCEL_REQUESTED') RETURNING user_id, status"
    ).bind(permanent ? 1 : 0, body.errorCode ?? "AGENT_ERROR", timestamp, jobId).first<{ user_id: string; status: string }>();
    if (!result) return error("INVALID_STATE", 409);
    if (result.status === "FAILED") {
      const messages: Record<string, string> = {
        MEDIA_TOO_LARGE: "保存上限を超えています。画像は20MB、動画は200MB以下にして送ってください。",
        MEDIA_FORMAT_UNSUPPORTED: "この画像・動画の形式は保存に対応していません。JPEG・PNGなどの画像、MP4・MOVの動画を送ってください。",
        MEDIA_UNAVAILABLE: "LINEからファイルを取得できませんでした。PCを起動した状態でもう一度送ってください。"
      };
      await push(env, result.user_id, `⚠️ 処理を完了できませんでした\n\n${messages[body.errorCode ?? ""] ?? "再試行しても処理できませんでした。PCの状態を確認してください。保存済みの元ファイルはPCに残ります。"}\n受付番号: ${jobId}`);
    }
    return response({ ok: true });
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
      return response({ ok: true, version: RELEASE_VERSION, environment: env.ENVIRONMENT, schemaVersion: schema?.version ?? null });
    } catch {
      return response({ ok: false, version: RELEASE_VERSION, environment: env.ENVIRONMENT, error: "DB_NOT_READY" }, 503);
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
    return response({ ok: true, serverTime: timestamp, version: RELEASE_VERSION });
  }
  if (request.method === "POST" && url.pathname === "/v1/agent/jobs/claim") {
    if (request.headers.get("x-agent-version") !== AGENT_PROTOCOL_VERSION) return error("AGENT_UPGRADE_REQUIRED", 426);
    return claimJob(env);
  }
  const mediaRoute = url.pathname.match(/^\/v1\/agent\/jobs\/([^/]+)\/media$/);
  if (request.method === "GET" && mediaRoute) return mediaContent(request, env, decodeURIComponent(mediaRoute[1]!));
  if (request.method === "POST" && url.pathname === "/v1/setup/link-code") return createLinkCode(env);
  if (request.method === "GET" && url.pathname === "/v1/setup/status") return setupStatus(env);

  const transition = url.pathname.match(/^\/v1\/agent\/jobs\/([^/]+)\/(start|notification|activity|progress|heartbeat|complete|fail)$/);
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

import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

let db: DatabaseSync;
let env: Parameters<typeof worker.fetch>[1];
const token = "test-agent-token";
const secret = "test-secret";
const network = vi.fn();

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_media.sql", "0003_conversation_ux.sql", "0004_work_notices.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.exec("INSERT INTO owners VALUES ('test-owner', '2026-09-08', 1)");
  const prepare = (sql: string) => {
    let args: (string | number | null)[] = [];
    const statement = {
      bind: (...values: typeof args) => { args = values; return statement; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } })
    };
    return statement;
  };
  env = {
    DB: { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => {
      db.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } },
    LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "test-line-token",
    AGENT_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"), DEFAULT_WORKSPACE_KEY: "linebot"
  } as unknown as typeof env;
  network.mockReset().mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", network);
});
afterEach(() => { vi.unstubAllGlobals(); db.close(); });

async function webhook(type: string, userId = "test-owner", provider = "line") {
  const body = JSON.stringify({ events: [{ type: "message", timestamp: 1788825600000,
    webhookEventId: `test-${type}`, replyToken: "test-reply", source: { type: "user", userId },
    message: { type, id: `content-${type}`, contentProvider: { type: provider }, imageSet: { id: "album", index: 1, total: 2 } }
  }] });
  return worker.fetch(new Request("https://worker.test/v1/line/webhook", { method: "POST",
    headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") }, body }), env);
}
async function claim() {
  db.exec("UPDATE jobs SET created_at = '2020-01-01T00:00:00.000Z'");
  const response = await worker.fetch(new Request("https://worker.test/v1/agent/jobs/claim", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-agent-version": "0.3.0" }
  }), env);
  expect(response.status).toBe(200);
  return (await response.json() as { job: { id: string; leaseToken: string; media: { kind: string; groupId: string } } }).job;
}
async function content(id: string, lease: string, auth = token) {
  return worker.fetch(new Request(`https://worker.test/v1/agent/jobs/${id}/media`, {
    headers: { authorization: `Bearer ${auth}`, "x-job-lease": lease }
  }), env);
}

describe("media webhook and authenticated delivery", () => {
  it.each(["image", "video"])("queues %s once and returns attachment metadata when claimed", async (kind) => {
    expect((await webhook(kind)).status).toBe(200);
    expect((await webhook(kind)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_media").get()?.n).toBe(1);
    const job = await claim();
    expect(job.media.kind).toBe(kind);
    expect(job.media.groupId).toBe("album");
    const payload = new Uint8Array([1, 2, 3]);
    network.mockResolvedValueOnce(new Response(payload, { headers: { "content-type": "image/jpeg" } }));
    const response = await content(job.id, job.leaseToken);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(network).toHaveBeenLastCalledWith(`https://api-data.line.me/v2/bot/message/content-${kind}/content`, expect.objectContaining({ redirect: "manual" }));
  });
  it("denies unauthorized owners and external content providers", async () => {
    await webhook("image", "stranger");
    await webhook("video", "test-owner", "external");
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });
  it("requires the agent credential, current lease and active job", async () => {
    await webhook("image");
    const job = await claim();
    network.mockClear();
    expect((await content(job.id, job.leaseToken, "invalid")).status).toBe(401);
    expect((await content(job.id, "wrong")).status).toBe(409);
    db.prepare("UPDATE jobs SET status = 'COMPLETED' WHERE id = ?").run(job.id);
    expect((await content(job.id, job.leaseToken)).status).toBe(404);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([[202, 503], [429, 503], [500, 503], [404, 410], [410, 410]])("maps LINE status %i to %i", async (upstream, expected) => {
    await webhook("video");
    const job = await claim();
    network.mockResolvedValueOnce(new Response(null, { status: upstream }));
    expect((await content(job.id, job.leaseToken)).status).toBe(expected);
  });
});

async function sendEvents(events: unknown[]) {
  const body = JSON.stringify({ events });
  const response = await worker.fetch(new Request("https://worker.test/v1/line/webhook", { method: "POST", body,
    headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") } }), env);
  expect(response.status).toBe(200);
}
function event(id: string, message: unknown) {
  return { type: "message", webhookEventId: id, replyToken: id, source: { type: "user", userId: "test-owner" }, message };
}
async function transition(job: { id: string; leaseToken: string }, action: string, extra = {}, key = action + "-request") {
  const response = await worker.fetch(new Request(`https://worker.test/v1/agent/jobs/${job.id}/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": job.id + key },
    body: JSON.stringify({ leaseToken: job.leaseToken, ...extra })
  }), env);
  expect(response.status).toBe(200);
  return response.json();
}
const answer = { summary: "画像6枚を受け取りました。この画像をどうしましょうか？", artifacts: [], warnings: [], requested_actions: [] };

describe("conversation notification UX", () => {
  it("coalesces six out-of-order photos and following instruction, downloads all, and sends exactly one final message", async () => {
    const photos = [4, 1, 2, 3, 6, 5].map((index) => event(`photo-${index}`, {
      type: "image", id: `photo-${index}`, contentProvider: { type: "line" }, imageSet: { id: "six", index, total: 6 }
    }));
    await Promise.all(photos.map((photo) => sendEvents([photo])));
    await sendEvents([event("instruction", { type: "text", text: "この6枚を比較して" })]);
    await sendEvents(photos); // redelivery must not create another batch or notification
    expect(network).not.toHaveBeenCalled();
    const job = await claim() as unknown as { id: string; leaseToken: string; prompt: string; attachments: { jobId: string; media: { groupIndex: number } }[] };
    expect(job.prompt).toBe("この6枚を比較して");
    expect(job.attachments.map((item) => item.media.groupIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await claim()).toBeNull(); // an active conversation cannot be double claimed
    await transition(job, "start");
    await transition(job, "notification", { notification: { mode: "inherit", scope: "turn" } });
    expect(network).not.toHaveBeenCalled();
    await transition(job, "progress", { progress: "添付6件を保存しました。" });
    expect(network).not.toHaveBeenCalled();
    for (const item of job.attachments) expect((await content(item.jobId, job.leaseToken)).status).toBe(200);
    network.mockClear();
    await transition(job, "complete", { result: answer });
    await transition(job, "complete", { result: answer });
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(network.mock.calls[0]![1].body).messages[0].text).toBe(answer.summary);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='COMPLETED'").get()?.n).toBe(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE notification_status='SENT'").get()?.n).toBe(7);
  });

  it("waits for a settled burst and incomplete image set, but does not wait forever", async () => {
    await webhook("image");
    const rawClaim = () => worker.fetch(new Request("https://worker.test/v1/agent/jobs/claim", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "x-agent-version": "0.3.0" }
    }), env).then((response) => response.json()) as Promise<{ job: unknown }>;
    expect((await rawClaim()).job).toBeNull();
    db.prepare("UPDATE jobs SET created_at=?").run(new Date(Date.now() - 20_000).toISOString());
    expect((await rawClaim()).job).toBeNull();
    db.prepare("UPDATE jobs SET created_at=?").run(new Date(Date.now() - 61_000).toISOString());
    expect((await rawClaim()).job).not.toBeNull();
  });

  it("persists detailed preference, supports a quiet one-off override, then switches off permanently", async () => {
    for (const [index, mode, scope, expectedNotifications, expectedPreference] of [
      [0, "detailed", "conversation", 2, "detailed"],
      [1, "quiet", "turn", 1, "detailed"],
      [2, "inherit", "turn", 2, "detailed"],
      [3, "quiet", "conversation", 1, "quiet"],
      [4, "inherit", "turn", 1, "quiet"]
    ] as const) {
      await sendEvents([event(`mode-${index}`, { type: "text", text: "test" })]);
      const job = await claim();
      network.mockClear();
      await transition(job, "start");
      await transition(job, "notification", { notification: { mode, scope } });
      await transition(job, "notification", { notification: { mode, scope } });
      await transition(job, "complete", { result: answer });
      expect(network).toHaveBeenCalledTimes(expectedNotifications);
      expect(db.prepare("SELECT notification_mode FROM conversation_preferences").get()?.notification_mode).toBe(expectedPreference);
    }
  });

  it("a detailed one-off does not enable logs for the next request", async () => {
    await sendEvents([event("once", { type: "text", text: "今回は詳細ログも出して" })]);
    const job = await claim();
    await transition(job, "start");
    await transition(job, "notification", { notification: { mode: "detailed", scope: "turn" } });
    await transition(job, "complete", { result: answer });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_preferences").get()?.n).toBe(0);
    network.mockClear();
    await sendEvents([event("next", { type: "text", text: "次の依頼です" })]);
    const next = await claim();
    await transition(next, "start");
    await transition(next, "notification", { notification: { mode: "inherit", scope: "turn" } });
    await transition(next, "complete", { result: answer });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("cancels every member of an active image batch from any member's receipt", async () => {
    await sendEvents([1, 2].map((index) => event(`cancel-${index}`, { type: "image", id: `cancel-${index}`, contentProvider: { type: "line" } })));
    const job = await claim();
    await transition(job, "start");
    const member = db.prepare("SELECT id FROM jobs WHERE id != ?").get(job.id)!.id;
    await sendEvents([event("cancel-command", { type: "text", text: `キャンセル ${member}` })]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='CANCEL_REQUESTED'").get()?.n).toBe(2);
    expect(await transition(job, "heartbeat")).toMatchObject({ cancelRequested: true });
    await transition(job, "fail", { errorCode: "CODEX_CANCELLED" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='CANCELLED'").get()?.n).toBe(2);
  });
});

describe("mechanical work notices", () => {
  it.each(["analyze", "organize"])("sends one %s notice and one final result even with additions during work", async (activity) => {
    await sendEvents([1, 2, 3].map((index) => event(`notice-${index}`, { type: "image", id: `notice-${index}`, contentProvider: { type: "line" } })));
    const first = await claim();
    await transition(first, "start");
    await transition(first, "notification", { notification: { mode: "inherit", scope: "turn" }, suppressStart: true });
    await transition(first, "activity", { activity, imageCount: 3, videoCount: 0 });
    await transition(first, "activity", { activity, imageCount: 3, videoCount: 0 }, "another-attempt");
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(network.mock.calls[0]![1].body).messages[0].text).toBe(
      `画像3枚を受信しました。${activity === "analyze" ? "解析中です。" : "整理しています。"}\n追加があれば、回答を待たずに送信してください。`);
    await sendEvents([event("addition", { type: "image", id: "addition", contentProvider: { type: "line" } })]);
    expect(await transition(first, "complete", { result: { ...answer, summary: "最初の3枚の結果" } })).toMatchObject({ deferred: true });
    expect(network).toHaveBeenCalledTimes(1);
    const next = await claim();
    expect(next).toMatchObject({ continuation: true, previousResults: ["最初の3枚の結果"] });
    await transition(next, "start");
    await transition(next, "notification", { notification: { mode: "inherit", scope: "turn" }, suppressStart: true });
    await transition(next, "activity", { activity, imageCount: 1, videoCount: 0 });
    expect(network).toHaveBeenCalledTimes(1);
    await transition(next, "complete", { result: { ...answer, summary: "4枚をまとめた結果" } });
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(network.mock.calls[1]![1].body).messages[0].text).toBe("4枚をまとめた結果");
  });
});

it("keeps same-timestamp text in enqueue order rather than random receipt ID order", async () => {
  await sendEvents([event("ordered-1", { type: "text", text: "先にこの依頼" }), event("ordered-2", { type: "text", text: "続いて補足" })]);
  db.exec("UPDATE jobs SET id = CASE webhook_event_id WHEN 'ordered-1' THEN 'JZZZ' ELSE 'JAAA' END");
  const job = await claim() as unknown as { prompt: string };
  expect(job.prompt).toBe("先にこの依頼\n\n続いて補足");
});

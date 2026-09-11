import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("sends one work notice and one final reply for six attachments in the actual Workers runtime", async () => {
  const bundle = await build({ entryPoints: ["apps/worker/src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
  const secret = "test-secret";
  const token = "test-agent";
  const outbound: string[] = [];
  const messages: string[] = [];
  const bytes = new Uint8Array([255, 216, 255, 0]);
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01",
    d1Databases: ["DB"],
    bindings: { LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "test-line",
      AGENT_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"), DEFAULT_WORKSPACE_KEY: "linebot" },
    outboundService: async (request) => {
      outbound.push(request.url);
      if (new URL(request.url).hostname === "api-data.line.me") return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
      messages.push(await request.text());
      return new Response("{}");
    }
  }));
  try {
    const db = await runtime.getD1Database("DB");
    for (const migration of ["0001_initial.sql", "0002_media.sql", "0003_conversation_ux.sql", "0004_work_notices.sql"]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((item) => item.trim())) await db.prepare(statement).run();
      if (migration === "0001_initial.sql") {
        await db.prepare("INSERT INTO jobs(id, webhook_event_id, user_id, conversation_key, workspace_key, prompt, status, created_at, updated_at) VALUES ('JLEGACY','legacy','legacy-owner','legacy-owner','linebot','retained prompt','CANCELLED','2020-01-01','2020-01-01')").run();
      }
    }
    expect((await db.prepare("SELECT prompt FROM jobs WHERE id = 'JLEGACY'").first())?.prompt).toBe("retained prompt");
    expect((await db.prepare("SELECT MAX(version) AS version FROM schema_versions").first())?.version).toBe(4);
    const outdated = await runtime.dispatchFetch("http://worker.test/v1/agent/jobs/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-agent-version": "0.1.0" } });
    expect(outdated.status).toBe(426);
    await db.prepare("INSERT INTO owners VALUES ('owner', '2026-09-08', 1)").run();
    const body = JSON.stringify({ events: [4, 1, 6, 2, 5, 3].map((index) => ({ type: "message", webhookEventId: `runtime-image-${index}`, replyToken: "reply", source: { type: "user", userId: "owner" }, message: { type: "image", id: `123${index}`, contentProvider: { type: "line" }, imageSet: { id: "six", index, total: 6 } } })) });
    const accepted = await runtime.dispatchFetch("http://worker.test/v1/line/webhook", { method: "POST", body,
      headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") } });
    expect(accepted.status).toBe(200);
    await db.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00.000Z'").run();
    const claimed = await runtime.dispatchFetch("http://worker.test/v1/agent/jobs/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-agent-version": "0.3.0" } });
    const { job } = await claimed.json() as { job: { id: string; leaseToken: string; attachments: { jobId: string; media: { groupIndex: number } }[] } };
    const response = await runtime.dispatchFetch(`http://worker.test/v1/agent/jobs/${job.attachments[0]!.jobId}/media`, { headers: {
      authorization: `Bearer ${token}`, "x-job-lease": job.leaseToken
    } });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(outbound).toContain("https://api-data.line.me/v2/bot/message/1231/content");
    expect(job.attachments.map((item) => item.media.groupIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(messages).toHaveLength(0);
    for (const [action, extra] of [
      ["start", {}], ["notification", { notification: { mode: "inherit", scope: "turn" }, suppressStart: true }],
      ["activity", { activity: "analyze", imageCount: 6, videoCount: 0 }],
      ["complete", { result: { summary: "6枚を受け取りました。どうしましょうか？" } }]
    ] as const) {
      const changed = await runtime.dispatchFetch(`http://worker.test/v1/agent/jobs/${job.id}/${action}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `runtime-${action}` },
        body: JSON.stringify({ leaseToken: job.leaseToken, ...extra })
      });
      expect(changed.status).toBe(200);
    }
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0]!).messages[0].text).toContain("画像6枚を受信しました。解析中です。");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'COMPLETED'").first())?.n).toBe(6);

  } finally { await runtime.dispose(); }
}, 30_000);

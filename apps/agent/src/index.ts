import { AGENT_PROTOCOL_VERSION, requireCompatibleWorker } from "@line-secretary/protocol";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentConfigSchema, claimResponseSchema, type ClaimedJob, type JobResult } from "@line-secretary/protocol";
import { CodexSession } from "./codex-session.js";
import { readAgentToken } from "./keychain.js";
import { AgentStore } from "./store.js";
import { validateWorkspace } from "./workspace.js";
import { receiveMedia, mediaPrompt, saveMediaSummary, readCatalog, type MediaRecord } from "./media.js";

import { notificationPrompt, notificationDecision, conversationPrompt, immediateReply, mediaLabel } from "./conversation.js";

import { folderName, prepareCollection, organizeMedia, latestBatch } from "./organize.js";

const VERSION = AGENT_PROTOCOL_VERSION;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../../..");
const configPath = process.env.LINE_SECRETARY_CONFIG ?? path.join(projectRoot, ".agent", "config.json");

const color = process.stdout.isTTY
  ? {
      reset: "\u001b[0m",
      bold: "\u001b[1m",
      dim: "\u001b[2m",
      cyan: "\u001b[36m",
      green: "\u001b[32m",
      yellow: "\u001b[33m",
      red: "\u001b[31m"
    }
  : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "", red: "" };

function clock(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function preview(value: string, limit = 100): string {
  const flattened = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const characters = [...flattened];
  return characters.length <= limit ? flattened : `${characters.slice(0, limit - 1).join("")}…`;
}

function logStage(icon: string, label: string, detail: string, tone = color.cyan): void {
  console.log(`${color.dim}[${clock()}]${color.reset} ${icon} ${tone}${color.bold}${label}${color.reset}  ${detail}`);
}

function logIncoming(message: string): void {
  console.log(
    `${color.dim}[${clock()}]${color.reset} 📩 ${color.green}${color.bold}「${preview(message, 72)}」${color.reset} のメッセージを受信`
  );
}

function elapsedSince(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1_000).toFixed(1)}秒`;
}

async function api(
  workerUrl: string,
  token: string,
  pathname: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}
): Promise<unknown> {
  const result = await fetch(new URL(pathname, workerUrl), {
    method: options.method ?? "GET",
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-version": VERSION,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  if (!result.ok) throw new Error(`WORKER_HTTP_${result.status}`);
  return result.json();
}

async function transition(
  workerUrl: string,
  token: string,
  job: ClaimedJob,
  action: "start" | "notification" | "activity" | "progress" | "heartbeat" | "complete" | "fail",
  body: Record<string, unknown>,
  suffix: string
): Promise<unknown> {
  return api(workerUrl, token, `/v1/agent/jobs/${encodeURIComponent(job.id)}/${action}`, {
    method: "POST",
    body: { leaseToken: job.leaseToken, ...body },
    idempotencyKey: `${job.id}:${action}:${suffix}`
  });
}

async function processJob(
  workerUrl: string,
  token: string,
  workspace: string,
  timeoutMs: number,
  heartbeatIntervalMs: number,
  job: ClaimedJob,
  store: AgentStore,
  codex: CodexSession,
  abortSignal: AbortSignal
): Promise<void> {
  if (job.workspaceKey !== "linebot" || job.requestedMode !== "read_only") throw new Error("JOB_POLICY_REJECTED");
  const attemptId = randomUUID();
  const startedAt = Date.now();
  store.save(job.id, "LEASED");

  console.log("");
  logIncoming(job.prompt);
  logStage("🧾", "受付番号", job.id);

  let heartbeatCounter = 0;
  let cancelRequested = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const cancellation = new AbortController();
  const jobSignal = AbortSignal.any([abortSignal, cancellation.signal]);

  try {
    const opened = await codex.openThread(store.threadFor(job.conversationId));
    store.saveThread(job.conversationId, opened.threadId);
    await transition(workerUrl, token, job, "start", { threadId: opened.threadId }, attemptId);
    store.save(job.id, "RUNNING", opened.threadId);
    logStage("🔗", "Codex接続", opened.resumed ? "前のLINE会話を引き継ぎました" : "新しい会話を開始しました");
    logStage("🧠", "Codex処理中", "回答を作っています…", color.yellow);

    heartbeat = setInterval(() => {
      heartbeatCounter += 1;
      void transition(workerUrl, token, job, "heartbeat", {}, `${attemptId}:${heartbeatCounter}`)
        .then((value) => {
          const response = value as { cancelRequested?: boolean };
          if (response.cancelRequested) {
            cancelRequested = true;
            cancellation.abort();
          }
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs);

    const catalog = await readCatalog(workspace, job.conversationId);
    const routingStartedAt = Date.now();
    const routing = await codex.runTurn(opened.threadId, notificationPrompt(job) + `\n保存済みの直近の整理先（参照データ）: ${JSON.stringify([...catalog].reverse().find((record) => record.collection)?.collection ?? null)}\n同じ作業中の追加受信: ${Boolean(job.continuation)}`, timeoutMs, jobSignal);
    let quickReply = immediateReply(routing.result);
    const action = routing.result.execution;
    const collection = folderName(routing.result.folder);
    if (action === "organize" && !collection) quickReply = { summary: "整理するフォルダ名を指定してください。", artifacts: [], warnings: [], requested_actions: [] };
    logStage("🧭", "会話判定", `${quickReply ? "確認の返信を確定" : "作業へ進みます"} (${elapsedSince(routingStartedAt)})`);
    await transition(workerUrl, token, job, "notification", {
      notification: notificationDecision(routing.result),
      suppressStart: Boolean(job.attachments?.length || job.media) || action === "organize"
    }, attemptId);
    const attachments = job.attachments ?? (job.media ? [{ jobId: job.id, media: job.media }] : []);
    const records: MediaRecord[] = [];
    for (const attachment of attachments) {
      const record = await receiveMedia(workspace, { ...job, id: attachment.jobId, media: attachment.media }, workerUrl, token, jobSignal);
      records.push(record);
      logStage("📁", "保存済み", record.original, color.green);
    }
    if (cancelRequested) throw new Error("CODEX_CANCELLED");
    let run: { result: JobResult; threadId: string };
    const plainResult = (summary: string): JobResult => ({ summary, notification: null, execution: null, folder: null, artifacts: [], warnings: [], requested_actions: [] });
    const activity = async (kind: "analyze" | "organize", items: MediaRecord[]) => {
      if (!items.length) return;
      await transition(workerUrl, token, job, "activity", {
        activity: kind, imageCount: items.filter((item) => item.kind === "image").length,
        videoCount: items.filter((item) => item.kind === "video").length
      }, attemptId);
      await transition(workerUrl, token, job, "progress", { progress: `${mediaLabel(items)}の元ファイルはPCに保存済みです。` }, attemptId);
    };
    if (action === "ask" && records.length) {
      run = { result: plainResult(`${mediaLabel(records)}を受信しました。この${records.every((record) => record.kind === "image") ? "画像" : "ファイル"}をどうしましょうか？`), threadId: opened.threadId };
    } else if (quickReply) {
      run = { result: quickReply, threadId: opened.threadId };
    } else if (action === "organize" && collection) {
      const items = records.length ? records : latestBatch(catalog);
      if (!items.length) {
        run = { result: plainResult("整理する画像・動画を送信してください。"), threadId: opened.threadId };
      } else {
        await prepareCollection(workspace, job.conversationId, collection);
        await activity("organize", items);
        await organizeMedia(workspace, job.conversationId, collection, items, jobSignal);
        const summary = `${mediaLabel(items)}を「${collection}」フォルダに整理しました。`;
        run = { result: plainResult([...(job.previousResults ?? []), summary].join("\n")), threadId: opened.threadId };
      }
    } else {
      await activity("analyze", records);
      const context = await mediaPrompt(workspace, job);
      const prompt = conversationPrompt(job, context + (records.length
        ? `\n\n今回保存した添付（${records.length}件。添付プレビューはこの順序。動画は代表フレームのみで音声は未確認）：\n${JSON.stringify(records)}` : "")
        + (job.continuation ? `\n同じ作業中に追加で届いた入力です。前の結果も踏まえてまとめて回答してください。未送信の前の結果（参照データ）: ${JSON.stringify(job.previousResults ?? [])}` : ""));
      const analysisStartedAt = Date.now();
      run = await codex.runTurn(opened.threadId, prompt, timeoutMs, jobSignal, records.flatMap((record) => record.images));
      logStage("🧠", "回答作成完了", elapsedSince(analysisStartedAt));
    }
    for (const record of records) await saveMediaSummary(workspace, { ...job, id: record.jobId }, record, run.result);
    if (cancelRequested) throw new Error("CANCEL_REQUESTED");
    store.save(job.id, "COMPLETING", run.threadId);
    const completion = await transition(workerUrl, token, job, "complete", { result: run.result satisfies JobResult, threadId: run.threadId }, attemptId);
    store.save(job.id, "COMPLETED", run.threadId, JSON.stringify(run.result));
    logStage("✅", (completion as { deferred?: boolean }).deferred ? "追加待ち・結果保存" : (completion as { notificationDelivered?: boolean }).notificationDelivered === true ? "LINE返信" : "結果保存・LINE配信未確認", `「${preview(run.result.summary, 140)}」  ${color.dim}(${elapsedSince(startedAt)})${color.reset}`, color.green);
    logStage("⌛", "待機中", "次のLINEメッセージを待っています");
  } catch (cause) {
    const code = cause instanceof Error && /^MEDIA_[A-Z_]+$/.test(cause.message)
      ? cause.message
      : cause instanceof Error && cause.message === "CODEX_TIMEOUT"
      ? "CODEX_TIMEOUT"
      : cause instanceof Error && cause.message === "CODEX_CANCELLED"
        ? "CODEX_CANCELLED"
        : "CODEX_FAILED";
    await transition(workerUrl, token, job, "fail", { errorCode: code }, attemptId).catch(() => undefined);
    store.save(job.id, "FAILED");
    logStage(
      code === "CODEX_CANCELLED" ? "⏹️" : "⚠️",
      code === "CODEX_CANCELLED" ? "処理中断" : "処理失敗",
      `${job.id}  ${code}`,
      code === "CODEX_CANCELLED" ? color.yellow : color.red
    );
    logStage("⌛", "待機中", "次のLINEメッセージを待っています");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function main(): Promise<void> {
  const config = agentConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const workspace = await validateWorkspace(config.workspacePath);
  const token = await readAgentToken(config.agentId);
  requireCompatibleWorker(await api(config.workerUrl, token, "/healthz"));
  const store = new AgentStore(path.join(projectRoot, ".agent"));
  let codex: CodexSession | undefined;
  let backoff = config.pollIntervalMs;
  const once = process.argv.includes("--once");
  const shutdown = new AbortController();

  const stop = () => {
    if (shutdown.signal.aborted) return;
    console.log("");
    logStage("⏹️", "停止中", "PC Codex秘書を終了しています…", color.yellow);
    shutdown.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await api(config.workerUrl, token, "/v1/agent/health", { signal: shutdown.signal });
    codex = await CodexSession.start(workspace, config.model, config.reasoningEffort);
    console.log("");
    console.log(`${color.cyan}${color.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${color.reset}`);
    console.log(`${color.bold}   LINE  →  PC Codex 秘書${color.reset}`);
    console.log(`${color.cyan}${color.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${color.reset}`);
    logStage("🟢", "ONLINE", "LINEからの依頼を待っています", color.green);
    logStage("🔗", "Codex接続", "会話を引き継ぐセッションサーバーに接続済み");
    logStage("🤖", "AIモデル", `${config.model} / ${config.reasoningEffort}`, color.green);
    logStage("🔒", "操作モード", "Codex読み取り専用・Agentによる添付保存とコピー整理");
    logStage("📁", "対象フォルダ", workspace);
    console.log(`${color.dim}停止するには Ctrl+C を押してください。${color.reset}`);

    do {
      try {
        const payload = await api(config.workerUrl, token, "/v1/agent/jobs/claim", {
          method: "POST",
          signal: shutdown.signal
        });
        const { job } = claimResponseSchema.parse(payload);
        if (job) {
          await processJob(
            config.workerUrl,
            token,
            workspace,
            config.timeoutMs,
            config.heartbeatIntervalMs,
            job,
            store,
            codex,
            shutdown.signal
          );
        }
        backoff = config.pollIntervalMs;
      } catch {
        if (shutdown.signal.aborted) break;
        backoff = Math.min(backoff * 2, 60_000);
      }
      if (!once) await wait(backoff, shutdown.signal);
    } while (!once && !shutdown.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (codex) await codex.close();
    store.close();
  }

  logStage(
    once ? "✅" : "⚫",
    once ? "接続確認完了" : "OFFLINE",
    once ? "PC Codex秘書の接続を確認しました" : "PC Codex秘書を停止しました",
    once ? color.green : color.dim
  );
}

await main();

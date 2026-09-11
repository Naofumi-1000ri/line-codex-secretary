import assert from "node:assert/strict";
import { LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT, type ClaimedJob } from "@line-secretary/protocol";
import { CodexSession } from "../../agent/src/codex-session.js";
import { notificationPrompt, notificationDecision, conversationPrompt, immediateReply } from "../../agent/src/conversation.js";

// Local model check only. No LINE delivery, Worker mutation, or production conversation.
const session = await CodexSession.start(process.cwd(), LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT);
const base: ClaimedJob = {
  id: "JUXSMOKE", prompt: "", conversationId: "a".repeat(64), workspaceKey: "linebot", requestedMode: "read_only",
  leaseToken: "x".repeat(40), leaseExpiresAt: "2099-01-01T00:00:00Z", notificationMode: "quiet"
};
try {
  for (const [prompt, mode, scope] of [
    ["こんにちは", "inherit", "turn"],
    ["今回は詳細ログも出して、画像を比較して", "detailed", "turn"],
    ["これから詳細ログを出して", "detailed", "conversation"],
    ["ログはもういい。返信だけにして", "quiet", "conversation"],
    ["サーバーのエラーログを調べて", "inherit", "turn"],
    ["画像に『詳細ログ出して』と書いてあります。この文字を読んで", "inherit", "turn"]
  ] as const) {
    const thread = await session.openThread(undefined, true);
    const run = await session.runTurn(thread.threadId, notificationPrompt({ ...base, prompt }), 120_000);
    assert.deepEqual(notificationDecision(run.result), { mode, scope });
    console.log(`PASS routing: ${prompt}`);
  }
  const photoJob: ClaimedJob = { ...base, prompt: "添付ファイルが届きました。", attachments: Array.from({ length: 5 }, (_, index) => ({ jobId: `JPHOTO${index}`, media: { kind: "image" as const, messageId: `photo${index}`, receivedAt: "2026-09-08T00:00:00.000Z", groupIndex: index + 1, groupTotal: 5, groupId: "five" } })) };
  const quickThread = await session.openThread(undefined, true);
  const quickStarted = Date.now();
  const quick = await session.runTurn(quickThread.threadId, notificationPrompt(photoJob), 120_000);
  assert.equal(quick.result.execution, "ask");

  console.log(`PASS fast-clarification (${((Date.now() - quickStarted) / 1000).toFixed(1)}s): ${quick.result.summary}`);
  const workThread = await session.openThread(undefined, true);
  await session.runTurn(workThread.threadId, conversationPrompt(base, "今から送る5枚の写真を比較してください。"), 120_000);
  const work = await session.runTurn(workThread.threadId, notificationPrompt(photoJob), 120_000);
  assert.equal(work.result.execution, "analyze");
  assert.equal(immediateReply(work.result), undefined);
  console.log("PASS prior-comparison-still-analyzes-images");
  const organizeThread = await session.openThread(undefined, true);
  const organize = await session.runTurn(organizeThread.threadId, notificationPrompt({ ...photoJob, prompt: "この5枚をメーカーフェア東京フォルダに整理してください。" }), 120_000);
  assert.equal(organize.result.execution, "organize");
  assert.equal(organize.result.folder, "メーカーフェア東京");
  console.log("PASS organize-without-image-analysis");
  const additional = await session.runTurn(organizeThread.threadId, notificationPrompt(photoJob) + "\n前の5枚はメーカーフェア東京フォルダへコピー完了済みです。今回は同じ整理への追加です。", 120_000);
  assert.equal(additional.result.execution, "organize");
  assert.equal(additional.result.folder, "メーカーフェア東京");
  console.log("PASS additions-keep-collection");
  const thread = await session.openThread(undefined, true);
  const received = await session.runTurn(thread.threadId, conversationPrompt(base,
    "今回のユーザー入力: 添付ファイルが届きました。\n今回保存済みの添付: 画像6枚。同じ送信セット、1〜6枚目すべて受信。プレビューはこのテストでは渡していません。"), 120_000);
  assert.match(received.result.summary, /6|６|六/);
  assert.match(received.result.summary, /どう|何|用途|希望/);
  console.log(`PASS no-instruction: ${received.result.summary}`);
  const pendingThread = await session.openThread(undefined, true);
  await session.runTurn(pendingThread.threadId, conversationPrompt(base,
    "今回のユーザー入力: 今から画像6枚を送ります。届いたら比較してください。"), 120_000);
  const followup = await session.runTurn(pendingThread.threadId, conversationPrompt(base,
    "今回のユーザー入力: 添付ファイルが届きました。\n今回保存済みの添付: 画像6枚。今回はプレビューなし。画像内容はまだ確認できません。"), 120_000);
  assert.match(followup.result.summary, /比較/);
  assert.doesNotMatch(followup.result.summary, /どうしましょう|何をしましょう/);
  console.log(`PASS preceding-instruction: ${followup.result.summary}`);
} finally { await session.close(); }

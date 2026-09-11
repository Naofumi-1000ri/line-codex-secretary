import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT } from "@line-secretary/protocol";
import { CodexSession } from "../../agent/src/codex-session.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "line-media-smoke-"));
const file = path.join(directory, "sample.png");
let codex: CodexSession | undefined;
try {
  await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x160:d=1", "-f", "lavfi", "-i", "color=blue:s=160x160:d=1", "-filter_complex", "hstack", "-frames:v", "1", file]);
  codex = await CodexSession.start(path.resolve("."), LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT);
  const thread = await codex.openThread(undefined, true);
  const result = await codex.runTurn(thread.threadId,
    "添付画像を見て、左右それぞれの色を日本語の漢字1字で答えてください。summaryは『左=色,右=色』の形式で、色を実際に見える色に置き換えてください。画像以外のファイルやコマンドは使わないでください。他の配列は空にしてください。",
    180_000, undefined, [file]);
  if (result.result.summary !== "左=赤,右=青") throw new Error(`IMAGE_SMOKE_UNEXPECTED_RESULT: ${result.result.summary}`);
  console.log(JSON.stringify({ ok: true, summary: result.result.summary, model: LINE_SECRETARY_MODEL }));
} finally {
  await codex?.close();
  await rm(directory, { recursive: true, force: true });
}

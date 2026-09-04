import path from "node:path";
import { LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT } from "@line-secretary/protocol";
import { CodexSession } from "../../agent/src/codex-session.js";

const workspace = path.resolve(".");
const codex = await CodexSession.start(workspace, LINE_SECRETARY_MODEL, LINE_SECRETARY_REASONING_EFFORT);
let run;
try {
  const thread = await codex.openThread(undefined, true);
  run = await codex.runTurn(
    thread.threadId,
    [
      "This is a read-only setup smoke test.",
      "Read package.json in the current workspace.",
      "Set summary to exactly: workspace-read-ok: line-codex-secretary",
      "Return empty arrays for artifacts, requested_actions, and warnings.",
      "Do not modify any file."
    ].join("\n"),
    180_000
  );
} finally {
  await codex.close();
}

if (run.result.summary !== "workspace-read-ok: line-codex-secretary") {
  throw new Error("CODEX_SMOKE_UNEXPECTED_RESULT");
}
console.log(JSON.stringify({
  ok: true,
  summary: run.result.summary,
  threadCreated: Boolean(run.threadId),
  model: LINE_SECRETARY_MODEL,
  reasoningEffort: LINE_SECRETARY_REASONING_EFFORT
}));

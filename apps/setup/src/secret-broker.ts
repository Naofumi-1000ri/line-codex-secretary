import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { saveAgentToken } from "../../agent/src/keychain.js";

import { hiddenPrompt } from "./hidden-prompt.js";

const projectRoot = path.resolve(".");
const wranglerPath = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerConfig = path.resolve(process.env.LINE_SECRETARY_WRANGLER_CONFIG ?? "apps/worker/wrangler.jsonc");
const agentId = process.env.LINE_SECRETARY_AGENT_ID ?? "linebot-mac";

function nativeHiddenPrompt(message: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("TTY_REQUIRED: run worker:secrets in an interactive terminal");
  return new Promise((resolve, reject) => {
    const script = [
      'set response to display dialog "' + message.replaceAll('"', '\\"') + '"',
      'default answer "" with hidden answer',
      'buttons {"キャンセル", "登録"} default button "登録" cancel button "キャンセル"',
      'with title "LINE秘書の安全な入力"',
      'return text returned of response'
    ].join(" ");
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let value = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (value += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(value.replace(/[\r\n]+$/, ""));
      else reject(new Error("NATIVE_PROMPT_CANCELLED"));
    });
  });
}

function putSecret(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerPath, "secret", "put", name, "--config", wranglerConfig], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`WRANGLER_SECRET_FAILED:${name}`));
    });
    child.stdin.on("error", () => reject(new Error("WRANGLER_SECRET_FAILED")));
    child.stdin.end(`${value}\n`);
  });
}

function readClipboard(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbpaste", [], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let value = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (value += chunk));
    child.stderr.on("data", (chunk: string) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(value.replace(/[\r\n]+$/, ""));
      else reject(new Error(`CLIPBOARD_READ_FAILED:${error.slice(-200)}`));
    });
  });
}

function clearClipboard(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CLIPBOARD_CLEAR_FAILED:${error.slice(-200)}`));
    });
    child.stdin.end();
  });
}

const mode = process.argv[2] ?? "all";
const useClipboard = process.argv.includes("--clipboard");
if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("SECRET_BROKER_OS_UNSUPPORTED");
if (useClipboard && process.platform !== "darwin") throw new Error("CLIPBOARD_MACOS_ONLY: use the hidden interactive terminal prompt on Windows");
const prompt = process.stdin.isTTY && process.stdout.isTTY ? hiddenPrompt : nativeHiddenPrompt;

async function receiveSecret(message: string): Promise<string> {
  if (!useClipboard) return prompt(message);
  const value = await readClipboard();
  if (!value) throw new Error("CLIPBOARD_EMPTY");
  return value;
}

if (mode === "channel-secret" || mode === "all") {
  try {
    const channelSecret = await receiveSecret("LINEの合言葉を貼り付けて登録してください（入力内容は表示されません）");
    if (channelSecret.length < 16) throw new Error("LINE_CHANNEL_SECRET_INVALID");
    await putSecret("LINE_CHANNEL_SECRET", channelSecret);
    console.log("LINEの合言葉を安全に登録しました。値は保存・表示していません。");
  } finally {
    if (useClipboard) await clearClipboard();
  }
}

if (mode === "access-token" || mode === "all") {
  try {
    const accessToken = await receiveSecret("LINEへ返事を送る鍵を貼り付けて登録してください（入力内容は表示されません）");
    if (accessToken.length < 40) throw new Error("LINE_CHANNEL_ACCESS_TOKEN_INVALID");
    await putSecret("LINE_CHANNEL_ACCESS_TOKEN", accessToken);
    console.log("LINEへ返事を送る鍵を安全に登録しました。値は保存・表示していません。");
  } finally {
    if (useClipboard) await clearClipboard();
  }
}

if (mode === "agent-token" || mode === "all") {
  const agentToken = randomBytes(32).toString("base64url");
  const agentTokenHash = createHash("sha256").update(agentToken).digest("hex");
  await putSecret("AGENT_TOKEN_SHA256", agentTokenHash);
  await saveAgentToken(agentId, agentToken);
  console.log("PC Codex秘書の鍵を安全に登録しました。値はOSの鍵ストア（macOS Keychain / Windows DPAPI）に保存しています。");
}

if (!new Set(["channel-secret", "access-token", "agent-token", "all"]).has(mode)) {
  throw new Error("UNKNOWN_SECRET_BROKER_MODE");
}

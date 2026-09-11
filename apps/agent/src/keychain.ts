import { spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const KEYCHAIN_SERVICE = "jp.1000ri.line-codex-secretary.agent";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tokenStore = path.join(projectRoot, "apps/agent/native/token-store.ps1");
const keychainWriter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/keychain-store.swift");

function collect(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.on("error", () => reject(new Error("TOKEN_STORE_FAILED")));
    child.stdin.on("error", () => reject(new Error("TOKEN_STORE_FAILED")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error("TOKEN_STORE_FAILED"));
    });
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

export function windowsTokenPath(agentId: string, directory = path.join(projectRoot, ".agent/credentials")): string {
  return path.join(directory, `${createHash("sha256").update(agentId).digest("hex")}.dpapi`);
}

function windowsToken(operation: "read" | "save", agentId: string, token?: string, directory?: string): Promise<string> {
  return collect("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", tokenStore],
    JSON.stringify({ operation, path: windowsTokenPath(agentId, directory), token }));
}

function supportedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("TOKEN_STORE_OS_UNSUPPORTED");
}

export function readAgentToken(agentId: string, directory?: string): Promise<string> {
  supportedPlatform();
  if (process.platform === "win32") return windowsToken("read", agentId, undefined, directory);
  return collect("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", agentId, "-w"]);
}

export function saveAgentToken(agentId: string, token: string, directory?: string): Promise<string> {
  supportedPlatform();
  if (process.platform === "win32") return windowsToken("save", agentId, token, directory);
  return collect("/usr/bin/xcrun", ["swift", keychainWriter, KEYCHAIN_SERVICE, agentId], token);
}

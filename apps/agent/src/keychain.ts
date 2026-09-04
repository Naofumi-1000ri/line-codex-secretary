import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEYCHAIN_SERVICE = "jp.1000ri.line-codex-secretary.agent";
const keychainWriter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/keychain-store.swift");

function collect(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`KEYCHAIN_COMMAND_FAILED:${stderr.trim().slice(0, 120)}`));
    });
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

export function readAgentToken(agentId: string): Promise<string> {
  return collect("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", agentId, "-w"]);
}

export function saveAgentToken(agentId: string, token: string): Promise<string> {
  return collect("/usr/bin/xcrun", ["swift", keychainWriter, KEYCHAIN_SERVICE, agentId], token);
}

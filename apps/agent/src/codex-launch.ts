import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function safeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "CODEX_HOME", "LANG", "LC_ALL",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC"
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => allowed.has(name.toUpperCase()) && value !== undefined));
}

// Launch the native binary directly: .cmd cannot be spawned with shell:false,
// and terminating a Node wrapper on Windows can leave its native child running.
export function codexExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): string {
  if (env.LINE_SECRETARY_CODEX_EXE) {
    const executable = env.LINE_SECRETARY_CODEX_EXE;
    if (!path.isAbsolute(executable) || (platform === "win32" && !executable.toLowerCase().endsWith(".exe")) || !existsSync(executable)) {
      throw new Error("CODEX_EXECUTABLE_INVALID");
    }
    return executable;
  }
  if (platform !== "win32") return "codex";
  if (arch !== "x64" && arch !== "arm64") throw new Error("CODEX_ARCH_UNSUPPORTED");
  const searchPath = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  for (const rawDirectory of searchPath.split(";")) {
    const directory = rawDirectory.replace(/^"|"$/g, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    const native = path.join(directory, "codex.exe");
    if (existsSync(native)) return native;
    const entry = path.join(directory, "node_modules/@openai/codex/bin/codex.js");
    if (!existsSync(entry)) continue;
    const target = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    let vendor = path.resolve(entry, "../../vendor");
    try {
      vendor = path.join(path.dirname(createRequire(entry).resolve(`@openai/codex-win32-${arch}/package.json`)), "vendor");
    } catch { /* Older npm distributions bundle vendor beside bin. */ }
    const binary = path.join(vendor, target, "bin/codex.exe");
    if (existsSync(binary)) return binary;
  }
  throw new Error("CODEX_EXECUTABLE_NOT_FOUND: install npm Codex or set LINE_SECRETARY_CODEX_EXE to an absolute codex.exe path");
}

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { codexExecutable, safeEnvironment } from "./codex-launch.js";
import { CodexSession } from "./codex-session.js";

it("keeps Windows environment casing and excludes unrelated secrets", () => {
  expect(safeEnvironment({ Path: "bin", SystemRoot: "system", USERPROFILE: "user", TEMP: "temp", CODEX_HOME: "codex", TOKEN: "secret", OPENAI_API_KEY: "secret" }))
    .toEqual({ Path: "bin", SystemRoot: "system", USERPROFILE: "user", TEMP: "temp", CODEX_HOME: "codex" });
});

it("preserves the macOS command", () => {
  expect(codexExecutable({}, "darwin")).toBe("codex");
});

it("resolves native and npm Windows executables in paths with spaces without a shell", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex path ")));
  try {
    const pkg = path.join(root, "node_modules/@openai/codex");
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    await writeFile(path.join(pkg, "bin/codex.js"), "");
    const binary = path.join(root, "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(path.join(root, "node_modules/@openai/codex-win32-x64/package.json"), '{"name":"@openai/codex-win32-x64"}');
    await writeFile(binary, "");
    expect(codexExecutable({ Path: root }, "win32", "x64")).toBe(binary);
    const native = path.join(root, "codex.exe");
    await writeFile(native, "");
    expect(codexExecutable({ PATH: `"${root}"` }, "win32", "x64")).toBe(native);
    expect(() => codexExecutable({ LINE_SECRETARY_CODEX_EXE: path.join(root, "codex.cmd") }, "win32")).toThrow("CODEX_EXECUTABLE_INVALID");
    expect(() => codexExecutable({ PATH: "" }, "win32")).toThrow("CODEX_EXECUTABLE_NOT_FOUND");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.env.LINE_SECRETARY_TEST_CODEX !== "1")("initializes and closes the real pinned Codex app-server without login or a model call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex workspace 日本語 "));
  try {
    const session = await CodexSession.start(root, "gpt-5.6-luna", "max");
    await session.close();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

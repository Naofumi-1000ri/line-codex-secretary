import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { KEYCHAIN_SERVICE, readAgentToken, saveAgentToken } from "./keychain.js";

afterEach(() => { vi.restoreAllMocks(); mocks.spawn.mockReset(); });

function childResult(output: string, code = 0) {
  let input = "";
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", chunk => { input += chunk; });
    child.stdin.on("finish", () => {
      if (code === 0) child.stdout.write(output);
      else child.stderr.write(output);
      child.emit("close", code);
    });
    return child;
  });
  return () => input;
}

it("preserves macOS Keychain read and Swift write, keeping the token off argv", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  childResult("test-token\n");
  expect(await readAgentToken("test-agent")).toBe("test-token");
  expect(mocks.spawn).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "test-agent", "-w"], expect.objectContaining({ shell: false }));
  const input = childResult("");
  await saveAgentToken("test-agent", "private-test-token");
  expect(mocks.spawn).toHaveBeenLastCalledWith("/usr/bin/xcrun", ["swift", expect.stringContaining("keychain-store.swift"), KEYCHAIN_SERVICE, "test-agent"], expect.any(Object));
  expect(input()).toBe("private-test-token\n");
  expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain("private-test-token");
});

it("passes Windows token only as stdin JSON and suppresses helper stderr", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const input = childResult("sensitive-test-token", 1);
  await expect(saveAgentToken("test-agent", "sensitive-test-token")).rejects.toThrow(/^TOKEN_STORE_FAILED$/);
  expect(JSON.parse(input()).token).toBe("sensitive-test-token");
  expect(mocks.spawn).toHaveBeenCalledWith("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", expect.stringContaining("token-store.ps1")], expect.objectContaining({ shell: false, windowsHide: true }));
  expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain("sensitive-test-token");
});

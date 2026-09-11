import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), save: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../agent/src/keychain.js", () => ({ saveAgentToken: mocks.save }));
const originalArgv = process.argv;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(() => {
  process.argv = originalArgv;
  if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.save.mockReset();
});

it("launches Wrangler with Node and sends only the generated hash over stdin", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("LINE_SECRETARY_AGENT_ID", "test-windows");
  vi.stubEnv("LINE_SECRETARY_WRANGLER_CONFIG", "space dir/worker.jsonc");
  process.argv = ["node", "broker", "agent-token"];
  let input = "";
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", chunk => { input += chunk; });
    child.stdin.on("finish", () => child.emit("close", 0));
    return child;
  });
  await import("./secret-broker.js");
  expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [path.resolve("node_modules/wrangler/bin/wrangler.js"), "secret", "put", "AGENT_TOKEN_SHA256", "--config", path.resolve("space dir/worker.jsonc")], expect.objectContaining({ shell: false, windowsHide: true }));
  expect(input).toMatch(/^[a-f0-9]{64}\n$/);
  expect(mocks.save).toHaveBeenCalledWith("test-windows", expect.any(String));
  const token = mocks.save.mock.calls[0]?.[1] as string;
  expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(token);
  expect(input).not.toContain(token);
});

it("rejects Windows clipboard before launching or registering anything", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  process.argv = ["node", "broker", "all", "--clipboard"];
  await expect(import("./secret-broker.js")).rejects.toThrow("CLIPBOARD_MACOS_ONLY");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("requires an interactive Windows terminal for LINE secrets", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  process.argv = ["node", "broker", "channel-secret"];
  await expect(import("./secret-broker.js")).rejects.toThrow("TTY_REQUIRED");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

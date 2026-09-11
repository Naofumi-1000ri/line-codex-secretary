import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentToken, saveAgentToken, windowsTokenPath } from "./keychain.js";

it("hashes agent identifiers so they cannot escape the credential directory", () => {
  const root = path.resolve("credentials");
  expect(windowsTokenPath("../outside/日本語", root)).toMatch(/[a-f0-9]{64}\.dpapi$/);
  expect(path.dirname(windowsTokenPath("../outside/日本語", root))).toBe(root);
  expect(windowsTokenPath("first", root)).not.toBe(windowsTokenPath("second", root));
});

describe.skipIf(process.platform !== "win32")("real Windows DPAPI CurrentUser", () => {
  it("round-trips, encrypts, replaces and isolates credentials; fails safely on missing/corrupt data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "line secretary 日本語 "));
    const first = randomBytes(32).toString("base64url");
    const second = randomBytes(32).toString("base64url");
    try {
      await expect(saveAgentToken("first", first, directory), "initial save").resolves.toBe("");
      await expect(saveAgentToken("second", second, directory), "separate agent save").resolves.toBe("");
      await expect(readAgentToken("first", directory), "initial read").resolves.toBe(first);
      const encrypted = await readFile(windowsTokenPath("first", directory));
      expect(encrypted.includes(Buffer.from(first))).toBe(false);
      await expect(saveAgentToken("first", second, directory), "atomic overwrite").resolves.toBe("");
      expect(await readAgentToken("first", directory)).toBe(second);
      expect(await readAgentToken("second", directory)).toBe(second);
      await expect(readAgentToken("missing", directory)).rejects.toThrow("TOKEN_STORE_FAILED");
      await writeFile(windowsTokenPath("first", directory), first);
      await expect(readAgentToken("first", directory)).rejects.toThrow(/^TOKEN_STORE_FAILED$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

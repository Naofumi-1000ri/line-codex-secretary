import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInsideWorkspace, validateWorkspace } from "./workspace.js";

describe("workspace allowlist", () => {
  it("accepts files under the configured real directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "line-secretary-root-"));
    await writeFile(path.join(root, "safe.txt"), "safe");
    const realRoot = await realpath(root);
    await expect(validateWorkspace(root)).resolves.toBe(realRoot);
    await expect(resolveInsideWorkspace(root, "safe.txt")).resolves.toBe(path.join(realRoot, "safe.txt"));
  });

  it("rejects traversal and symlink escapes", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "line-secretary-parent-"));
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside.txt");
    await mkdir(root);
    await writeFile(outside, "secret");
    await mkdir(path.join(parent, "external"));
    await writeFile(path.join(parent, "external", "secret.txt"), "secret");
    await symlink(path.join(parent, "external"), path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveInsideWorkspace(root, "../outside.txt")).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await expect(resolveInsideWorkspace(root, "escape/secret.txt")).rejects.toThrow("SYMLINK_OUTSIDE_WORKSPACE");
  });
});

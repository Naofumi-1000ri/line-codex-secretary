import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { folderName, organizeMedia, prepareCollection } from "./organize.js";
import type { MediaRecord } from "./media.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
const conversation = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "line-organize-")); roots.push(root);
  const folder = path.join(root, "line-media", conversation, "2026-09-08", "image", "J1");
  await mkdir(folder, { recursive: true });
  const original = path.join(folder, "original.jpg");
  const bytes = Buffer.from([255, 216, 255, 12, 34]); await writeFile(original, bytes);
  const record: MediaRecord = { jobId: "J1", kind: "image", receivedAt: "2026-09-08T00:00:00Z", original, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), images: [] };
  return { root, record, bytes };
}
it("copies into a named collection, preserves originals, and retries without duplicating files", async () => {
  const { root, record, bytes } = await fixture();
  await organizeMedia(root, conversation, "メーカーフェア東京", [record], new AbortController().signal);
  await organizeMedia(root, conversation, "メーカーフェア東京", [record], new AbortController().signal);
  const collection = await prepareCollection(root, conversation, "メーカーフェア東京");
  expect(await readdir(collection)).toEqual(["J1.jpg"]);
  expect(await readFile(path.join(collection, "J1.jpg"))).toEqual(bytes);
  expect(await readFile(record.original)).toEqual(bytes);
  expect(JSON.parse(await readFile(path.join(root, "line-media", conversation, "catalog.json"), "utf8"))[0].collection).toBe("メーカーフェア東京");
});
it("rejects traversal names and a collection symlink", async () => {
  for (const name of ["../escape", "/tmp", "a/b", "a\\b", "..", "bad\nname", "CON", "nul.txt", "COM1", "LPT9.jpg", "a:b", "a?b", "a*b", "a|b", "<a>"]) expect(folderName(name)).toBeUndefined();
  const { root } = await fixture();
  const collection = await prepareCollection(root, conversation, "safe");
  await rm(collection, { recursive: true });
  await symlink(root, collection, process.platform === "win32" ? "junction" : "dir");
  await expect(prepareCollection(root, conversation, "safe")).rejects.toThrow("MEDIA_PATH_INVALID");
});
it("does not overwrite existing different content", async () => {
  const { root, record } = await fixture();
  const collection = await prepareCollection(root, conversation, "safe");
  await writeFile(path.join(collection, "J1.jpg"), "existing");
  await expect(organizeMedia(root, conversation, "safe", [record], new AbortController().signal)).rejects.toThrow("MEDIA_COPY_MISMATCH");
  expect(await readFile(path.join(collection, "J1.jpg"), "utf8")).toBe("existing");
});

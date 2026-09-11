import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "@line-secretary/protocol";
import { MEDIA_LIMITS, mediaExtension, mediaPrompt, readCatalog, receiveMedia, saveMediaSummary, saveStream, updateCatalog } from "./media.js";

const exec = promisify(execFile);
let root: string;
const signal = new AbortController().signal;
const job: ClaimedJob = {
  id: "JTEST", prompt: "整理してください", conversationId: "a".repeat(64), workspaceKey: "linebot", requestedMode: "read_only",
  leaseToken: "x".repeat(40), leaseExpiresAt: "2099-01-01T00:00:00Z",
  media: { messageId: "1234", kind: "image", receivedAt: "2026-09-08T16:00:00.000Z", groupId: "album", groupIndex: 1, groupTotal: 2 }
};
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "line-media-test-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("media storage and previews", () => {
  it.each(["png", "jpg", "video"] as const)("archives %s with real previews and reuses it on retry", async (format) => {
    const kind = format === "video" ? "video" : "image";
    const fixture = path.join(root, format === "video" ? "fixture.mp4" : `fixture.${format}`);
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2", ...(kind === "image" ? ["-frames:v", "1"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p"]), fixture]);
    const bytes = await readFile(fixture);
    const fetchMock = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const current: ClaimedJob = { ...job, media: { ...job.media!, kind } };
    const saved = await receiveMedia(root, current, "https://worker.test", "test-token", signal);
    expect(saved.original).toContain(path.join("2026-09-09", kind, "JTEST", "original."));
    expect(await readFile(saved.original)).toEqual(bytes);
    expect(saved.images).toHaveLength(kind === "image" ? 1 : 6);
    expect(saved.warning).toBeUndefined();
    for (const image of saved.images) expect(mediaExtension(await readFile(image), "image")).toBe("jpg");
    expect(saved.groupId).toBe("album");
    await saveMediaSummary(root, current, saved, { summary: "赤色の画像です", artifacts: [], warnings: [], requested_actions: [] });
    const repeated = await receiveMedia(root, current, "https://worker.test", "test-token", signal);
    expect(repeated.original).toBe(saved.original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readCatalog(root, current.conversationId)).toHaveLength(1);
    expect(await mediaPrompt(root, { ...current, media: undefined, prompt: "さっきの画像をまとめて" })).toContain("赤色の画像です");
    await updateCatalog(root, current.conversationId, { ...repeated, images: [], warning: "previous preview failed" });
    const repaired = await receiveMedia(root, current, "https://worker.test", "test-token", signal);
    expect(repaired.warning).toBeUndefined();
    expect(repaired.images).toHaveLength(kind === "image" ? 1 : 6);
    expect(repaired.summary).toBe("赤色の画像です");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 30_000);
  it("removes partial files when a stream exceeds the limit", async () => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MEDIA_LIMITS.image));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } }));
    await expect(saveStream(response, root, "image", signal)).rejects.toThrow("MEDIA_TOO_LARGE");
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects non-media bytes without leaving a file", async () => {
    await expect(saveStream(new Response("<html>error</html>"), root, "image", signal)).rejects.toThrow("MEDIA_FORMAT_UNSUPPORTED");
    expect(await readdir(root)).toEqual([]);
  });
  it("cleans a cancelled download", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array([255, 216, 255]));
      controller.abort();
    } }));
    await expect(saveStream(response, root, "image", controller.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it("refuses storage directory symlinks", async () => {
    await symlink(os.tmpdir(), path.join(root, "line-media"), process.platform === "win32" ? "junction" : "dir");
    await expect(readCatalog(root, job.conversationId)).rejects.toThrow("MEDIA_PATH_INVALID");
  });
});

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { MediaRecord } from "./media.js";
import { updateCatalog } from "./media.js";

export function folderName(value: string | null | undefined): string | undefined {
  const name = value?.normalize("NFC").trim();
  if (!name || name.length > 100 || /^[. ]|[. ]$/.test(name) || /[\\/\u0000-\u001f\u007f]/.test(name) || name === "..") return undefined;
  // Use the same safe names on Mac and Windows (reserved devices and ADS included).
  if (/[<>:"|?*]/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) return undefined;
  return name;
}

async function safeDirectory(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MEDIA_PATH_INVALID");
  }
  return current;
}

export async function prepareCollection(workspace: string, conversation: string, name: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(conversation) || folderName(name) !== name) throw new Error("MEDIA_PATH_INVALID");
  return safeDirectory(workspace, ["line-media", conversation, "collections", name]);
}

export async function organizeMedia(workspace: string, conversation: string, name: string, records: MediaRecord[], signal: AbortSignal): Promise<void> {
  const destination = await prepareCollection(workspace, conversation, name);
  const root = path.join(workspace, "line-media", conversation);
  for (const record of records) {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]+$/.test(record.jobId)) throw new Error("MEDIA_PATH_INVALID");
    const relative = path.relative(root, record.original);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("MEDIA_PATH_INVALID");
    // Check every source component, including parents, before reading archived bytes.
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("MEDIA_PATH_INVALID");
    }
    const output = path.join(destination, `${record.jobId}${path.extname(record.original)}`);
    try { await copyFile(record.original, output, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if ((await lstat(output)).isSymbolicLink()) throw new Error("MEDIA_PATH_INVALID");
    const hash = createHash("sha256").update(await readFile(output)).digest("hex");
    if (hash !== record.sha256) throw new Error("MEDIA_COPY_MISMATCH");
    record.collection = name;
    await updateCatalog(workspace, conversation, record);
  }
}

export function latestBatch(records: MediaRecord[]): MediaRecord[] {
  const last = records.at(-1);
  if (!last) return [];
  return last.groupId ? records.filter((record) => record.groupId === last.groupId) : [last];
}

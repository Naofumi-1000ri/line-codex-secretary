import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export async function validateWorkspace(configuredPath: string): Promise<string> {
  const absolute = path.resolve(configuredPath);
  const stat = await lstat(absolute);
  if (!stat.isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
  if (stat.isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_REJECTED");
  return realpath(absolute);
}

export async function resolveInsideWorkspace(workspace: string, candidate: string): Promise<string> {
  const root = await validateWorkspace(workspace);
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PATH_OUTSIDE_WORKSPACE");
  const resolved = await realpath(absolute);
  const resolvedRelative = path.relative(root, resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error("SYMLINK_OUTSIDE_WORKSPACE");
  }
  return resolved;
}

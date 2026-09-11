import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { AGENT_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, RELEASE_VERSION, requireCompatibleWorker } from "./index.js";

it("keeps workspace packages, lockfile, Worker config and wire version aligned", async () => {
  for (const name of ["package.json", "apps/agent/package.json", "apps/setup/package.json", "apps/worker/package.json", "packages/protocol/package.json"]) {
    const pkg = JSON.parse(await readFile(name, "utf8"));
    expect(pkg.version).toBe(RELEASE_VERSION);
    if (pkg.dependencies?.["@line-secretary/protocol"]) expect(pkg.dependencies["@line-secretary/protocol"]).toBe(RELEASE_VERSION);
  }
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  for (const name of ["", "apps/agent", "apps/setup", "apps/worker", "packages/protocol"]) expect(lock.packages[name].version).toBe(RELEASE_VERSION);
  const config = JSON.parse(await readFile("apps/worker/wrangler.jsonc", "utf8"));
  expect(config.vars.APP_VERSION).toBe(RELEASE_VERSION);
  expect(AGENT_PROTOCOL_VERSION).toBe(RELEASE_VERSION);
});

it("fails before claiming work when the server version or database schema differs", () => {
  expect(() => requireCompatibleWorker({ ok: true, version: RELEASE_VERSION, schemaVersion: DATABASE_SCHEMA_VERSION })).not.toThrow();
  for (const health of [{ ok: true, version: "0.1.0", schemaVersion: 1 }, { ok: true, version: RELEASE_VERSION, schemaVersion: 3 }, { ok: false, version: RELEASE_VERSION, schemaVersion: 4 }]) {
    expect(() => requireCompatibleWorker(health)).toThrow("WORKER_UPGRADE_REQUIRED");
  }
});

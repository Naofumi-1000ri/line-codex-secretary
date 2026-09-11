import { AGENT_PROTOCOL_VERSION } from "@line-secretary/protocol";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentConfigSchema } from "@line-secretary/protocol";
import { readAgentToken } from "../../agent/src/keychain.js";

const configPath = path.resolve(process.env.LINE_SECRETARY_CONFIG ?? ".agent/config.json");
const config = agentConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const token = await readAgentToken(config.agentId);

async function request(pathname: string, method = "GET"): Promise<unknown> {
  const result = await fetch(new URL(pathname, config.workerUrl), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-version": AGENT_PROTOCOL_VERSION
    }
  });
  if (!result.ok) throw new Error(`WORKER_HTTP_${result.status}`);
  return result.json();
}

const action = process.argv[2];
if (action === "status") {
  console.log(JSON.stringify(await request("/v1/setup/status")));
} else if (action === "link-code") {
  console.log(JSON.stringify(await request("/v1/setup/link-code", "POST")));
} else if (action === "agent-health") {
  console.log(JSON.stringify(await request("/v1/agent/health")));
} else {
  throw new Error("USAGE: worker-control <status|link-code|agent-health>");
}

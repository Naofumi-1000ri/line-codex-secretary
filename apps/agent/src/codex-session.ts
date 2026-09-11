import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { jobResultSchema, type JobResult } from "@line-secretary/protocol";

import { codexExecutable, safeEnvironment } from "./codex-launch.js";

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
};

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  finalMessage: string;
  terminationReason?: "timeout" | "cancelled";
  timeout: NodeJS.Timeout;
  forceStop?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  resolve: (value: CodexTurn) => void;
  reject: (cause: Error) => void;
};

export type CodexTurn = { result: JobResult; threadId: string };
export type OpenedThread = { threadId: string; resumed: boolean };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function parseFinalMessage(text: string): JobResult {
  try {
    return jobResultSchema.parse(JSON.parse(text));
  } catch {
    return jobResultSchema.parse({
      summary: text.trim() || "Codexから結果を取得できませんでした。",
      artifacts: [],
      requested_actions: [],
      warnings: []
    });
  }
}

export class CodexSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly attachedThreads = new Set<string>();
  private nextRequestId = 1;
  private activeTurn: ActiveTurn | undefined;
  private closing = false;

  private constructor(
    private readonly workspace: string,
    private readonly outputSchema: Record<string, unknown>,
    private readonly model: string,
    private readonly reasoningEffort: string
  ) {
    this.child = spawn(codexExecutable(), ["app-server", "--stdio"], {
      cwd: workspace,
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.resume();
    this.child.on("error", () => this.handleExit("CODEX_APP_SERVER_START_FAILED"));
    this.child.on("close", () => this.handleExit(this.closing ? "CODEX_APP_SERVER_STOPPED" : "CODEX_APP_SERVER_EXITED"));
  }

  static async start(workspace: string, model: string, reasoningEffort: string): Promise<CodexSession> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(here, "../../../packages/protocol/job-result.schema.json");
    const outputSchema = asRecord(JSON.parse(await readFile(schemaPath, "utf8")));
    if (!outputSchema) throw new Error("CODEX_OUTPUT_SCHEMA_INVALID");
    const session = new CodexSession(workspace, outputSchema, model, reasoningEffort);
    try {
      await session.request("initialize", {
        clientInfo: {
          name: "line_codex_secretary",
          title: "LINE Codex Secretary",
          version: "0.1.0"
        },
        capabilities: null
      });
      session.notify("initialized", {});
      return session;
    } catch (cause) {
      await session.close();
      throw cause;
    }
  }

  async openThread(threadId?: string, ephemeral = false): Promise<OpenedThread> {
    if (threadId) {
      if (this.attachedThreads.has(threadId)) {
        return { threadId, resumed: true };
      }
      try {
        const resumed = asRecord(await this.request("thread/resume", {
          threadId,
          cwd: this.workspace,
          model: this.model,
          approvalPolicy: "never",
          sandbox: "read-only"
        }));
        const thread = asRecord(resumed?.thread);
        if (typeof thread?.id !== "string") throw new Error("CODEX_THREAD_RESPONSE_INVALID");
        this.attachedThreads.add(thread.id);
        return { threadId: thread.id, resumed: true };
      } catch {
        // A locally deleted or incompatible thread is replaced with a fresh session.
      }
    }

    const started = asRecord(await this.request("thread/start", {
      cwd: this.workspace,
      model: this.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "line_codex_secretary",
      ephemeral
    }));
    const thread = asRecord(started?.thread);
    if (typeof thread?.id !== "string") throw new Error("CODEX_THREAD_RESPONSE_INVALID");
    this.attachedThreads.add(thread.id);
    return { threadId: thread.id, resumed: false };
  }

  async runTurn(threadId: string, prompt: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<CodexTurn> {
    if (this.activeTurn) throw new Error("CODEX_TURN_ALREADY_RUNNING");

    return new Promise<CodexTurn>((resolve, reject) => {
      const active: ActiveTurn = {
        threadId,
        finalMessage: "",
        timeout: setTimeout(() => this.stopActiveTurn("timeout"), timeoutMs),
        resolve,
        reject,
        ...(abortSignal ? { abortSignal } : {})
      };
      if (abortSignal) {
        active.abortHandler = () => this.stopActiveTurn("cancelled");
        abortSignal.addEventListener("abort", active.abortHandler, { once: true });
      }
      this.activeTurn = active;
      if (abortSignal?.aborted) active.abortHandler?.();

      void this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.workspace,
        model: this.model,
        effort: this.reasoningEffort,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: this.outputSchema
      }).then((value) => {
        if (this.activeTurn !== active) return;
        const turn = asRecord(asRecord(value)?.turn);
        if (typeof turn?.id !== "string") {
          this.finishActiveTurn(new Error("CODEX_TURN_RESPONSE_INVALID"));
          return;
        }
        active.turnId = turn.id;
        if (active.terminationReason) this.interruptActiveTurn();
      }).catch((cause: unknown) => {
        if (this.activeTurn === active) {
          this.finishActiveTurn(cause instanceof Error ? cause : new Error("CODEX_TURN_START_FAILED"));
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
      force.unref();
      this.child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.child.stdin.writable) throw new Error("CODEX_APP_SERVER_UNAVAILABLE");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const code = message.error.code ?? "ERROR";
        const detail = message.error.message ? `:${message.error.message}` : "";
        pending.reject(new Error(`CODEX_APP_SERVER_RPC_${code}${detail}`));
      }
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.id === "number" && message.method) {
      this.write({ id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      return;
    }

    const active = this.activeTurn;
    if (!active || !message.method || !message.params) return;
    if (message.params.threadId !== active.threadId) return;

    if (message.method === "item/completed") {
      const item = asRecord(message.params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") active.finalMessage = item.text;
      return;
    }

    if (message.method === "turn/completed") {
      const turn = asRecord(message.params.turn);
      if (active.turnId && turn?.id !== active.turnId) return;
      if (!active.finalMessage && Array.isArray(turn?.items)) {
        for (const rawItem of turn.items) {
          const item = asRecord(rawItem);
          if (item?.type === "agentMessage" && typeof item.text === "string") active.finalMessage = item.text;
        }
      }
      if (active.terminationReason === "cancelled") this.finishActiveTurn(new Error("CODEX_CANCELLED"));
      else if (active.terminationReason === "timeout") this.finishActiveTurn(new Error("CODEX_TIMEOUT"));
      else if (turn?.status !== "completed") this.finishActiveTurn(new Error("CODEX_TURN_FAILED"));
      else this.finishActiveTurn(undefined, {
        threadId: active.threadId,
        result: parseFinalMessage(active.finalMessage)
      });
    }
  }

  private stopActiveTurn(reason: "timeout" | "cancelled"): void {
    const active = this.activeTurn;
    if (!active || active.terminationReason) return;
    active.terminationReason = reason;
    this.interruptActiveTurn();
    active.forceStop = setTimeout(() => {
      this.child.kill("SIGTERM");
      if (this.activeTurn === active) {
        this.finishActiveTurn(new Error(reason === "timeout" ? "CODEX_TIMEOUT" : "CODEX_CANCELLED"));
      }
    }, 5_000);
    active.forceStop.unref();
  }

  private interruptActiveTurn(): void {
    const active = this.activeTurn;
    if (!active?.turnId) return;
    void this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined);
  }

  private finishActiveTurn(cause?: Error, value?: CodexTurn): void {
    const active = this.activeTurn;
    if (!active) return;
    this.activeTurn = undefined;
    clearTimeout(active.timeout);
    if (active.forceStop) clearTimeout(active.forceStop);
    if (active.abortSignal && active.abortHandler) {
      active.abortSignal.removeEventListener("abort", active.abortHandler);
    }
    if (cause) active.reject(cause);
    else if (value) active.resolve(value);
    else active.reject(new Error("CODEX_TURN_FAILED"));
  }

  private handleExit(code: string): void {
    const cause = new Error(code);
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
    if (this.activeTurn) this.finishActiveTurn(cause);
  }
}

import { z } from "zod";

export const RELEASE_VERSION = "0.3.0";
export const AGENT_PROTOCOL_VERSION = "0.3.0";
export const DATABASE_SCHEMA_VERSION = 4;

export function requireCompatibleWorker(health: unknown): void {
  const parsed = z.object({ ok: z.literal(true), version: z.literal(RELEASE_VERSION), schemaVersion: z.literal(DATABASE_SCHEMA_VERSION) }).safeParse(health);
  if (!parsed.success) throw new Error("WORKER_UPGRADE_REQUIRED: expected release 0.3.0 and database schema 4");
}

export const jobStatusSchema = z.enum([
  "QUEUED",
  "LEASED",
  "RUNNING",
  "WAITING_APPROVAL",
  "RETRY_WAIT",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "COMPLETED",
  "FAILED"
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

export const mediaSchema = z.object({
  messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  kind: z.enum(["image", "video"]),
  receivedAt: z.string().datetime(),
  groupId: z.string().max(200).optional(),
  groupIndex: z.number().int().positive().optional(),
  groupTotal: z.number().int().positive().optional()
});
export type MediaAttachment = z.infer<typeof mediaSchema>;

export const claimedJobSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1).max(250_000),
  conversationId: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceKey: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  requestedMode: z.literal("read_only"),
  leaseToken: z.string().min(32),
  leaseExpiresAt: z.string(),
  media: mediaSchema.optional(),
  attachments: z.array(z.object({ jobId: z.string(), media: mediaSchema })).max(30).optional(),
  notificationMode: z.enum(["quiet", "detailed"]).optional(),
  continuation: z.boolean().optional(),
  previousResults: z.array(z.string()).optional()
});

export const claimResponseSchema = z.object({
  job: claimedJobSchema.nullable()
});

export const jobResultSchema = z.object({
  summary: z.string().min(1).max(12_000),
  folder: z.string().max(100).nullable().optional(),
  execution: z.enum(["reply", "work", "ask", "analyze", "organize"]).nullable().optional(),
  notification: z.object({ mode: z.enum(["quiet", "detailed", "inherit"]), scope: z.enum(["turn", "conversation"]) }).nullable().optional(),
  artifacts: z.array(z.string().max(500)).max(20).default([]),
  requested_actions: z.array(z.string().max(500)).max(20).default([]),
  warnings: z.array(z.string().max(500)).max(20).default([])
});

export type ClaimedJob = z.infer<typeof claimedJobSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;

export const LINE_SECRETARY_MODEL = "gpt-5.6-luna" as const;
export const LINE_SECRETARY_REASONING_EFFORT = "max" as const;

export const agentConfigSchema = z.object({
  workerUrl: z.string().url().refine((value) => value.startsWith("https://")),
  agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  workspaceKey: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  workspacePath: z.string().min(1),
  model: z.literal(LINE_SECRETARY_MODEL).default(LINE_SECRETARY_MODEL),
  reasoningEffort: z.literal(LINE_SECRETARY_REASONING_EFFORT).default(LINE_SECRETARY_REASONING_EFFORT),
  pollIntervalMs: z.number().int().min(2_000).max(60_000).default(5_000),
  heartbeatIntervalMs: z.number().int().min(10_000).max(120_000).default(30_000),
  timeoutMs: z.number().int().min(60_000).max(3_600_000).default(1_800_000)
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

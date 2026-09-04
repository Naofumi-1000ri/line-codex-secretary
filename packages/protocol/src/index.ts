import { z } from "zod";

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

export const claimedJobSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1).max(8_000),
  conversationId: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceKey: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  requestedMode: z.literal("read_only"),
  leaseToken: z.string().min(32),
  leaseExpiresAt: z.string()
});

export const claimResponseSchema = z.object({
  job: claimedJobSchema.nullable()
});

export const jobResultSchema = z.object({
  summary: z.string().min(1).max(12_000),
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

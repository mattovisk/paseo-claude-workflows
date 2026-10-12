import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WorkflowAgentSchema = z.object({
  agentId: z.string(),
  label: z.string(),
  /** "running", "done" or "error" from the journal; final records may carry other values verbatim. */
  state: z.string(),
  cached: z.boolean(),
  startedAt: z.number().nullable(),
  lastActivityAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  tokens: z.number().nullable(),
  toolCalls: z.number(),
  lastTool: z.string().nullable(),
  lastToolSummary: z.string().nullable(),
  error: z.string().nullable(),
});

export const WorkflowPhaseSchema = z.object({
  title: z.string(),
  detail: z.string().nullable(),
  agents: z.array(WorkflowAgentSchema),
});

export const WorkflowRunSchema = z.object({
  runId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** "running" while no final record exists; otherwise the status Claude Code wrote ("completed", ...). */
  status: z.string(),
  startedAt: z.number().nullable(),
  lastActivityAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  totalTokens: z.number().nullable(),
  totalToolCalls: z.number().nullable(),
  phases: z.array(WorkflowPhaseSchema),
});

export const WorkflowRunsSchema = z.object({
  provider: z.string().nullable(),
  sessionId: z.string().nullable(),
  runs: z.array(WorkflowRunSchema),
});

export type WorkflowAgent = z.infer<typeof WorkflowAgentSchema>;
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRuns = z.infer<typeof WorkflowRunsSchema>;

export const workflowRunsRpc = defineRpc({
  name: "workflow-runs",
  input: z.object({ agentId: z.string() }),
  output: WorkflowRunsSchema,
});

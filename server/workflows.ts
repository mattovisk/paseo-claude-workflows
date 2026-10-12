import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WorkflowAgent, WorkflowPhase, WorkflowRun } from "../shared/contract";
import { JsonlTailer } from "./jsonl-tail";
import { parseScriptMeta, type ScriptMeta } from "./script-meta";

function projectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

const RUN_ID = /^wf_[a-z0-9-]+$/;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * Every `~/.claude/projects/<project>/<sessionId>` folder. A resumed session can live under
 * several project folders (one per cwd), and a run's files can be split between them.
 */
async function sessionDirs(sessionId: string): Promise<string[]> {
  const root = projectsRoot();
  const candidates = (await listDir(root)).map((project) => join(root, project, sessionId));
  const found = await Promise.all(candidates.map(async (dir) => ((await exists(dir)) ? dir : null)));
  return found.filter((dir): dir is string => dir !== null);
}

// ---------- journal.jsonl ----------

interface JournalAgent {
  agentId: string;
  label: string;
  phase: string | null;
  state: "running" | "done" | "error";
}

interface JournalState {
  /** Latest agent per label, in order of first appearance. */
  byLabel: Map<string, JournalAgent>;
  byId: Map<string, JournalAgent>;
}

/**
 * A resumed run appends to the same journal, so one label can be started by several attempts.
 * Claude Code's final record keeps the latest attempt per label; the live view does the same.
 */
const journals = new JsonlTailer<JournalState>(
  () => ({ byLabel: new Map(), byId: new Map() }),
  (journal, entry) => {
    const agentId = typeof entry.agentId === "string" ? entry.agentId : null;
    if (!agentId) return;
    if (entry.type === "started") {
      const agent: JournalAgent = {
        agentId,
        label: typeof entry.label === "string" ? entry.label : agentId,
        phase: typeof entry.phase === "string" ? entry.phase : null,
        state: "running",
      };
      journal.byId.set(agentId, agent);
      journal.byLabel.set(agent.label, agent);
    } else if (entry.type === "result" || entry.type === "failed") {
      const agent = journal.byId.get(agentId);
      if (agent) agent.state = entry.type === "result" ? "done" : "error";
    }
  },
);

// ---------- agent-<id>.jsonl ----------

interface TranscriptStats {
  firstAt: number | null;
  lastAt: number | null;
  toolCalls: number;
  lastTool: string | null;
  lastToolSummary: string | null;
  contextTokens: number | null;
  model: string | null;
  effort: string | null;
}

interface AgentSettings {
  model: string | null;
  effort: string | null;
}

/**
 * Model and effort from an assistant entry. `requestedModel` is what the agent asked for;
 * `message.model` is the fallback, except on "<synthetic>" API-error entries.
 */
function agentSettings(entry: Record<string, unknown>): AgentSettings | null {
  if (entry.type !== "assistant") return null;
  const served = str((entry.message as { model?: unknown } | undefined)?.model);
  const model = str(entry.requestedModel) ?? (served === "<synthetic>" ? null : served);
  const effort = str(entry.effort) ?? str(entry.perTurnEffort);
  return model || effort ? { model, effort } : null;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "/a/b/c/d.ts" -> "c/d.ts": the end of a path is the part that tells files apart. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  if (typeof fields.file_path === "string" && !fields.description) return oneLine(shortPath(fields.file_path));
  for (const key of ["description", "command", "file_path", "pattern", "url", "query", "path", "prompt"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  const first = Object.values(fields).find((value) => typeof value === "string" && value.trim());
  return typeof first === "string" ? oneLine(first) : null;
}

const transcripts = new JsonlTailer<TranscriptStats>(
  () => ({
    firstAt: null,
    lastAt: null,
    toolCalls: 0,
    lastTool: null,
    lastToolSummary: null,
    contextTokens: null,
    model: null,
    effort: null,
  }),
  (stats, entry) => {
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(at)) {
      if (stats.firstAt === null || at < stats.firstAt) stats.firstAt = at;
      if (stats.lastAt === null || at > stats.lastAt) stats.lastAt = at;
    }
    const settings = agentSettings(entry);
    if (settings) {
      stats.model = settings.model ?? stats.model;
      stats.effort = settings.effort ?? stats.effort;
    }
    if (entry.type !== "assistant") return;
    const message = entry.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
    const usage = message?.usage;
    if (usage) {
      // Context size of the latest turn. Matches Claude Code's per-agent `tokens` to within ~0.1%.
      const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
      stats.contextTokens = count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
    }
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content as { type?: string; name?: string; input?: unknown }[]) {
      if (block?.type !== "tool_use") continue;
      stats.toolCalls++;
      stats.lastTool = typeof block.name === "string" ? block.name : null;
      stats.lastToolSummary = summarizeToolInput(block.input);
    }
  },
);

// ---------- settings of finished agents ----------

const HEAD_CHUNK = 256 * 1024;
const HEAD_LIMIT = 4 * 1024 * 1024;
const headSettings = new Map<string, AgentSettings | null>();

/**
 * Model and effort from the first assistant entry of a finished transcript. The final record
 * has no effort, and a run's transcripts can total hundreds of MB, so read only up to that
 * entry (usually within the first 600 KB). Effort does not change during an agent's life.
 */
async function readHeadSettings(path: string): Promise<AgentSettings | null> {
  if (headSettings.has(path)) return headSettings.get(path) ?? null;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  let found: AgentSettings | null = null;
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(HEAD_CHUNK);
    let rest = "";
    for (let offset = 0; offset < HEAD_LIMIT && !found; ) {
      const { bytesRead } = await handle.read(buffer, 0, HEAD_CHUNK, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const lines = (rest + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        try {
          found = agentSettings(JSON.parse(line) as Record<string, unknown>);
        } catch {
          continue;
        }
        if (found) break;
      }
    }
  } finally {
    await handle.close();
  }
  headSettings.set(path, found);
  return found;
}

/** Fills in what the final record lacks (effort, and model when absent) from the transcripts. */
async function addSettings(run: WorkflowRun, dirs: string[]): Promise<void> {
  const runDirs = dirs.map((dir) => join(dir, "subagents", "workflows", run.runId));
  for (const phase of run.phases) {
    for (const agent of phase.agents) {
      if (agent.model && agent.effort) continue;
      for (const runDir of runDirs) {
        const settings = await readHeadSettings(join(runDir, `agent-${agent.agentId}.jsonl`));
        if (!settings) continue;
        agent.model ??= settings.model;
        agent.effort ??= settings.effort;
        break;
      }
    }
  }
}

// ---------- cached whole-file reads ----------

const fileCache = new Map<string, { key: string; value: unknown }>();

async function readCached<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  try {
    const info = await stat(path);
    const key = `${info.mtimeMs}:${info.size}`;
    const hit = fileCache.get(path);
    if (hit && hit.key === key) return hit.value as T;
    const value = parse(await readFile(path, "utf8"));
    fileCache.set(path, { key, value });
    return value;
  } catch {
    return null;
  }
}

// ---------- final record: workflows/<runId>.json ----------

interface FinalRecord {
  runId?: string;
  workflowName?: string;
  summary?: string;
  status?: string;
  startTime?: number;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  defaultModel?: string;
  phases?: { title?: string; detail?: string }[];
  workflowProgress?: Record<string, unknown>[];
}

function runFromFinal(runId: string, record: FinalRecord): WorkflowRun {
  const progress = Array.isArray(record.workflowProgress) ? record.workflowProgress : [];
  const phases: WorkflowPhase[] = [];
  const phaseByIndex = new Map<number, WorkflowPhase>();
  const phaseByTitle = new Map<string, WorkflowPhase>();
  const addPhase = (title: string, detail: string | null) => {
    let phase = phaseByTitle.get(title);
    if (!phase) {
      phase = { title, detail, agents: [] };
      phaseByTitle.set(title, phase);
      phases.push(phase);
    }
    return phase;
  };
  for (const declared of record.phases ?? []) {
    if (str(declared?.title)) addPhase(declared.title as string, str(declared.detail));
  }
  for (const item of progress) {
    if (item.type === "workflow_phase" && str(item.title)) {
      const phase = addPhase(item.title as string, null);
      const index = num(item.index);
      if (index !== null) phaseByIndex.set(index, phase);
    }
  }
  for (const item of progress) {
    if (item.type !== "workflow_agent") continue;
    const index = num(item.phaseIndex);
    const phase =
      (index !== null ? phaseByIndex.get(index) : undefined) ?? addPhase(str(item.phaseTitle) ?? "", null);
    const startedAt = num(item.startedAt);
    const durationMs = num(item.durationMs);
    phase.agents.push({
      agentId: str(item.agentId) ?? `${runId}-${phase.agents.length}`,
      label: str(item.label) ?? "agent",
      state: str(item.state) ?? "unknown",
      cached: item.cached === true,
      model: str(item.model) ?? str(record.defaultModel),
      effort: null,
      startedAt,
      lastActivityAt: num(item.lastProgressAt),
      durationMs,
      tokens: num(item.tokens),
      toolCalls: num(item.toolCalls) ?? 0,
      lastTool: str(item.lastToolName),
      lastToolSummary: str(item.lastToolSummary),
      error: str(item.error),
    });
  }
  const startedAt = num(record.startTime);
  const durationMs = num(record.durationMs);
  return {
    runId,
    name: str(record.workflowName) ?? runId,
    description: str(record.summary),
    status: str(record.status) ?? "unknown",
    startedAt,
    lastActivityAt: startedAt !== null && durationMs !== null ? startedAt + durationMs : null,
    durationMs,
    totalTokens: num(record.totalTokens),
    totalToolCalls: num(record.totalToolCalls),
    phases: phases.filter((phase) => phase.agents.length > 0 || phase.title),
  };
}

// ---------- live run: journal + transcripts + script meta ----------

async function liveRun(runId: string, dirs: string[]): Promise<WorkflowRun | null> {
  const runDirs = dirs.map((dir) => join(dir, "subagents", "workflows", runId));
  let journalPath: string | null = null;
  let journal: JournalState | null = null;
  for (const runDir of runDirs) {
    const path = join(runDir, "journal.jsonl");
    journal = await journals.read(path);
    if (journal) {
      journalPath = path;
      break;
    }
  }
  if (!journal || !journalPath) return null;
  const agents = journal.byLabel;
  const runDir = join(journalPath, "..");

  let meta: ScriptMeta | null = null;
  let scriptName: string | null = null;
  for (const dir of dirs) {
    const scriptsDir = join(dir, "workflows", "scripts");
    const file = (await listDir(scriptsDir)).find((entry) => entry.endsWith(`-${runId}.js`));
    if (file) {
      scriptName = basename(file, `-${runId}.js`);
      meta = await readCached(join(scriptsDir, file), parseScriptMeta);
      break;
    }
  }

  const phases: WorkflowPhase[] = (meta?.phases ?? []).map((phase) => ({ ...phase, agents: [] }));
  const phaseFor = (title: string) => {
    let phase = phases.find((candidate) => candidate.title === title);
    if (!phase) {
      phase = { title, detail: null, agents: [] };
      phases.push(phase);
    }
    return phase;
  };

  let startedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let totalTokens = 0;
  let totalToolCalls = 0;
  for (const agent of agents.values()) {
    const stats = await transcripts.read(join(runDir, `agent-${agent.agentId}.jsonl`));
    const firstAt = stats?.firstAt ?? null;
    const lastAt = stats?.lastAt ?? null;
    if (firstAt !== null && (startedAt === null || firstAt < startedAt)) startedAt = firstAt;
    if (lastAt !== null && (lastActivityAt === null || lastAt > lastActivityAt)) lastActivityAt = lastAt;
    totalTokens += stats?.contextTokens ?? 0;
    totalToolCalls += stats?.toolCalls ?? 0;
    const entry: WorkflowAgent = {
      agentId: agent.agentId,
      label: agent.label,
      state: agent.state,
      cached: false,
      model: stats?.model ?? null,
      effort: stats?.effort ?? null,
      startedAt: firstAt,
      lastActivityAt: lastAt,
      durationMs: agent.state !== "running" && firstAt !== null && lastAt !== null ? lastAt - firstAt : null,
      tokens: stats?.contextTokens ?? null,
      toolCalls: stats?.toolCalls ?? 0,
      lastTool: stats?.lastTool ?? null,
      lastToolSummary: stats?.lastToolSummary ?? null,
      error: null,
    };
    phaseFor(agent.phase ?? "").agents.push(entry);
  }

  if (startedAt === null) {
    try {
      const info = await stat(journalPath);
      startedAt = info.birthtimeMs || info.ctimeMs;
      lastActivityAt = Math.max(lastActivityAt ?? 0, info.mtimeMs);
    } catch {
      // The run folder vanished between reads; report what we have.
    }
  }

  return {
    runId,
    name: meta?.name ?? scriptName ?? runId,
    description: meta?.description ?? null,
    status: "running",
    startedAt,
    lastActivityAt,
    durationMs: null,
    totalTokens: agents.size > 0 ? totalTokens : null,
    totalToolCalls,
    phases,
  };
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** True when the journal moved on after the final record was written: the run was resumed. */
async function resumedAfter(finalPath: string, runId: string, dirs: string[]): Promise<boolean> {
  const finalAt = await mtime(finalPath);
  if (finalAt === null) return false;
  for (const dir of dirs) {
    const journalAt = await mtime(join(dir, "subagents", "workflows", runId, "journal.jsonl"));
    if (journalAt !== null && journalAt > finalAt + 1000) return true;
  }
  return false;
}

/** All Workflow runs recorded for a Claude Code session, newest first. */
export async function readWorkflowRuns(sessionId: string): Promise<WorkflowRun[]> {
  const dirs = await sessionDirs(sessionId);
  const runIds = new Set<string>();
  const finals = new Map<string, string>();
  for (const dir of dirs) {
    for (const entry of await listDir(join(dir, "subagents", "workflows"))) {
      if (RUN_ID.test(entry)) runIds.add(entry);
    }
    for (const entry of await listDir(join(dir, "workflows"))) {
      if (!entry.endsWith(".json")) continue;
      const runId = entry.slice(0, -".json".length);
      if (!RUN_ID.test(runId)) continue;
      runIds.add(runId);
      finals.set(runId, join(dir, "workflows", entry));
    }
  }

  const runs = await Promise.all(
    [...runIds].map(async (runId) => {
      const finalPath = finals.get(runId);
      if (finalPath && !(await resumedAfter(finalPath, runId, dirs))) {
        const run = await readCached(finalPath, (text) => runFromFinal(runId, JSON.parse(text) as FinalRecord));
        if (run) {
          await addSettings(run, dirs);
          return run;
        }
      }
      return liveRun(runId, dirs);
    }),
  );
  journals.sweep();
  transcripts.sweep();
  return runs
    .filter((run): run is WorkflowRun => run !== null)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

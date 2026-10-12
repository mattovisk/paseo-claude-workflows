import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { workflowRunsRpc, type WorkflowAgent, type WorkflowPhase, type WorkflowRun } from "../shared/contract";
import { formatDuration, formatTokens, plural } from "./format";

type Theme = PluginAgentPanelProps["theme"];

const POLL_MS = 2000;
/** A run with no final record and no new transcript lines for this long gets a warning. */
const QUIET_MS = 5 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function WorkflowsPanel(props: PluginAgentPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <PanelBody {...props} />
    </QueryClientProvider>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function PanelBody({ agentId, host, theme }: PluginAgentPanelProps) {
  const fetchRuns = useRpc(workflowRunsRpc);
  const query = useQuery({
    queryKey: ["claude-workflows", host.id, agentId],
    queryFn: () => fetchRuns({ agentId }),
    refetchInterval: POLL_MS,
  });
  const runs = query.data?.runs ?? [];
  const now = useNow(runs.some((run) => run.status === "running"));
  const c = theme.colors;

  if (query.isPending) {
    return (
      <Centered theme={theme}>
        <ActivityIndicator color={c.foregroundMuted} />
      </Centered>
    );
  }
  if (query.isError && !query.data) {
    return (
      <Centered theme={theme}>
        <Text style={{ color: c.statusDanger, fontSize: 13 }}>Could not read workflow runs.</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{String(query.error?.message ?? query.error)}</Text>
      </Centered>
    );
  }
  const data = query.data!;
  if (data.provider !== "claude") {
    return <Centered theme={theme} message="Workflow runs exist only for Claude Code agents." />;
  }
  if (!data.sessionId) {
    return <Centered theme={theme} message="This agent has no Claude Code session yet." />;
  }
  if (runs.length === 0) {
    return <Centered theme={theme} message="No workflow runs in this session yet." />;
  }
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} theme={theme} now={now} />
      ))}
    </ScrollView>
  );
}

function Centered({ theme, message, children }: { theme: Theme; message?: string; children?: React.ReactNode }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 6,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {message ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>{message}</Text>
      ) : null}
      {children}
    </View>
  );
}

function countAgents(run: WorkflowRun) {
  let total = 0;
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const phase of run.phases) {
    for (const agent of phase.agents) {
      total++;
      if (agent.state === "done") done++;
      else if (agent.state === "error") failed++;
      else if (agent.state === "running") running++;
    }
  }
  return { total, done, failed, running };
}

function statusColor(theme: Theme, status: string): string {
  if (status === "running") return theme.colors.accent;
  if (status === "completed" || status === "done") return theme.colors.statusSuccess;
  if (status === "failed" || status === "error") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function RunCard({ run, theme, now }: { run: WorkflowRun; theme: Theme; now: number }) {
  const c = theme.colors;
  const live = run.status === "running";
  const [open, setOpen] = useState(live);
  const counts = countAgents(run);
  const elapsed = live
    ? run.startedAt !== null
      ? now - run.startedAt
      : null
    : run.durationMs;
  const quietFor = live && run.lastActivityAt !== null ? now - run.lastActivityAt : 0;
  const facts = [
    `${counts.done + counts.failed}/${plural(counts.total, "agent")}`,
    formatDuration(elapsed),
    run.totalTokens !== null ? `${formatTokens(run.totalTokens)} tokens` : "",
    run.totalToolCalls ? plural(run.totalToolCalls, "tool call") : "",
  ].filter(Boolean);

  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1 }}>
      <Pressable onPress={() => setOpen(!open)} style={{ padding: 10, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: "600" }}>
            {run.name}
          </Text>
          <Text style={{ color: statusColor(theme, run.status), fontSize: 11, fontWeight: "600" }}>
            {statusLabel(run.status)}
          </Text>
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{facts.join(" · ")}</Text>
        <ProgressBar theme={theme} {...counts} />
        {quietFor > QUIET_MS ? (
          <Text style={{ color: c.statusWarning, fontSize: 11 }}>
            No activity for {formatDuration(quietFor)}. The run may have stopped without a final record.
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingVertical: 4 }}>
          {run.description ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 10, paddingVertical: 4 }}>
              {run.description}
            </Text>
          ) : null}
          {run.phases.map((phase, index) => (
            <PhaseSection key={`${index}:${phase.title}`} phase={phase} theme={theme} now={now} live={live} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ProgressBar({
  theme,
  total,
  done,
  failed,
  running,
}: {
  theme: Theme;
  total: number;
  done: number;
  failed: number;
  running: number;
}) {
  const c = theme.colors;
  if (total === 0) return null;
  const segment = (count: number, color: string) =>
    count > 0 ? <View style={{ flex: count, backgroundColor: color }} /> : null;
  return (
    <View style={{ flexDirection: "row", height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: c.surface2 }}>
      {segment(done, c.statusSuccess)}
      {segment(failed, c.statusDanger)}
      {segment(running, c.foregroundMuted)}
      {segment(total - done - failed - running, "transparent")}
    </View>
  );
}

function phaseIcon(phase: WorkflowPhase): { name: string; state: string } {
  const states = phase.agents.map((agent) => agent.state);
  if (states.length === 0) return { name: "Circle", state: "pending" };
  if (states.includes("running")) return { name: "LoaderCircle", state: "running" };
  if (states.includes("error")) return { name: "CircleAlert", state: "error" };
  return { name: "CircleCheck", state: "done" };
}

function PhaseSection({ phase, theme, now, live }: { phase: WorkflowPhase; theme: Theme; now: number; live: boolean }) {
  const c = theme.colors;
  const icon = phaseIcon(phase);
  const busy = phase.agents.some((agent) => agent.state === "running");
  const [open, setOpen] = useState<boolean | null>(null);
  // Follow the run until the user toggles: open while agents work, closed once they finish.
  const expanded = open ?? (busy || (live && phase.agents.length <= 8));
  const finished = phase.agents.filter((agent) => agent.state !== "running").length;
  const color = icon.state === "pending" ? c.foregroundMuted : statusColor(theme, icon.state);

  return (
    <View>
      <Pressable
        onPress={() => setOpen(!expanded)}
        disabled={phase.agents.length === 0}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6 }}
      >
        <Icon name={icon.name} size={14} color={color} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>
            {phase.title || "Agents"}
          </Text>
          {phase.detail ? (
            <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>
              {phase.detail}
            </Text>
          ) : null}
        </View>
        {phase.agents.length > 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
            {finished}/{phase.agents.length}
          </Text>
        ) : null}
      </Pressable>
      {expanded ? phase.agents.map((agent) => <AgentRow key={agent.agentId} agent={agent} theme={theme} now={now} />) : null}
    </View>
  );
}

function AgentRow({ agent, theme, now }: { agent: WorkflowAgent; theme: Theme; now: number }) {
  const c = theme.colors;
  const running = agent.state === "running";
  const elapsed = running ? (agent.startedAt !== null ? now - agent.startedAt : null) : agent.durationMs;
  const detail = agent.error
    ? agent.error
    : running && agent.lastTool
      ? `${agent.lastTool}${agent.lastToolSummary ? `: ${agent.lastToolSummary}` : ""}`
      : null;
  const facts = [
    agent.state === "error" && !agent.error ? "failed" : "",
    agent.cached ? "cached" : "",
    agent.toolCalls ? plural(agent.toolCalls, "tool") : "",
    formatDuration(elapsed),
  ].filter(Boolean);

  return (
    <View style={{ paddingLeft: 32, paddingRight: 10, paddingVertical: 3, gap: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            borderWidth: running ? 1.5 : 0,
            borderColor: c.accent,
            backgroundColor: running ? "transparent" : statusColor(theme, agent.state),
          }}
        />
        <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12 }}>
          {agent.label}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{facts.join(" · ")}</Text>
      </View>
      {detail ? (
        <Text
          numberOfLines={2}
          style={{ marginLeft: 12, color: agent.error ? c.statusDanger : c.foregroundMuted, fontSize: 11 }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { workflowRunsRpc } from "./shared/contract";
import { readWorkflowRuns } from "./server/workflows";

export default function contribute(server: PluginServerContext) {
  server.handle(workflowRunsRpc, async ({ agentId }, { paseo }) => {
    // `refresh()` is a read-only fetch_agent request; it does not reload or interrupt the agent.
    const result = await paseo.agents.ref(agentId).refresh();
    const runtime = result?.agent.runtimeInfo ?? null;
    const provider = runtime?.provider ?? result?.agent.provider ?? null;
    const sessionId = provider === "claude" ? (runtime?.sessionId ?? null) : null;
    return { provider, sessionId, runs: sessionId ? await readWorkflowRuns(sessionId) : [] };
  });
  return () => {};
}

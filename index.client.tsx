import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkflowsPanel } from "./client/workflows-panel";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "workflows",
    title: "Workflows",
    icon: "Workflow",
    context: "agent",
    locations: ["explorer"],
    Component: WorkflowsPanel,
  });
  // The explorer's "+" menu lists only workspace panels; an agent panel opens through a command.
  const removeCommand = client.addCommandCenterItem({
    id: "show-workflows",
    title: "Show workflow runs",
    icon: "Workflow",
    keywords: ["claude", "workflow", "agents", "progress"],
    context: "agent",
    onSelect: (context) => context.openPanel("workflows", { location: "explorer" }),
  });
  return () => {
    removeCommand();
    removePanel();
  };
}

Claude Workflows adds a Workflows tab to the right pane of a Claude Code agent. It shows the live progress of the agent's Claude Code Workflow runs: each run's phases, which subagents are running, done or failed, the tool each running subagent is using, elapsed time, tool calls and tokens. Finished runs stay in the list with their final status. The tab refreshes every 2 seconds while it is open.

Open it from the Command Center with "Show workflow runs" while an agent is focused. Paseo lists only workspace panels in the pane's "+" menu, so agent panels open through a command.

## How it works

The daemon side looks up the agent's Claude Code session id and reads that session's files under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`):

- `subagents/workflows/<runId>/journal.jsonl` for which subagents started, finished or failed, and their phase
- `subagents/workflows/<runId>/agent-<id>.jsonl` for timestamps, tool calls and token counts, read incrementally
- `workflows/scripts/<name>-<runId>.js` for the run's name and declared phases, parsed as text and never executed
- `workflows/<runId>.json`, written when a run ends, for the final status and totals

## Limits

- Works only for Claude Code agents running on the same machine as the Paseo daemon.
- Live token counts are the latest context size of each subagent. They match Claude Code's final per-agent figure to within about 0.1%.
- A run that stops without writing its final record keeps showing as running, with a warning after 5 minutes without activity.
- When a run is resumed, the tab shows the latest attempt of each subagent label, as Claude Code's final record does.
- The plugin reads local files only. It sends nothing over the network.

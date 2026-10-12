# Claude Workflows for Paseo

A [Paseo](https://paseo.sh) plugin that adds a **Workflows** tab to a Claude Code agent's right pane, next to Files and Changes. It shows live progress of the agent's Claude Code Workflow runs: phases, subagent states, the current tool of each running subagent, elapsed time, tool calls and tokens.

Open it from the Command Center with **Show workflow runs** while an agent is focused.

## Requirements

- Paseo 0.11.1 or later
- Claude Code agents running on the same machine as the Paseo daemon

## Layout

| Path | What it does |
| --- | --- |
| `index.client.tsx` | Registers the agent panel and the Command Center item |
| `client/workflows-panel.tsx` | The panel UI; polls the RPC every 2 s with react-query |
| `index.server.ts` | Resolves the agent's Claude Code session id and answers the RPC |
| `server/workflows.ts` | Reads run state from `~/.claude/projects/*/<sessionId>/` |
| `server/jsonl-tail.ts` | Incremental JSONL reader, so polls only read new bytes |
| `server/script-meta.ts` | Reads `meta.phases` from the workflow script without running it |
| `shared/contract.ts` | RPC contract and zod schemas shared by both sides |

## Develop

```sh
npm install
npm run typecheck
paseo plugin install .            # first time
paseo plugin reload claude-workflows
paseo plugin logs claude-workflows
```

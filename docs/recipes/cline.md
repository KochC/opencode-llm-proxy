# Using opencode-llm-proxy with Cline

## What this gives you

Point [Cline](https://github.com/cline/cline) (the VS Code coding agent) at the proxy so it drives whatever model OpenCode has configured, with real client-executed tool calling for reading files, running commands, and editing code.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed (npm install, so `mcp-tool-bridge.js` is present)
- `node` on `PATH` where OpenCode runs (required for tool calling)
- Cline installed in VS Code

## Step 1: Start OpenCode with the proxy

```bash
opencode
```

The proxy listens on `http://127.0.0.1:4010`.

## Step 2: Configure Cline

In Cline's settings, choose an **OpenAI Compatible** provider:

- **Base URL**: `http://127.0.0.1:4010/v1`
- **API Key**: `unused` (or your `OPENCODE_LLM_PROXY_TOKEN`)
- **Model ID**: an OpenCode model ID, e.g. `github-copilot/claude-sonnet-4.6`

Pick a model that is strong at tool/function calling for best agent behavior.

## Step 3: Test it

Give Cline a small task ("list the files in this folder and summarize the README"). It should issue tool calls that the proxy translates through to the underlying model and hand back as `tool_calls`.

Verify available model IDs:

```bash
curl http://127.0.0.1:4010/v1/models | jq '.data[].id'
```

## Troubleshooting

- **Tool calls never happen**: ensure you installed the npm plugin (not a copied `index.js`) and that `node` is on `PATH` where OpenCode runs.
- **Concurrency limits**: heavy parallel agent use may exceed the tool-bridge pool. Raise `OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE` (default `8`).
- **Model not found**: use an exact ID from `/v1/models`.

## Security notes

- Agent tool calling executes actions — review Cline's auto-approve settings carefully.
- Keep the proxy on localhost unless you must expose it; then set a token and firewall rules.
- See [security.md](../security.md) for full guidance.

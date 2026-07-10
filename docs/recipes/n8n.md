# Using opencode-llm-proxy with n8n

## What this gives you

Use [n8n](https://n8n.io)'s native AI nodes (OpenAI Chat Model, Anthropic Chat Model, AI Agent) with whatever models OpenCode already has authenticated access to — GitHub Copilot, Anthropic, Bedrock, OpenRouter, local Ollama models, etc. — without configuring separate API keys inside n8n. Streaming and real tool/function calling work, so AI Agent nodes with attached Tools function correctly.

## Prerequisites

- OpenCode installed with at least one provider configured
- `opencode-llm-proxy` installed as an OpenCode plugin
- An n8n instance (self-hosted, Docker, or n8n Cloud with network access to the proxy host)
- `node` on `PATH` on the OpenCode host (required for tool calling)

## Step 1: Start OpenCode with the proxy

Because n8n usually reaches the proxy over the network, bind to all interfaces and set a bearer token:

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
opencode
```

The proxy now listens on port `4010` on every interface of that machine.

## Step 2: Configure n8n

Create a credential:

- **OpenAI**: Base URL `http://<opencode-host-ip>:4010/v1`, API Key = your token
- **Anthropic**: Base URL `http://<opencode-host-ip>:4010` (no `/v1` — the node appends `/v1/messages` itself), API Key = your token

Then add an **OpenAI Chat Model** (or **Anthropic Chat Model**) node using that credential. The model dropdown calls `GET /v1/models` on the proxy and auto-populates with every model OpenCode has connected — pick one directly (e.g. `github-copilot/claude-sonnet-4.6`, `anthropic/claude-3-5-sonnet`, `ollama/qwen2.5-coder`).

Wire the model into:

- a **Basic LLM Chain** node for simple prompt/response, or
- an **AI Agent** node with Tools attached (e.g. HTTP Request Tool) for agentic tool-using workflows.

## Step 3: Test it

Run the workflow. For a quick manual check from the n8n host:

```bash
curl http://<opencode-host-ip>:4010/v1/models \
  -H "Authorization: Bearer some-long-random-token"
```

You should see your OpenCode models in OpenAI list format.

## Troubleshooting

- **Model dropdown is empty**: the credential base URL or token is wrong, or the host is unreachable. Verify with the `curl` above from the n8n machine.
- **Docker on a different machine**: use the OpenCode host's actual LAN IP for `<opencode-host-ip>`. `localhost` and `host.docker.internal` only resolve to the OpenCode host when Docker runs on that same machine.
- **Connection silently dropped (macOS)**: the macOS Application Firewall will drop connections to the `opencode` binary until you allow it, even with the port open. Allow it under System Settings → Network → Firewall.
- **Tool calls not firing**: ensure `node` is on `PATH` where OpenCode runs, and that you installed the npm plugin (which includes `mcp-tool-bridge.js`), not just a copied `index.js`.

## Security notes

- Always set `OPENCODE_LLM_PROXY_TOKEN` when binding to `0.0.0.0`.
- Keep the proxy on your LAN; do not expose port `4010` to the public internet.
- Restrict inbound access with firewall rules to only the n8n host if possible.
- See [security.md](../security.md) for full guidance.

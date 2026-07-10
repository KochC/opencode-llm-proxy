# Using opencode-llm-proxy with Open WebUI

## What this gives you

Every model OpenCode has connected appears in Open WebUI's model picker through a single OpenAI-compatible connection — no per-model API keys inside Open WebUI. Streaming works; tool calling support depends on Open WebUI's own feature set.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed
- A running Open WebUI instance (native or Docker)

## Step 1: Start OpenCode with the proxy

Localhost is fine if Open WebUI runs on the same machine:

```bash
opencode
```

For Docker or a remote Open WebUI, bind to all interfaces and set a token:

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
opencode
```

## Step 2: Configure Open WebUI

1. Settings → Connections → OpenAI API
2. Set **API Base URL** to `http://127.0.0.1:4010/v1`
3. Leave API Key blank, or set it to your `OPENCODE_LLM_PROXY_TOKEN`
4. Save

Running Open WebUI in Docker on the same host? Use `http://host.docker.internal:4010/v1` and start the proxy with `OPENCODE_LLM_PROXY_HOST=0.0.0.0`. On a different host, use the OpenCode host's LAN IP.

## Step 3: Test it

All your OpenCode models should now appear in the model picker. Start a chat and send a message. You can also verify the connection directly:

```bash
curl http://127.0.0.1:4010/v1/models
```

## Troubleshooting

- **No models listed**: the base URL is wrong or the proxy is unreachable from the Open WebUI container/host. Confirm with the `curl` above from the same environment Open WebUI runs in.
- **Docker cannot reach the host**: use `host.docker.internal` (same machine) or the real LAN IP (different machine), and ensure the proxy is bound to `0.0.0.0`.
- **401 responses**: the API key in Open WebUI must match `OPENCODE_LLM_PROXY_TOKEN`.

## Security notes

- Set a token whenever the proxy is bound beyond `127.0.0.1`.
- Do not expose the proxy to the public internet.
- See [security.md](../security.md) for full guidance.

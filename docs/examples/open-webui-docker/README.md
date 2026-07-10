# Open WebUI + opencode-llm-proxy (Docker Compose)

Run [Open WebUI](https://github.com/open-webui/open-webui) in Docker and point it
at an `opencode-llm-proxy` instance so every model OpenCode has configured shows
up in Open WebUI's model picker — no per-model API keys inside Open WebUI.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed, running on the **host**
- Docker + Docker Compose

## 1. Start OpenCode with the proxy exposed

Open WebUI runs in a container, so it cannot reach `127.0.0.1` on the host.
Bind the proxy to all interfaces and set a bearer token:

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=change-me-to-a-long-random-token \
opencode
```

## 2. Configure the connection

Copy `.env.example` to `.env` and set the same token:

```bash
cp .env.example .env
# edit .env and set OPENCODE_LLM_PROXY_TOKEN
```

The compose file wires these into Open WebUI's OpenAI connection:

- `OPENAI_API_BASE_URL` → the proxy's `/v1` endpoint
- `OPENAI_API_KEY` → your bearer token

### Reaching the proxy from the container

| Where OpenCode runs | Use for `PROXY_HOST` |
|---|---|
| Same machine as Docker (Docker Desktop, macOS/Windows) | `host.docker.internal` |
| Same machine, Linux Docker Engine | your host's Docker bridge IP (often `172.17.0.1`) or use `extra_hosts` below |
| A different machine on your LAN | that machine's LAN IP, e.g. `192.168.1.50` |

The compose file below already adds `host.docker.internal` via `extra_hosts`, so
it works on Linux too when `PROXY_HOST=host.docker.internal`.

## 3. Start Open WebUI

```bash
docker compose up -d
```

Open http://localhost:3000, create the first account, and your OpenCode models
appear in the model picker.

## 4. Test it

From inside the container, confirm the proxy is reachable:

```bash
docker compose exec open-webui \
  curl -s http://${PROXY_HOST:-host.docker.internal}:4010/v1/models \
  -H "Authorization: Bearer $OPENCODE_LLM_PROXY_TOKEN" | head
```

## Troubleshooting

- **No models in picker**: the container can't reach the proxy. Re-run the test
  curl above; fix `PROXY_HOST` per the table.
- **`Connection refused`**: the proxy is bound to `127.0.0.1`. Restart OpenCode
  with `OPENCODE_LLM_PROXY_HOST=0.0.0.0`.
- **`401 Unauthorized`**: `.env` token doesn't match `OPENCODE_LLM_PROXY_TOKEN`.
- **macOS firewall**: allow the `opencode` binary (System Settings → Network →
  Firewall), or connections are silently dropped.
- **Linux, `host.docker.internal` unresolved**: keep the `extra_hosts` mapping in
  the compose file, or set `PROXY_HOST` to the host's LAN IP.

## Security notes

- Always set `OPENCODE_LLM_PROXY_TOKEN` when the proxy is bound beyond localhost.
- Keep the proxy on your LAN; do not expose port `4010` to the internet.
- See [../security.md](../security.md).

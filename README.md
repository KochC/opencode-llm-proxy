# opencode-llm-proxy

[![npm](https://img.shields.io/npm/v/opencode-llm-proxy)](https://www.npmjs.com/package/opencode-llm-proxy)
[![npm downloads](https://img.shields.io/npm/dm/opencode-llm-proxy)](https://www.npmjs.com/package/opencode-llm-proxy)
[![CI](https://github.com/KochC/opencode-llm-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/KochC/opencode-llm-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**One local endpoint. Every model you have access to. Any API format. Parallel tool calling included.**

opencode-llm-proxy is an [OpenCode](https://opencode.ai) plugin that starts a local HTTP server on `http://127.0.0.1:4010`. It translates between the API format your tool speaks and whichever LLM provider OpenCode has configured — so you never reconfigure the same models twice.

```
Your tool (OpenAI / Anthropic / Gemini SDK, coding agent, etc.)
         │
         ▼  http://127.0.0.1:4010
  opencode-llm-proxy
         │
         ▼  OpenCode SDK
  GitHub Copilot · Anthropic · Gemini · Ollama · OpenRouter · Bedrock · …
```

**Supported API formats — all with streaming and [tool/function calling](#tool-calling):**

| Format | Endpoint |
|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses API | `POST /v1/responses` |
| Anthropic Messages API | `POST /v1/messages` |
| Google Gemini | `POST /v1beta/models/:model:generateContent` |

**✨ Tool calling works with all four formats — including parallel tool calls.** Point a coding agent (Claude Code, Cursor, Continue, Cline, your own agent loop, ...) at the proxy and its `tools`/`tool_choice` calls are translated through to whatever model OpenCode has configured, with a real `tool_calls` / `tool_use` / `functionCall` response handed back — one call or **several in a single turn**. See [Tool calling](#tool-calling).

---

## Works with

| Tool / Client | API mode | Streaming | Tool calling | Notes |
|---|---|---:|---:|---|
| n8n AI Agent | OpenAI / Anthropic | yes | yes | Use native Chat Model credentials pointed at the proxy. See [recipe](docs/recipes/n8n.md) |
| Open WebUI | OpenAI-compatible | yes | partial | Depends on Open WebUI feature support. See [recipe](docs/recipes/open-webui.md) |
| LangChain | OpenAI / Anthropic | yes | yes | Works with normal SDK wrappers. See [recipe](docs/recipes/langchain.md) |
| OpenAI SDK | Chat Completions / Responses | yes | yes | Use `baseURL` / `base_url` |
| Anthropic SDK | Messages API | yes | yes | Use proxy base URL |
| Gemini clients | Gemini-compatible | yes | yes | Use `/v1beta/models/...` endpoints |
| Continue | OpenAI-compatible | yes | not primary | Good for editor model access. See [recipe](docs/recipes/continue.md) |
| Zed | OpenAI-compatible | yes | not primary | Good for editor model access. See [recipe](docs/recipes/zed.md) |
| Custom coding agents | OpenAI / Anthropic / Gemini | yes | yes | Best fit for client-executed tools. See [recipe](docs/recipes/custom-agent.md) |

### SDKs & clients

| Client | Endpoint type | Streaming | Tool calling | Notes |
|---|---|---:|---:|---|
| OpenAI SDK (JS/TS) | Chat Completions / Responses | yes | yes | Set `baseURL: ".../v1"` |
| OpenAI SDK (Python) | Chat Completions / Responses | yes | yes | Set `base_url=".../v1"` |
| Anthropic SDK (JS/TS) | Messages | yes | yes | Set `baseURL` to the proxy root (no `/v1`) |
| Anthropic SDK (Python) | Messages | yes | yes | Set `base_url` to the proxy root (no `/v1`) |
| Google Generative AI (JS) | Gemini `/v1beta` | yes | yes | Set `baseUrl` to the proxy root |
| LangChain | OpenAI / Anthropic wrappers | yes | yes | `.bind_tools()` supported. See [recipe](docs/recipes/langchain.md) |
| n8n | OpenAI / Anthropic | yes | yes | Native Chat Model + AI Agent nodes. See [recipe](docs/recipes/n8n.md) |
| Open WebUI | OpenAI-compatible | yes | partial | Depends on Open WebUI feature support. See [recipe](docs/recipes/open-webui.md) |
| Continue | OpenAI-compatible | yes | not primary | Editor chat/edit. See [recipe](docs/recipes/continue.md) |
| Zed | OpenAI-compatible | yes | not primary | Editor chat/edit. See [recipe](docs/recipes/zed.md) |

See also: [Security](docs/security.md) · [Comparisons](docs/comparisons.md) · [All recipes](docs/recipes/)

---

## Contents

- [Why](#why)
- [Quickstart](#quickstart)
- [Install](#install)
- [Configuration](#configuration)
- [Tool calling](#tool-calling)
- [Using with SDKs and tools](#using-with-sdks-and-tools)
  - [n8n](#n8n)
- [Recipes](docs/recipes/)
- [Security](docs/security.md)
- [Comparisons](docs/comparisons.md)
- [Finding model IDs](#finding-model-ids)
- [API reference](#api-reference)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [License](#license)

---

## Why

Most LLM tools speak exactly one API dialect. OpenCode already manages connections to every provider you use. This proxy bridges the two — your tools keep working as-is, and you change which model they use in one place.

**Common situations it solves:**

- You have a **GitHub Copilot** subscription. Open WebUI, Chatbox, or a VS Code extension only accepts an OpenAI-compatible URL. Point them at the proxy — done.
- You run **Ollama** locally. Your Python scripts use the OpenAI SDK. Set `base_url` to the proxy and use your Ollama model IDs directly.
- You want to **swap models without code changes**. Your app talks to the proxy; you change the model in OpenCode config.
- You want to **share your models on a LAN**. Expose the proxy on `0.0.0.0` and give teammates the URL.
- You use the **Anthropic SDK** but want to route through GitHub Copilot or Bedrock. No code change in the SDK — just point it at the proxy.
- You're building or running a **coding agent** that needs real tool/function calling (read files, run shell commands, etc.) against whatever model OpenCode has configured. See [Tool calling](#tool-calling).
- You run **n8n** (self-hosted or in Docker, possibly on a different machine on your LAN) and want its AI nodes to use whatever models OpenCode already has authenticated access to — GitHub Copilot, Anthropic, Bedrock, local Ollama models, etc. — without giving n8n its own separate API keys. Point n8n's native OpenAI/Anthropic credentials at the proxy. See [n8n](#n8n).

---

## Quickstart

```bash
npm install opencode-llm-proxy
```

Add to `opencode.json`:

```json
{
  "plugin": ["opencode-llm-proxy"]
}
```

Start OpenCode — the proxy starts automatically:

```bash
opencode
```

This package is an OpenCode plugin, not a standalone server. It intentionally has no `npm start` command; load it through OpenCode as shown above.

Send a request:

```bash
curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "github-copilot/claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## Install

### npm plugin (recommended)

```bash
npm install opencode-llm-proxy
```

Add to your global `~/.config/opencode/opencode.json` (works everywhere) or a project-level `opencode.json`:

```json
{
  "plugin": ["opencode-llm-proxy"]
}
```

### Copy the file

**Global** — loaded for every OpenCode session:

```bash
curl -o ~/.config/opencode/plugins/llm-proxy.js \
  https://raw.githubusercontent.com/KochC/opencode-llm-proxy/main/dist/llm-proxy.js
```

**Per-project** — loaded only in this directory:

```bash
mkdir -p .opencode/plugins
curl -o .opencode/plugins/llm-proxy.js \
  https://raw.githubusercontent.com/KochC/opencode-llm-proxy/main/dist/llm-proxy.js
```

> The bundled file contains all proxy runtime modules. [Tool calling](#tool-calling) also needs `mcp-tool-bridge.js` alongside it, so use the npm install method for tool-using clients.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_LLM_PROXY_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to expose on LAN or Docker. |
| `OPENCODE_LLM_PROXY_PORT` | `4010` | TCP port. |
| `OPENCODE_LLM_PROXY_TOKEN` | _(unset)_ | Single accepted bearer token. A token is required when binding beyond loopback. |
| `OPENCODE_LLM_PROXY_TOKENS` | `[]` | JSON array of additional accepted bearer-token strings. |
| `OPENCODE_LLM_PROXY_CORS_ORIGINS` | `[]` | JSON array of allowed browser origins. Browser cross-origin requests are denied by default; use `"*"` explicitly to allow all. |
| `OPENCODE_LLM_PROXY_CORS_ORIGIN` | _(unset)_ | Legacy single origin appended to the CORS allowlist. |
| `OPENCODE_LLM_PROXY_ALLOW_PRIVATE_NETWORK` | `false` | Set to `true` to allow browser Private Network Access preflights. |
| `OPENCODE_LLM_PROXY_REQUEST_TIMEOUT_MS` | `120000` | Total request timeout, from 1 to 3,600,000 ms. |
| `OPENCODE_LLM_PROXY_MAX_REQUEST_BYTES` | `1048576` | Maximum JSON request body and embedded data-URL size, up to 100 MiB. |
| `OPENCODE_LLM_PROXY_MAX_CONCURRENT_REQUESTS` | `8` | Maximum active POST requests. |
| `OPENCODE_LLM_PROXY_MAX_QUEUED_REQUESTS` | `32` | Maximum POST requests waiting for capacity; excess requests receive `503`. |
| `OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE` | `8` | Max concurrent in-flight requests using [tool calling](#tool-calling). |
| `OPENCODE_LLM_PROXY_TOOL_BRIDGE_ACQUIRE_TIMEOUT_MS` | `10000` | Maximum wait for a tool-bridge slot, from 1 to 3,600,000 ms. |
| `OPENCODE_LLM_PROXY_TOOL_BRIDGE_MAX_QUEUE` | `32` | Maximum tool-calling requests waiting for a bridge slot, from 0 to 10,000; excess requests receive `429`. |
| `OPENCODE_LLM_PROXY_KEEP_SESSIONS` | `false` | Set to `true` to retain temporary OpenCode sessions; otherwise they are deleted after use. |
| `OPENCODE_LLM_PROXY_MODEL_ALIASES` | `{}` | JSON object mapping aliases to a model ID string or ordered array of fallback model IDs. |
| `OPENCODE_LLM_PROXY_METRICS_ENABLED` | `false` | Set to `true` to expose the authenticated Prometheus endpoint at `GET /metrics`. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_ENABLED` | `false` | Set to `true` to fetch remote media URLs and convert them to embedded data URLs. Leave disabled unless required. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_ALLOWED_SCHEMES` | `["https"]` | JSON array of allowed remote URL schemes (`https` and, if explicitly enabled, `http`). HTTPS-only is strongly recommended. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_BYTES` | value of `OPENCODE_LLM_PROXY_MAX_REQUEST_BYTES` (`1048576` by default) | Maximum downloaded bytes per remote media item, up to 100 MiB. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_ITEMS` | `4` | Maximum remote media downloads in one request, from 0 to 10,000. |
| `OPENCODE_LLM_PROXY_MAX_MEDIA_ITEMS` | `64` | Maximum total embedded and remote media items in one request. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_REDIRECTS` | `3` | Maximum redirects per remote media download, from 0 to 100. |
| `OPENCODE_LLM_PROXY_REMOTE_MEDIA_TIMEOUT_MS` | `10000` | Total remote-media preparation timeout, including DNS and all items, from 1 to 3,600,000 ms. |

Use `x-opencode-variant` to select an OpenCode model variant for a request. The proxy accepts multimodal image, document, and file inputs in each API's native content shape, using embedded data URLs and validating model capabilities. Remote URLs are rejected unless the SSRF-safe remote-media fetcher is explicitly enabled; fetched content is converted to a data URL before it reaches OpenCode. Structured JSON output is supported through OpenAI `response_format.json_schema`, Responses API `text.format.schema`, and Gemini `generationConfig.responseSchema`.

Generation `temperature`, top-p (`top_p`/`topP`), and top-k (`topK`) values are validated and applied through the plugin's `chat.params` hook. Maximum-token fields (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, and Gemini `maxOutputTokens`) are accepted where clients require them, but the current OpenCode SDK cannot enforce them. OpenAI and Anthropic requests reject unsupported controls (`stop`, `seed`, `frequency_penalty`, `presence_penalty`, `logprobs`, and `n`) with `400` instead of silently ignoring them.

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=my-secret \
opencode
```

---

## Tool calling

The proxy supports real tool/function calling on **all four API formats** — OpenAI function tools (`tools` on `/v1/chat/completions` and `/v1/responses`), Anthropic tools (`tools` on `/v1/messages`), and Gemini function declarations (`tools` on `:generateContent`/`:streamGenerateContent`). This is what lets coding agents and other tool-using clients work through the proxy, not just plain chat.

```bash
curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "github-copilot/claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "What is the weather in NYC?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }]
  }'
```

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"NYC\"}" }
      }]
    }
  }]
}
```

Send the tool's result back on your next request (`role: "tool"` / `tool_result` / `functionResponse`, per your API's convention) alongside the full conversation history, same as any other multi-turn request — the proxy is stateless between calls either way.

### Parallel tool calls

When the model decides to call several tools at once, you get **all of them back in a single response** — a `tool_calls` array (OpenAI), multiple `tool_use` blocks (Anthropic), or multiple `functionCall` parts (Gemini), streaming or not. Ask a model for the weather in Paris *and* Tokyo and you'll get two fully-formed calls with their own IDs and arguments, ready to execute in parallel:

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } },
        { "id": "call_2", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Tokyo\"}" } }
      ]
    }
  }]
}
```

### How tool calling works under the hood

OpenCode's own agent loop always executes tools itself, server-side, so there's no native concept of a "client-executed" tool call to hand off to. To bridge that gap, when a request includes `tools`:

1. The proxy dynamically registers a small local [MCP](https://opencode.ai/docs/mcp-servers/) server whose tool list is exactly your declared tool schemas (see `mcp-tool-bridge.js`).
2. Only those tools are enabled for that one prompt call — every built-in OpenCode tool stays disabled, same as always.
3. The proxy watches OpenCode's live event stream and captures every tool call the model proposes in that turn — with its fully-populated arguments — then aborts the session the moment the tool-calling step finishes, before OpenCode acts on the bridge's no-op results. The captured calls are translated into your API's tool-call shape — `tool_calls` (OpenAI), `tool_use` (Anthropic), or `functionCall` parts (Gemini) — instead of a text answer.

### Notes and current limitations

- Parallel tool calls in a single turn are fully supported across all four API formats (streaming and non-streaming).
- `tool_choice: "none"` (OpenAI/Gemini `mode: "NONE"`/Anthropic `type: "none"`) disables tool calling for that request; forcing a specific named tool is supported.
- Bridge servers are reused from a small fixed-size pool (`px_tools_0`, `px_tools_1`, ...) rather than registered fresh per request, since OpenCode's server API has no endpoint to deregister an MCP server once added. Configure the pool size with `OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE` (default `8`) if you expect more than 8 concurrent in-flight tool-calling requests.
- At most `OPENCODE_LLM_PROXY_TOOL_BRIDGE_MAX_QUEUE` requests wait for a bridge slot. A request arriving when that queue is full receives `429`; a queued request that exceeds the bridge acquisition timeout receives `503`.
- The bridge process is spawned with `node`, so `node` must be on `PATH` wherever OpenCode is running.

---

## Using with SDKs and tools

### OpenAI SDK (JS/TS)

```javascript
import OpenAI from "openai"

const client = new OpenAI({
  baseURL: "http://127.0.0.1:4010/v1",
  apiKey: "unused",
})

const response = await client.chat.completions.create({
  model: "github-copilot/claude-sonnet-4.6",
  messages: [{ role: "user", content: "Explain recursion." }],
})
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4010/v1", api_key="unused")

response = client.chat.completions.create(
    model="ollama/qwen2.5-coder",
    messages=[{"role": "user", "content": "Write a Python function to reverse a string."}],
)
print(response.choices[0].message.content)
```

### Anthropic SDK (Python)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:4010",
    api_key="unused",
)

message = client.messages.create(
    model="anthropic/claude-3-5-sonnet",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What is the Pythagorean theorem?"}],
)
print(message.content[0].text)
```

### Anthropic SDK (JS/TS)

```javascript
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  baseURL: "http://127.0.0.1:4010",
  apiKey: "unused",
})

const message = await client.messages.create({
  model: "anthropic/claude-opus-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Explain async/await." }],
})
```

### Google Generative AI SDK (JS/TS)

```javascript
import { GoogleGenerativeAI } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI("unused", {
  baseUrl: "http://127.0.0.1:4010",
})

const model = genAI.getGenerativeModel({ model: "google/gemini-2.0-flash" })
const result = await model.generateContent("What is machine learning?")
console.log(result.response.text())
```

### LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="anthropic/claude-3-5-sonnet",
    openai_api_base="http://127.0.0.1:4010/v1",
    openai_api_key="unused",
)

response = llm.invoke("What are the SOLID principles?")
print(response.content)
```

### Open WebUI

1. Settings → Connections → OpenAI API
2. Set **API Base URL** to `http://127.0.0.1:4010/v1`
3. Leave API Key blank (or set to your `OPENCODE_LLM_PROXY_TOKEN`)
4. Save — all your OpenCode models appear in the model picker

> Running Open WebUI in Docker? Use `http://host.docker.internal:4010/v1` and set `OPENCODE_LLM_PROXY_HOST=0.0.0.0`.

### n8n

The proxy lets [n8n](https://n8n.io)'s native AI nodes use whatever models OpenCode already has authenticated access to — GitHub Copilot, Anthropic, Bedrock, local Ollama models, etc. — without configuring separate API keys in n8n at all. This works with n8n's regular LangChain-based Chat Model nodes, **including real tool/function calling** (e.g. an "AI Agent" node with a Tool attached) since [Tool calling](#tool-calling) support was added.

1. In OpenCode, expose the proxy on your LAN instead of just localhost, and set a bearer token since it'll be network-reachable:
   ```bash
   OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
   OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
   opencode
   ```
2. In n8n, create a credential:
   - **OpenAI**: Base URL `http://<opencode-host-ip>:4010/v1`, API Key = your token
   - **Anthropic**: Base URL `http://<opencode-host-ip>:4010` (no `/v1` — the node adds `/v1/messages` itself), API Key = your token
3. Add an **OpenAI Chat Model** (or **Anthropic Chat Model**) node using that credential. The model dropdown calls `GET /v1/models` on the proxy, so it auto-populates with every model OpenCode has connected (`github-copilot/claude-sonnet-5`, `anthropic/claude-3-5-sonnet`, `ollama/qwen2.5-coder`, ...) — pick one directly, no manual typing needed.
4. Wire it into a **Basic LLM Chain** node for simple prompt/response use, or an **AI Agent** node (with Tools attached, e.g. an HTTP Request Tool) for agentic tool-using workflows.

> n8n running in Docker on a **different machine** on your LAN (a common setup)? Use that machine's actual LAN IP for `<opencode-host-ip>` — not `localhost`/`host.docker.internal`, which only resolve to the OpenCode host if Docker is running on that same machine. Make sure your firewall allows incoming connections to the `opencode` binary (macOS's Application Firewall in particular will silently drop connections from an app it hasn't been told to allow, even with the port open).

### Chatbox

Settings → AI Provider → OpenAI API → set **API Host** to `http://127.0.0.1:4010`.

### Continue (VS Code / JetBrains)

In `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "Claude via OpenCode",
      "provider": "openai",
      "model": "anthropic/claude-3-5-sonnet",
      "apiBase": "http://127.0.0.1:4010/v1",
      "apiKey": "unused"
    }
  ]
}
```

### Zed

In `~/.config/zed/settings.json`:

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://127.0.0.1:4010/v1",
      "available_models": [
        {
          "name": "github-copilot/claude-sonnet-4.6",
          "display_name": "Claude (OpenCode)",
          "max_tokens": 8096
        }
      ]
    }
  }
}
```

---

## Finding model IDs

```bash
curl http://127.0.0.1:4010/v1/models | jq '.data[].id'
# "github-copilot/claude-sonnet-4.6"
# "anthropic/claude-3-5-sonnet"
# "ollama/qwen2.5-coder"
# ...
```

Use `provider/model` for clarity. Bare model IDs (e.g. `gpt-4o`) work if unambiguous across your providers.

To force a specific provider without changing the model string, add:

```
x-opencode-provider: anthropic
```

---

## API reference

### GET /health
```json
{ "healthy": true, "service": "opencode-openai-proxy" }
```

### GET /v1/models
Returns all models from all configured providers in OpenAI list format.

### GET /metrics
When `OPENCODE_LLM_PROXY_METRICS_ENABLED=true`, returns Prometheus text exposition data. The endpoint uses the same bearer-token authentication as every other route and is not registered when disabled.

Metrics cover HTTP request counts and duration by bounded method/route/status labels, active and queued requests, upstream attempt outcomes, input/output token totals, and remote-media request outcomes, bytes, redirects, in-flight fetches, and duration. Streaming HTTP duration is recorded when the stream finishes, errors, or is cancelled.

### POST /v1/chat/completions
OpenAI Chat Completions. Required: `model`, `messages`. Supported optional fields include `stream`, `temperature`, `top_p`, `topK`, `max_tokens`, `max_completion_tokens`, `tools`, `tool_choice`, `response_format.json_schema`, and compatible multimodal content parts. Maximum-token fields are accepted for client compatibility but are not enforceable.

### POST /v1/responses
OpenAI Responses API. Required: `model`, `input`. Supported optional fields include `instructions`, `stream`, `temperature`, `top_p`, `topK`, `max_output_tokens`, `tools`, `tool_choice`, `text.format.schema`, and compatible multimodal input items. `max_output_tokens` is accepted for client compatibility but is not enforceable.

### POST /v1/messages
Anthropic Messages API. Required: `model`, `messages`. Supported optional fields include `system` (string or an array of `{type: "text", text: string}` blocks), `max_tokens`, `stream`, `temperature`, `top_p`, `topK`, `tools`, `tool_choice`, and native image/document blocks. `max_tokens` is accepted for required Anthropic client compatibility but is not enforceable.

Errors are returned in Anthropic format: `{ "type": "error", "error": { "type": "...", "message": "..." } }`.

### POST /v1beta/models/:model:generateContent
Google Gemini non-streaming. Model name in URL path. Required: `contents`. Supported optional fields include `systemInstruction`, `generationConfig` (`temperature`, `topP`, `topK`, `maxOutputTokens`, and `responseSchema`), `tools`, `toolConfig`, and native inline/file media parts. `maxOutputTokens` is accepted but is not enforceable.

### POST /v1beta/models/:model:streamGenerateContent
Same as above, returning a newline-delimited JSON stream. A tool-using turn may emit intermediate text chunks followed by a final chunk containing one or more `functionCall` parts.

---

## How it works

Each request:

1. Is authenticated if either token setting is configured; non-loopback binding requires a token
2. Has its model resolved — `provider/model`, bare model ID, or Gemini URL path
3. Canonicalizes the native conversation, preserving roles, ordered text/media, tool calls, tool IDs, arguments, and tool results
4. Renders complex history as deterministic JSON Lines because OpenCode accepts one user prompt, keeping each original message as a structured JSON object rather than flattening or relabeling it; a lone user text remains plain text
5. Associates every attached file with its exact position in that JSON Lines history through a zero-based `fileIndex`, including media nested in tool results
6. Creates a temporary OpenCode session and deletes it after use unless `OPENCODE_LLM_PROXY_KEEP_SESSIONS=true`
7. Sends the single rendered prompt via `client.session.prompt` / `client.session.promptAsync`
8. Returns the response in the same format as the request

Streaming uses OpenCode's `client.event.subscribe()` SSE stream. Text deltas are forwarded in real time, and the upstream async iterator is explicitly closed on completion, error, cancellation, or early tool-call termination.

---

## Compatibility

The plugin ships a V1 plugin descriptor (`export default { id, server }`). OpenCode detects it (present in every release checked back to 1.15) and loads the plugin cleanly. On older builds the legacy loader probes every exported function, so you may see a harmless `failed to load plugin ... is not a function` line per worker in the startup log — the proxy still starts and serves normally.

---

## Limitations

- Media support depends on the selected model's advertised image, audio, video, and PDF/file capabilities
- Remote media fetching is disabled by default and should remain disabled unless URL inputs are required; see [Security](docs/security.md)
- No cross-request session state — send full conversation history on every request
- `temperature`, top-p (`top_p`/`topP`), and top-k (`topK`) are applied through OpenCode's plugin hook. Maximum-token controls are accepted for client compatibility but cannot be enforced by the current OpenCode SDK.
- Tool calling supports parallel calls in a single turn — see [Tool calling](#tool-calling) above

---

## License

MIT

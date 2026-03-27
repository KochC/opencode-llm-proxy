# opencode-llm-proxy

[![npm](https://img.shields.io/npm/v/opencode-llm-proxy)](https://www.npmjs.com/package/opencode-llm-proxy)
[![npm downloads](https://img.shields.io/npm/dm/opencode-llm-proxy)](https://www.npmjs.com/package/opencode-llm-proxy)
[![CI](https://github.com/KochC/opencode-llm-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/KochC/opencode-llm-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**One local endpoint. Every model you have access to. Any API format.**

opencode-llm-proxy is an [OpenCode](https://opencode.ai) plugin that starts a local HTTP server on `http://127.0.0.1:4010`. It translates between the API format your tool speaks and whichever LLM provider OpenCode has configured — so you never reconfigure the same models twice.

```
Your tool (OpenAI / Anthropic / Gemini SDK)
         │
         ▼  http://127.0.0.1:4010
  opencode-llm-proxy
         │
         ▼  OpenCode SDK
  GitHub Copilot · Anthropic · Gemini · Ollama · OpenRouter · Bedrock · …
```

**Supported API formats — all with streaming:**

| Format | Endpoint |
|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses API | `POST /v1/responses` |
| Anthropic Messages API | `POST /v1/messages` |
| Google Gemini | `POST /v1beta/models/:model:generateContent` |

---

## Why

Most LLM tools speak exactly one API dialect. OpenCode already manages connections to every provider you use. This proxy bridges the two — your tools keep working as-is, and you change which model they use in one place.

**Common situations it solves:**

- You have a **GitHub Copilot** subscription. Open WebUI, Chatbox, or a VS Code extension only accepts an OpenAI-compatible URL. Point them at the proxy — done.
- You run **Ollama** locally. Your Python scripts use the OpenAI SDK. Set `base_url` to the proxy and use your Ollama model IDs directly.
- You want to **swap models without code changes**. Your app talks to the proxy; you change the model in OpenCode config.
- You want to **share your models on a LAN**. Expose the proxy on `0.0.0.0` and give teammates the URL.
- You use the **Anthropic SDK** but want to route through GitHub Copilot or Bedrock. No code change in the SDK — just point it at the proxy.

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
  https://raw.githubusercontent.com/KochC/opencode-llm-proxy/main/index.js
```

**Per-project** — loaded only in this directory:

```bash
mkdir -p .opencode/plugins
curl -o .opencode/plugins/llm-proxy.js \
  https://raw.githubusercontent.com/KochC/opencode-llm-proxy/main/index.js
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_LLM_PROXY_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to expose on LAN or Docker. |
| `OPENCODE_LLM_PROXY_PORT` | `4010` | TCP port. |
| `OPENCODE_LLM_PROXY_TOKEN` | _(unset)_ | Bearer token required on every request. Unset = no auth. |
| `OPENCODE_LLM_PROXY_CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` value for browser clients. |

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=my-secret \
opencode
```

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

### POST /v1/chat/completions
OpenAI Chat Completions. Required fields: `model`, `messages`. Optional: `stream`, `temperature`, `max_tokens`.

### POST /v1/responses
OpenAI Responses API. Required fields: `model`, `input`. Optional: `instructions`, `stream`, `max_output_tokens`.

### POST /v1/messages
Anthropic Messages API. Required fields: `model`, `messages`. Optional: `system`, `max_tokens`, `stream`.

Errors are returned in Anthropic format: `{ "type": "error", "error": { "type": "...", "message": "..." } }`.

### POST /v1beta/models/:model:generateContent
Google Gemini non-streaming. Model name in URL path. Required field: `contents`. Optional: `systemInstruction`, `generationConfig`.

### POST /v1beta/models/:model:streamGenerateContent
Same as above, returns newline-delimited JSON stream.

---

## How it works

Each request:

1. Is authenticated if `OPENCODE_LLM_PROXY_TOKEN` is set
2. Has its model resolved — `provider/model`, bare model ID, or Gemini URL path
3. Creates a temporary OpenCode session (visible in the session list)
4. Sends the prompt via `client.session.prompt` / `client.session.promptAsync`
5. Returns the response in the same format as the request

Streaming uses OpenCode's `client.event.subscribe()` SSE stream. Text deltas are forwarded in real time.

---

## Limitations

- Text only — image, audio, and file inputs are ignored
- No tool/function calling — all OpenCode tools are disabled for proxy sessions
- No cross-request session state — send full conversation history on every request
- Temperature and max tokens are advisory (passed as system prompt hints)

---

## License

MIT

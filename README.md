# opencode-llm-proxy

An [OpenCode](https://opencode.ai) plugin that starts a local HTTP server backed by your OpenCode providers, with support for multiple LLM API formats:

- **OpenAI** Chat Completions (`POST /v1/chat/completions`) and Responses (`POST /v1/responses`)
- **Anthropic** Messages API (`POST /v1/messages`)
- **Google Gemini** API (`POST /v1beta/models/:model:generateContent`)

Any tool or SDK that targets one of these APIs can point at the proxy without code changes.

## Quickstart

```bash
# 1. Install the npm package
npm install opencode-llm-proxy

# 2. Register the plugin in your opencode.json
#    (or use one of the manual install methods below)
```

Add to `opencode.json`:

```json
{
  "plugin": ["opencode-llm-proxy"]
}
```

Then start OpenCode — the proxy starts automatically:

```bash
opencode
# Proxy is now listening on http://127.0.0.1:4010
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

## Install

### As an npm plugin (recommended)

```bash
npm install opencode-llm-proxy
```

Add to `opencode.json`:

```json
{
  "plugin": ["opencode-llm-proxy"]
}
```

### As a global OpenCode plugin

Copy `index.js` to your global plugin directory:

```bash
cp index.js ~/.config/opencode/plugins/openai-proxy.js
```

The plugin is loaded automatically every time OpenCode starts.

### As a project plugin

Copy `index.js` to your project's plugin directory:

```bash
cp index.js .opencode/plugins/openai-proxy.js
```

## Usage

Start OpenCode normally. The proxy server starts automatically in the background:

```
opencode
```

The server listens on `http://127.0.0.1:4010` by default.

### List available models

```bash
curl http://127.0.0.1:4010/v1/models
```

Returns all models from all providers configured in your OpenCode setup (e.g. `github-copilot/claude-sonnet-4.6`, `ollama/qwen3.5:9b`, etc.).

### OpenAI Chat Completions

```bash
curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "github-copilot/claude-sonnet-4.6",
    "messages": [
      {"role": "user", "content": "Write a haiku about OpenCode."}
    ]
  }'
```

Use the fully-qualified `provider/model` ID from `GET /v1/models`. Supports `"stream": true` for SSE streaming.

### OpenAI Responses API

```bash
curl http://127.0.0.1:4010/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "github-copilot/claude-sonnet-4.6",
    "input": [{"role": "user", "content": "Hello"}]
  }'
```

Supports `"stream": true` for SSE streaming.

### Anthropic Messages API

Point the Anthropic SDK (or any client) at this proxy:

```bash
curl http://127.0.0.1:4010/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-3-5-sonnet",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Supports `"stream": true` for SSE streaming with standard Anthropic streaming events (`message_start`, `content_block_delta`, `message_stop`, etc.).

To point the official Anthropic SDK at this proxy:

```js
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  baseURL: "http://127.0.0.1:4010",
  apiKey: "unused", // or your OPENCODE_LLM_PROXY_TOKEN
})
```

### Google Gemini API

```bash
# Non-streaming
curl http://127.0.0.1:4010/v1beta/models/google/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
  }'

# Streaming (newline-delimited JSON)
curl http://127.0.0.1:4010/v1beta/models/google/gemini-2.0-flash:streamGenerateContent \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
  }'
```

The model name in the URL path is resolved the same way as other endpoints (use `provider/model` or a bare model ID if unambiguous).

To point the Google Generative AI SDK at this proxy, set the `baseUrl` option to `http://127.0.0.1:4010`.

## Selecting a provider

All endpoints accept an optional `x-opencode-provider` header to force a specific provider when the model ID is ambiguous:

```bash
curl http://127.0.0.1:4010/v1/chat/completions \
  -H "x-opencode-provider: anthropic" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet", "messages": [...]}'
```

## Configuration

All configuration is done through environment variables. No configuration file is needed.

| Variable | Type | Default | Description |
|---|---|---|---|
| `OPENCODE_LLM_PROXY_HOST` | string | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on LAN. |
| `OPENCODE_LLM_PROXY_PORT` | integer | `4010` | TCP port the proxy listens on. |
| `OPENCODE_LLM_PROXY_TOKEN` | string | _(unset)_ | Optional bearer token. When set, every request must include `Authorization: Bearer <token>`. Unset means no authentication required. |
| `OPENCODE_LLM_PROXY_CORS_ORIGIN` | string | `*` | Value of the `Access-Control-Allow-Origin` response header. Use a specific origin (e.g. `https://app.example.com`) when browser clients send credentials. |

The proxy adds CORS headers to all responses and handles `OPTIONS` preflight requests automatically.

### LAN example

```bash
export OPENCODE_LLM_PROXY_HOST=0.0.0.0
export OPENCODE_LLM_PROXY_PORT=4010
export OPENCODE_LLM_PROXY_TOKEN=my-secret-token
opencode
```

Then from another machine:

```bash
curl http://<your-ip>:4010/v1/models \
  -H "Authorization: Bearer my-secret-token"
```

## How it works

The plugin hooks into OpenCode at startup and spawns a Bun HTTP server. Incoming requests (in OpenAI, Anthropic, or Gemini format) are translated into OpenCode SDK calls (`client.session.create` + `client.session.prompt`), routed through whichever provider/model is requested, and the response is returned in the matching API format.

Each request creates a temporary OpenCode session, so prompts and responses appear in the OpenCode session list.

## Limitations

- Tool/function calling is not forwarded; all built-in OpenCode tools are disabled for proxy sessions.
- Only text content is handled; image and file inputs are ignored.

## License

MIT

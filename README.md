# opencode-llm-proxy

An [OpenCode](https://opencode.ai) plugin that starts a local OpenAI-compatible HTTP server backed by your OpenCode providers.

Any tool or application that speaks the OpenAI Chat Completions or Responses API can use it — including LangChain, custom scripts, local frontends, etc.

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

### Chat completions

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

Use the fully-qualified `provider/model` ID from `GET /v1/models`.

### OpenAI Responses API

```bash
curl http://127.0.0.1:4010/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "github-copilot/claude-sonnet-4.6",
    "input": [{"role": "user", "content": "Hello"}]
  }'
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

The plugin hooks into OpenCode at startup and spawns a Bun HTTP server. Incoming OpenAI-format requests are translated into OpenCode SDK calls (`client.session.create` + `client.session.prompt`), routed through whichever provider/model is requested, and the response is returned in OpenAI format.

Each request creates a temporary OpenCode session, so prompts and responses appear in the OpenCode session list.

## Limitations

- Streaming (`"stream": true`) is not yet implemented — requests will return a 400 error.
- Tool/function calling is not forwarded; all built-in OpenCode tools are disabled for proxy sessions.
- The proxy only handles `POST /v1/chat/completions` and `POST /v1/responses`. Other OpenAI endpoints are not implemented.

## License

MIT

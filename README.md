# opencode-openai-proxy

An [OpenCode](https://opencode.ai) plugin that starts a local OpenAI-compatible HTTP server backed by your OpenCode providers.

Any tool or application that speaks the OpenAI Chat Completions or Responses API can use it — including the Agile-V Studio platform, LangChain, custom scripts, etc.

## Install

### As a global OpenCode plugin (recommended)

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

### As an npm plugin

Add it to your `opencode.json`:

```json
{
  "plugin": ["opencode-openai-proxy"]
}
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

| Environment variable | Default | Description |
|---|---|---|
| `OPENCODE_LLM_PROXY_HOST` | `127.0.0.1` | Bind host. Set to `0.0.0.0` to expose on LAN. |
| `OPENCODE_LLM_PROXY_PORT` | `4010` | Bind port. |
| `OPENCODE_LLM_PROXY_TOKEN` | _(none)_ | Optional bearer token. If set, all requests must include `Authorization: Bearer <token>`. |
| `OPENCODE_LLM_PROXY_CORS_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` header value. Use a specific origin if browser clients send credentials. |

The proxy answers browser preflight requests and adds CORS headers on success and error responses for `/health`, `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.

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

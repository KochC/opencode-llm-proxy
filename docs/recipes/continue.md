# Using opencode-llm-proxy with Continue

## What this gives you

Use any model OpenCode has configured inside the [Continue](https://continue.dev) VS Code or JetBrains extension through its OpenAI-compatible provider. Good for chat and edit; tool calling is not Continue's primary path.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed
- Continue installed in VS Code or a JetBrains IDE

## Step 1: Start OpenCode with the proxy

```bash
opencode
```

The proxy listens on `http://127.0.0.1:4010`.

## Step 2: Configure Continue

Edit `~/.continue/config.json`:

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

Add more entries for additional models — each `model` value is an OpenCode model ID.

## Step 3: Test it

Reload the window, open the Continue panel, select "Claude via OpenCode", and send a prompt. Verify the backend separately if needed:

```bash
curl http://127.0.0.1:4010/v1/models | jq '.data[].id'
```

## Troubleshooting

- **Model missing from picker**: confirm the entry saved in `config.json` and that `model` is a valid OpenCode ID.
- **Requests fail**: check `curl http://127.0.0.1:4010/health` and that OpenCode is running.
- **401**: set `apiKey` to your `OPENCODE_LLM_PROXY_TOKEN` if one is configured.

## Security notes

- Localhost binding is fine for editor use.
- Only expose the proxy on a LAN with a token if you specifically need remote access.
- See [security.md](../security.md) for full guidance.

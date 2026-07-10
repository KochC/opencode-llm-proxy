# Using opencode-llm-proxy with Zed

## What this gives you

Use any model OpenCode has configured inside the [Zed](https://zed.dev) editor through its OpenAI-compatible provider. Good for chat and inline assistance; tool calling is not Zed's primary path.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed
- Zed installed

## Step 1: Start OpenCode with the proxy

```bash
opencode
```

The proxy listens on `http://127.0.0.1:4010`.

## Step 2: Configure Zed

Edit `~/.config/zed/settings.json`:

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

Add more `available_models` entries for additional OpenCode model IDs.

## Step 3: Test it

Open the assistant panel, pick "Claude (OpenCode)", and send a prompt. Confirm available IDs with:

```bash
curl http://127.0.0.1:4010/v1/models | jq '.data[].id'
```

## Troubleshooting

- **Model not listed**: verify the `name` matches a real OpenCode model ID and that the JSON is valid.
- **No response**: check `curl http://127.0.0.1:4010/health` and that OpenCode is running.
- **Auth errors**: if `OPENCODE_LLM_PROXY_TOKEN` is set, Zed's OpenAI provider must send it — set it as the API key in Zed's provider settings.

## Security notes

- Localhost binding is appropriate for editor use.
- Expose on a LAN only with a token and firewall rules.
- See [security.md](../security.md) for full guidance.

# Using opencode-llm-proxy with a custom coding agent

## What this gives you

Build your own agent loop against a stable OpenAI / Anthropic / Gemini-compatible endpoint while OpenCode manages which model actually runs. You keep full control of tool execution on the client side — the proxy returns real tool calls for you to run and feed back.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed (npm install, so `mcp-tool-bridge.js` is present)
- `node` on `PATH` where OpenCode runs (required for tool calling)
- Any HTTP client or SDK (OpenAI, Anthropic, or Gemini)

## Step 1: Start OpenCode with the proxy

```bash
opencode
```

The proxy listens on `http://127.0.0.1:4010`.

## Step 2: Wire up your agent

Use the OpenAI SDK (or raw HTTP) and declare your tools:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4010/v1", api_key="unused")

tools = [{
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a file from disk",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
}]

messages = [{"role": "user", "content": "Read README.md and summarize it."}]

resp = client.chat.completions.create(
    model="github-copilot/claude-sonnet-4.6",
    messages=messages,
    tools=tools,
)
```

## Step 3: Run the agent loop

1. Inspect `resp.choices[0].message.tool_calls`. The proxy returns one or several calls in a single turn (parallel tool calls are supported).
2. Execute each tool locally.
3. Append the assistant message and one `role: "tool"` message per call (with the matching `tool_call_id`) to `messages`.
4. Send the full history back to the proxy and repeat until `finish_reason` is `stop`.

The proxy is stateless between calls, so always send the complete conversation history.

## Troubleshooting

- **No tool calls returned**: install the npm plugin (includes `mcp-tool-bridge.js`) and ensure `node` is on `PATH`.
- **Parallel calls exceed capacity**: raise `OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE` (default `8`).
- **Forcing a tool**: set `tool_choice` to a specific named tool; `tool_choice: "none"` disables tool use for a request.

## Security notes

- Your agent executes tools — validate arguments and sandbox side effects.
- Keep the proxy on localhost for single-machine agents; use a token and firewall for LAN exposure.
- Never log bearer tokens.
- See [security.md](../security.md) for full guidance.

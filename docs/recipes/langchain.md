# Using opencode-llm-proxy with LangChain

## What this gives you

Drive LangChain chains and agents with any model OpenCode has configured, using the standard OpenAI or Anthropic wrappers. Streaming and tool/function calling both work.

## Prerequisites

- OpenCode with `opencode-llm-proxy` installed
- Python with `langchain-openai` (or `langchain-anthropic`) installed

## Step 1: Start OpenCode with the proxy

```bash
opencode
```

The proxy listens on `http://127.0.0.1:4010`.

## Step 2: Configure LangChain

Using the OpenAI-compatible wrapper:

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="anthropic/claude-3-5-sonnet",
    openai_api_base="http://127.0.0.1:4010/v1",
    openai_api_key="unused",
)
```

Or the Anthropic wrapper:

```python
from langchain_anthropic import ChatAnthropic

llm = ChatAnthropic(
    model="anthropic/claude-3-5-sonnet",
    base_url="http://127.0.0.1:4010",
    api_key="unused",
)
```

## Step 3: Test it

```python
response = llm.invoke("What are the SOLID principles?")
print(response.content)
```

Tool calling works with `.bind_tools([...])` and standard LangChain tool/agent constructs — the proxy translates the calls through to the underlying model.

## Troubleshooting

- **Connection refused**: OpenCode isn't running or the proxy port differs. Check `curl http://127.0.0.1:4010/health`.
- **Model not found**: run `curl http://127.0.0.1:4010/v1/models` and use an exact ID.
- **Tool calls not returned**: install the npm plugin (includes `mcp-tool-bridge.js`) and ensure `node` is on `PATH` where OpenCode runs.

## Security notes

- Keep `base_url` on localhost unless you deliberately expose the proxy.
- If exposing on a LAN, set `OPENCODE_LLM_PROXY_TOKEN` and pass it as the API key.
- See [security.md](../security.md) for full guidance.

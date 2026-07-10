# n8n example workflow

`opencode-llm-proxy-demo.workflow.json` is an importable n8n workflow that
demonstrates using OpenCode models through the proxy in three ways:

- an **OpenAI Chat Model** node pointed at `opencode-llm-proxy`
- a **Basic LLM Chain** for simple prompt/response
- an **AI Agent** node with a **Calculator** tool, showing real tool/function calling

## Import

n8n → top-right menu → **Import from File** → select
`opencode-llm-proxy-demo.workflow.json`.

## Setup before running

1. Start OpenCode with the proxy exposed to n8n and a token set:

   ```bash
   OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
   OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
   opencode
   ```

2. In n8n, create an **OpenAI** credential named `OpenCode Proxy`:
   - **Base URL**: `http://<opencode-host-ip>:4010/v1`
   - **API Key**: your token

3. Open the **OpenCode Chat Model** node, re-select the credential if needed,
   and pick a model from the dropdown (it auto-populates from `GET /v1/models`).

4. Run the workflow with **Test workflow**.

> The `credentials.id` in the JSON is a placeholder
> (`REPLACE_WITH_YOUR_CREDENTIAL_ID`). n8n will prompt you to select your own
> credential on first open — just pick `OpenCode Proxy`.

## Notes

- Node `typeVersion`s target a recent n8n release; n8n's importer will migrate
  them if your version differs.
- Tool calling requires the npm plugin install (so `mcp-tool-bridge.js` is
  present) and `node` on `PATH` where OpenCode runs.
- See the full [n8n recipe](../../recipes/n8n.md) and [security notes](../../security.md).

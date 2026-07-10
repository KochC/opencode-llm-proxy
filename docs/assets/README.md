# docs/assets

Media assets for the README and docs. Drop the final files here with the
filenames below so existing references resolve.

## Expected files

| File | Used by | Notes |
|---|---|---|
| `demo.gif` | README hero | 20–40s demo. Once added, re-insert `![opencode-llm-proxy demo](docs/assets/demo.gif)` under the intro paragraph in the README |
| `models-endpoint.png` | docs | `curl /v1/models` output |
| `n8n-credential.png` | docs | n8n OpenAI credential configured with proxy base URL |
| `open-webui-settings.png` | docs | Open WebUI connection settings |
| `tool-calling-response.png` | docs | Tool-calling request and response |

## Demo GIF storyboard (20–40s)

1. Open a terminal with `opencode` running.
2. Show proxy startup on `http://127.0.0.1:4010`.
3. Run `curl http://127.0.0.1:4010/v1/models`.
4. Show models from OpenCode providers.
5. Send a chat completion request.
6. Send a small tool/function calling request.
7. Show the returned tool call.
8. End card: "Use one OpenCode model setup from n8n, Open WebUI, LangChain,
   Continue, Zed, and coding agents."

## Additional screenshots to capture

- README top section with badges and architecture diagram
- n8n AI Agent node using the model
- npm package page
- GitHub release page

> These are placeholders documented in the promotion plan. Replace this note
> with the actual media before publishing widely. The README image reference was
> removed until `demo.gif` exists — re-add it (see the table above) once the GIF
> is recorded.

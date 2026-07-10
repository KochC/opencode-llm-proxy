# Security

opencode-llm-proxy exposes the models OpenCode has configured over a local HTTP endpoint. Treat that endpoint as sensitive: anyone who can reach it can use your provider access and, when tools are attached, trigger tool/function calls.

## Default: localhost only

By default the proxy binds to `127.0.0.1`, so only processes on the same machine can reach it. This is the safest configuration and is recommended whenever the client runs on the same host (editors, local SDK scripts, local agents).

## Use a bearer token when exposing beyond localhost

If you bind to a network interface (`OPENCODE_LLM_PROXY_HOST=0.0.0.0`) for LAN or Docker use, always set a token:

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
opencode
```

Every request must then send `Authorization: Bearer some-long-random-token`. Use a long, random value and rotate it if it may have leaked.

## Do not expose the proxy to the public internet

The proxy is designed for localhost and trusted LANs. Do not port-forward it, place it on a public IP, or put it behind a public reverse proxy. A token is not a substitute for network isolation.

## Use firewall rules

When exposing on a LAN, restrict inbound access to only the hosts that need it (e.g. your n8n or Open WebUI machine). On macOS, the Application Firewall must be told to allow the `opencode` binary or it will silently drop connections.

## Reverse proxy cautions

If you must front the proxy with a reverse proxy on a trusted network, terminate TLS there, enforce the bearer token, and never forward it from untrusted networks. Avoid caching that could leak responses between users.

## Be careful with tool/function calling

When clients attach tools, the model can request actions that your client then executes (reading files, running commands, HTTP requests). Only enable tools you trust, validate arguments, sandbox side effects, and review any auto-approve settings in agent clients.

## Do not share provider access beyond your intended environment

The whole point of the proxy is reuse of your OpenCode providers. Anyone who can call the proxy is using your GitHub Copilot / Anthropic / Bedrock / etc. access. Keep the audience limited to yourself or your team.

## Do not log bearer tokens

Never log the `Authorization` header or the token value in application logs, reverse-proxy logs, or debugging output. Scrub them from any shared traces or issue reports.

## Checklist

- [ ] Localhost binding unless network access is genuinely required
- [ ] `OPENCODE_LLM_PROXY_TOKEN` set whenever bound to a network interface
- [ ] Not reachable from the public internet
- [ ] Firewall restricts inbound access to known hosts
- [ ] Tool-using clients are trusted and reviewed
- [ ] Tokens never written to logs

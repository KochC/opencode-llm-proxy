# Security

opencode-llm-proxy exposes the models OpenCode has configured over a local HTTP endpoint. Treat that endpoint as sensitive: anyone who can reach it can use your provider access and, when tools are attached, trigger tool/function calls.

## Default: localhost only

By default the proxy binds to `127.0.0.1`, so only processes on the same machine can reach it. This is the safest configuration and is recommended whenever the client runs on the same host (editors, local SDK scripts, local agents).

## Use a bearer token when exposing beyond localhost

If you bind to a network interface (`OPENCODE_LLM_PROXY_HOST=0.0.0.0`) for LAN or Docker use, the proxy requires at least one token and refuses to start without one:

```bash
OPENCODE_LLM_PROXY_HOST=0.0.0.0 \
OPENCODE_LLM_PROXY_TOKEN=some-long-random-token \
opencode
```

Every request must then send `Authorization: Bearer some-long-random-token`. Use a long, random value and rotate it if it may have leaked.

For rotation or multiple clients, `OPENCODE_LLM_PROXY_TOKENS` accepts a JSON array of non-empty token strings. It can be used alongside the single `OPENCODE_LLM_PROXY_TOKEN` value.

## Do not expose the proxy to the public internet

The proxy is designed for localhost and trusted LANs. Do not port-forward it, place it on a public IP, or put it behind a public reverse proxy. A token is not a substitute for network isolation.

## Use firewall rules

When exposing on a LAN, restrict inbound access to only the hosts that need it (e.g. your n8n or Open WebUI machine). On macOS, the Application Firewall must be told to allow the `opencode` binary or it will silently drop connections.

## Reverse proxy cautions

If you must front the proxy with a reverse proxy on a trusted network, terminate TLS there, enforce the bearer token, and never forward it from untrusted networks. Avoid caching that could leak responses between users.

## Be careful with tool/function calling

When clients attach tools, the model can request actions that your client then executes (reading files, running commands, HTTP requests). Only enable tools you trust, validate arguments, sandbox side effects, and review any auto-approve settings in agent clients.

Tool bridges have a bounded pool and waiting queue. Requests beyond `OPENCODE_LLM_PROXY_TOOL_BRIDGE_MAX_QUEUE` receive `429`, limiting unbounded bridge-waiter growth under load.

## Do not share provider access beyond your intended environment

The whole point of the proxy is reuse of your OpenCode providers. Anyone who can call the proxy is using your GitHub Copilot / Anthropic / Bedrock / etc. access. Keep the audience limited to yourself or your team.

## Do not log bearer tokens

Never log the `Authorization` header or the token value in application logs, reverse-proxy logs, or debugging output. Scrub them from any shared traces or issue reports.

## Browser and resource controls

Browser origins are denied by default. Configure an explicit JSON allowlist with `OPENCODE_LLM_PROXY_CORS_ORIGINS`; avoid `"*"` on network-exposed installations. Browser Private Network Access is also denied unless `OPENCODE_LLM_PROXY_ALLOW_PRIVATE_NETWORK=true`.

The proxy enforces request timeouts, request/media size limits, active-request and queue limits, and tool-bridge acquisition timeouts. Tune the corresponding variables documented in the README for your host capacity. Temporary OpenCode sessions are deleted after requests by default; enable `OPENCODE_LLM_PROXY_KEEP_SESSIONS` only when retained sessions are needed for diagnostics.

Multimodal inputs are accepted only through supported content shapes and are checked against model capabilities. Structured-output schemas and supported generation controls are validated. Maximum-token controls are accepted for client compatibility but cannot currently be enforced by the OpenCode SDK; other unsupported OpenAI/Anthropic controls are rejected rather than silently accepted.

## Remote media fetching

Remote media is disabled by default. Keep `OPENCODE_LLM_PROXY_REMOTE_MEDIA_ENABLED=false` unless a trusted client genuinely needs URL-based media; embedded data URLs avoid outbound requests and are safer.

When enabled, the fetcher defaults to HTTPS only and converts successful downloads to embedded data URLs before forwarding them to OpenCode. Its SSRF protections include:

- Resolving every initial and redirected hostname itself, rejecting credentials and non-public IPv4/IPv6 ranges, including loopback, private, link-local, shared, documentation, multicast, reserved, and IPv4-mapped addresses.
- Pinning the connection to the validated DNS address and verifying the actual socket peer is that same public address, preventing DNS rebinding between validation and connection.
- Re-resolving and re-validating every redirect target, bounding redirect count, and rejecting HTTPS-to-HTTP downgrades.
- Bounding the total item count, bytes per item, and total preparation time, including DNS and redirects. Both declared `Content-Length` and bytes actually read are checked.
- Accepting only supported media MIME types, requiring identity content encoding, and rejecting URL credentials and unconfigured schemes.

Do not add `http` to `OPENCODE_LLM_PROXY_REMOTE_MEDIA_ALLOWED_SCHEMES` unless transport security is provided by a trusted environment and the risk is understood. These controls reduce SSRF risk but do not make arbitrary untrusted URL fetching preferable to leaving the feature disabled.

## Checklist

- [ ] Localhost binding unless network access is genuinely required
- [ ] `OPENCODE_LLM_PROXY_TOKEN` set whenever bound to a network interface
- [ ] Browser origins explicitly allowlisted when browser access is needed
- [ ] Not reachable from the public internet
- [ ] Firewall restricts inbound access to known hosts
- [ ] Tool-using clients are trusted and reviewed
- [ ] Remote media remains disabled, or its HTTPS-only limits are reviewed
- [ ] Tokens never written to logs

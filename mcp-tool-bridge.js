#!/usr/bin/env node
// Minimal MCP (Model Context Protocol) stdio server used internally by opencode-llm-proxy
// to expose a proxy caller's OpenAI/Anthropic/Gemini tool schemas to OpenCode as if they
// were real MCP tools.
//
// This process is spawned by OpenCode itself as a "local" MCP server (see index.js
// registerToolBridge()). It never actually executes anything: the proxy detects the
// resulting tool-call event on OpenCode's event stream and aborts the session before
// tools/call would matter, so the response returned here is just a harmless placeholder.
//
// Protocol: JSON-RPC 2.0 messages, newline-delimited, over stdin/stdout.
// stdout MUST only ever contain JSON-RPC messages - all diagnostics go to stderr.

const toolsJson = process.env.OPENCODE_LLM_PROXY_BRIDGE_TOOLS ?? "[]"

let tools = []
try {
  const parsed = JSON.parse(toolsJson)
  if (Array.isArray(parsed)) tools = parsed
} catch (error) {
  process.stderr.write(`opencode-llm-proxy bridge: failed to parse tool schemas: ${error}\n`)
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function respondResult(id, result) {
  if (id === undefined || id === null) return
  send({ jsonrpc: "2.0", id, result })
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

function handleMessage(message) {
  const { id, method, params } = message

  switch (method) {
    case "initialize": {
      respondResult(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-llm-proxy-bridge", version: "1.0.0" },
      })
      return
    }
    case "notifications/initialized":
      // Notification, no response expected.
      return
    case "ping": {
      respondResult(id, {})
      return
    }
    case "tools/list": {
      respondResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.parameters ?? { type: "object", properties: {} },
        })),
      })
      return
    }
    case "tools/call": {
      // Never actually reached in practice: the proxy aborts the OpenCode session as
      // soon as it observes the tool-call part on the event stream, before this
      // response would be consumed. Returned only as a safety net.
      respondResult(id, {
        content: [
          {
            type: "text",
            text: "(intercepted by opencode-llm-proxy; awaiting the external caller's tool result)",
          },
        ],
      })
      return
    }
    default: {
      respondError(id, -32601, `Method not found: ${method}`)
    }
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      handleMessage(message)
    } catch (error) {
      process.stderr.write(`opencode-llm-proxy bridge: failed to parse message: ${error}\n`)
    }
  }
})

process.stdin.on("end", () => {
  process.exit(0)
})

#!/usr/bin/env node
import { Buffer } from "node:buffer"

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

// Parses the JSON tool schemas supplied via env. Always returns an array; on any
// parse error it returns [] and (optionally) reports the failure via onError.
export function parseTools(toolsJson, onError) {
  try {
    const parsed = JSON.parse(toolsJson ?? "[]")
    if (Array.isArray(parsed)) return parsed
  } catch (error) {
    onError?.(error)
  }
  return []
}

function result(id, value) {
  if (id === undefined || id === null) return null
  return { jsonrpc: "2.0", id, result: value }
}

function error(id, code, message) {
  if (id === undefined || id === null) return null
  return { jsonrpc: "2.0", id, error: { code, message } }
}

// Pure JSON-RPC dispatcher. Given a parsed request message and the tool schemas,
// returns the response object to send, or null when no response is expected
// (notifications, or requests without an id).
export function dispatch(message, tools = []) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }
  }

  const { id, method, params } = message ?? {}
  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }
  }

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-llm-proxy-bridge", version: "1.0.0" },
      })
    case "notifications/initialized":
      // Notification, no response expected.
      return null
    case "ping":
      return result(id, {})
    case "tools/list":
      return result(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.parameters ?? { type: "object", properties: {} },
        })),
      })
    case "tools/call":
      // Never actually reached in practice: the proxy aborts the OpenCode session as
      // soon as it observes the tool-call part on the event stream, before this
      // response would be consumed. Returned only as a safety net.
      return result(id, {
        content: [
          {
            type: "text",
            text: "(intercepted by opencode-llm-proxy; awaiting the external caller's tool result)",
          },
        ],
      })
    default:
      return error(id, -32601, `Method not found: ${method}`)
  }
}

// Wires the pure dispatcher up to newline-delimited JSON-RPC streams. Streams are
// injectable (defaulting to the process stdio) so the parsing loop can be unit
// tested without spawning a child process. Only invoked when this module is run as
// a script (see the guard below), so importing it for tests has no side effects.
export function runStdioServer(tools, options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const onEnd = options.onEnd ?? (() => process.exit(0))
  const configuredMax = Number(options.maxFrameBytes ?? process.env.OPENCODE_LLM_PROXY_BRIDGE_MAX_FRAME_BYTES)
  const maxFrameBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 1024 * 1024

  function send(message) {
    output.write(JSON.stringify(message) + "\n")
  }

  function sendError(code, message) {
    send({ jsonrpc: "2.0", id: null, error: { code, message } })
  }

  function processFrame(frame) {
    const line = frame.trim()
    if (!line) return
    let message
    try {
      message = JSON.parse(line)
    } catch (err) {
      sendError(-32700, "Parse error")
      errorOutput.write(`opencode-llm-proxy bridge: failed to parse message: ${err}\n`)
      return
    }
    const response = dispatch(message, tools)
    if (response) send(response)
  }

  let buffer = ""
  let bufferBytes = 0
  let oversized = false
  input.setEncoding("utf8")
  input.on("data", (chunk) => {
    let start = 0
    for (let newlineIndex; (newlineIndex = chunk.indexOf("\n", start)) !== -1; start = newlineIndex + 1) {
      const part = chunk.slice(start, newlineIndex)
      if (!oversized) {
        const partBytes = Buffer.byteLength(part)
        if (bufferBytes + partBytes > maxFrameBytes) {
          oversized = true
          buffer = ""
          bufferBytes = 0
          sendError(-32600, "Invalid Request")
        } else {
          processFrame(buffer + part)
        }
      }
      buffer = ""
      bufferBytes = 0
      oversized = false
    }

    const part = chunk.slice(start)
    if (!oversized) {
      const partBytes = Buffer.byteLength(part)
      if (bufferBytes + partBytes > maxFrameBytes) {
        oversized = true
        buffer = ""
        bufferBytes = 0
        sendError(-32600, "Invalid Request")
      } else {
        buffer += part
        bufferBytes += partBytes
      }
    }
  })

  input.on("end", () => {
    if (!oversized) processFrame(buffer)
    onEnd()
  })
}

// Only start the stdio server when executed directly (`node mcp-tool-bridge.js`),
// not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const tools = parseTools(process.env.OPENCODE_LLM_PROXY_BRIDGE_TOOLS, (err) =>
    process.stderr.write(`opencode-llm-proxy bridge: failed to parse tool schemas: ${err}\n`),
  )
  runStdioServer(tools)
}

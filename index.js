import { fileURLToPath } from "node:url"

const STATE_KEY = "__opencodeOpenAIProxyState"
const BRIDGE_SCRIPT_PATH = fileURLToPath(new URL("./mcp-tool-bridge.js", import.meta.url))

function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = { started: false }
  }
  return globalThis[STATE_KEY]
}

function corsHeaders(request) {
  const configuredOrigin = process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN ?? "*"
  const requestedHeaders = request?.headers.get("access-control-request-headers")
  const requestedMethod = request?.headers.get("access-control-request-method")
  const requestedPrivateNetwork = request?.headers.get("access-control-request-private-network")
  const requestOrigin = request?.headers.get("origin") ?? ""
  // When a specific origin is configured, only echo it back when the request
  // origin matches exactly. On a mismatch we omit the header entirely so that
  // browsers block the cross-origin request and the configured origin is not
  // disclosed to untrusted callers.
  const allowOrigin = configuredOrigin === "*" ? "*" : (requestOrigin === configuredOrigin ? requestOrigin : null)

  const headers = {
    vary: "origin, access-control-request-method, access-control-request-headers",
    "access-control-allow-headers": requestedHeaders ?? "authorization, content-type, x-opencode-provider",
    "access-control-allow-methods": requestedMethod ?? "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  }

  if (allowOrigin !== null) {
    headers["access-control-allow-origin"] = allowOrigin
  }

  if (requestedPrivateNetwork === "true") {
    headers["access-control-allow-private-network"] = "true"
  }

  return headers
}

function json(data, status = 200, headers = {}, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request),
      ...headers,
    },
  })
}

function text(message, status = 200, request) {
  return new Response(message, {
    status,
    headers: corsHeaders(request),
  })
}

function unauthorized(request) {
  return json(
    {
      error: {
        message: "Unauthorized",
        type: "invalid_request_error",
      },
    },
    401,
    { "www-authenticate": 'Bearer realm="OpenCode LLM Proxy"' },
    request,
  )
}

function badRequest(message, status = 400, request) {
  return json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    status,
    {},
    request,
  )
}

function internalError(message, status = 500, request) {
  return json(
    {
      error: {
        message,
        type: "server_error",
      },
    },
    status,
    {},
    request,
  )
}

function getBearerToken(request) {
  const header = request.headers.get("authorization") ?? ""
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return undefined
  return header.slice(prefix.length).trim()
}

function isAuthorized(request) {
  const configured = process.env.OPENCODE_LLM_PROXY_TOKEN
  if (!configured) return true
  return getBearerToken(request) === configured
}

export function toTextContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
}

export function normalizeMessages(messages) {
  const toolNameByCallId = new Map()

  return messages
    .map((message) => {
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const baseText = toTextContent(message.content).trim()
        const callsText = message.tool_calls
          .map((call) => {
            const name = call.function?.name ?? call.name ?? "unknown_tool"
            const args = call.function?.arguments ?? ""
            if (call.id) toolNameByCallId.set(call.id, name)
            return `[Called tool ${name} with arguments ${args}]`
          })
          .join("\n")
        return { role: message.role, content: [baseText, callsText].filter(Boolean).join("\n\n") }
      }

      if (message.role === "tool") {
        const name = toolNameByCallId.get(message.tool_call_id) ?? "tool"
        const resultText = toTextContent(message.content).trim()
        return { role: "tool", content: `[Result from tool ${name}]: ${resultText}` }
      }

      return {
        role: message.role,
        content: toTextContent(message.content).trim(),
      }
    })
    .filter((message) => message.content.length > 0)
}

export function normalizeResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input.trim() }].filter((message) => message.content)
  }

  if (!Array.isArray(input)) return []

  const toolNameByCallId = new Map()

  return input
    .map((item) => {
      if (item?.type === "function_call") {
        const name = item.name ?? "unknown_tool"
        if (item.call_id) toolNameByCallId.set(item.call_id, name)
        return { role: "assistant", content: `[Called tool ${name} with arguments ${item.arguments ?? ""}]` }
      }

      if (item?.type === "function_call_output") {
        const name = toolNameByCallId.get(item.call_id) ?? "tool"
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
        return { role: "tool", content: `[Result from tool ${name}]: ${output}` }
      }

      const role = item.role ?? item.type ?? "user"
      if (typeof item.content === "string") {
        return { role, content: item.content.trim() }
      }

      if (Array.isArray(item.content)) {
        const content = item.content
          .map((part) => {
            if (!part) return ""
            if (typeof part === "string") return part
            if (typeof part.text === "string") return part.text
            if (typeof part.input_text === "string") return part.input_text
            if (typeof part.output_text === "string") return part.output_text
            return ""
          })
          .filter(Boolean)
          .join("\n\n")
          .trim()

        return { role, content }
      }

      if (Array.isArray(item.input)) {
        const content = item.input
          .map((part) => {
            if (!part) return ""
            if (typeof part === "string") return part
            if (typeof part.text === "string") return part.text
            if (typeof part.input_text === "string") return part.input_text
            return ""
          })
          .filter(Boolean)
          .join("\n\n")
          .trim()
        return { role, content }
      }

      return { role, content: "" }
    })
    .filter((message) => message.content.length > 0)
}

export function buildSystemPrompt(messages, request) {
  const systemMessages = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)

  const hints = [
    "You are answering through a proxy backed by OpenCode.",
    "Return only the assistant's reply content.",
  ]

  if (typeof request.temperature === "number") {
    hints.push(`Requested temperature: ${request.temperature}`)
  }

  if (typeof request.max_completion_tokens === "number" || typeof request.max_tokens === "number") {
    hints.push(`Requested max output tokens: ${request.max_completion_tokens ?? request.max_tokens}`)
  }

  return [...systemMessages, ...hints].join("\n\n").trim()
}

export function buildPrompt(messages) {
  const chatMessages = messages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  )

  if (chatMessages.length === 0) {
    return "Say hello."
  }

  if (chatMessages.length === 1 && chatMessages[0].role === "user") {
    return chatMessages[0].content
  }

  const transcript = chatMessages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n")

  return [
    "Continue the conversation below and provide the next assistant reply.",
    "Respond as the assistant to the latest user message.",
    "Conversation:",
    transcript,
  ].join("\n\n")
}

export function extractAssistantText(parts) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim()
}

async function executePrompt(client, request, model, messages, system, callerTools = []) {
  if (Array.isArray(callerTools) && callerTools.length > 0) {
    // Tool-aware path: must watch the event stream (via runAgentTurn) rather than
    // block on session.prompt, so we can intercept a proposed tool call instead of
    // letting OpenCode's agent loop run to a final text answer.
    const result = await runAgentTurn(client, model, messages, system, callerTools, () => {})
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      request,
      sessionID: result.sessionID,
      completion: {
        data: {
          info: {
            finish: result.finish,
            tokens: result.tokens,
          },
        },
      },
    }
  }

  const tools = await getDisabledTools(client)
  const session = await client.session.create({
    body: {
      title: `Proxy: ${model.id}`,
    },
  })

  const prompt = buildPrompt(messages)

  const completion = await client.session.prompt({
    path: { id: session.data.id },
    body: {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      system,
      tools,
      parts: [
        {
          type: "text",
          text: prompt,
        },
      ],
    },
  })

  const content = extractAssistantText(completion.data.parts ?? [])

  if (!content && completion.data.info?.error) {
    throw new Error(completion.data.info.error.message ?? "Model call failed.")
  }

  return {
    content,
    toolCalls: [],
    completion,
    request,
    sessionID: session.data.id,
  }
}

async function executePromptStreaming(client, model, messages, system, onChunk, callerTools = []) {
  const result = await runAgentTurn(client, model, messages, system, callerTools, onChunk)
  return {
    sessionID: result.sessionID,
    tokens: result.tokens,
    finish: result.finish,
    toolCalls: result.toolCalls,
  }
}

function createChatCompletionResponse(result, model) {
  const now = Math.floor(Date.now() / 1000)
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0

  const toolCalls = result.toolCalls ?? []
  const message =
    toolCalls.length > 0
      ? {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          })),
        }
      : {
          role: "assistant",
          content: result.content,
        }

  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: now,
    model: model.id,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(result.completion.data.info?.finish),
        message,
      },
    ],
    usage: {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
    },
  }
}

function createResponsesApiResponse(result, model) {
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0

  const toolCalls = result.toolCalls ?? []
  const output =
    toolCalls.length > 0
      ? toolCalls.map((call) => ({
          id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
          status: "completed",
        }))
      : [
          {
            id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: result.content,
                annotations: [],
              },
            ],
          },
        ]

  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: model.id,
    output,
    output_text: toolCalls.length > 0 ? "" : result.content,
    parallel_tool_calls: true,
    reasoning: {
      effort: result.request.reasoning?.effort ?? null,
      summary: null,
    },
    text: {
      format: {
        type: "text",
      },
    },
    usage: {
      input_tokens: tokensIn,
      output_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
      input_tokens_details: {
        cached_tokens: result.completion.data.info?.tokens?.cache?.read ?? 0,
      },
      output_tokens_details: {
        reasoning_tokens: result.completion.data.info?.tokens?.reasoning ?? 0,
      },
    },
  }
}

export function mapFinishReason(finish) {
  if (!finish) return "stop"
  if (finish.includes("length")) return "length"
  if (finish.includes("tool")) return "tool_calls"
  return "stop"
}

async function safeLog(client, level, message, extra) {
  try {
    await client.app.log({
      body: {
        service: "openai-proxy-plugin",
        level,
        message,
        extra,
      },
    })
  } catch {
    // Ignore logging failures so the proxy still works.
  }
}

async function getDisabledTools(client) {
  const state = getState()
  if (state.toolOffSwitch) return state.toolOffSwitch
  const result = await client.tool.ids()
  const ids = Array.isArray(result.data) ? result.data : []
  state.toolOffSwitch = Object.fromEntries(ids.map((id) => [id, false]))
  return state.toolOffSwitch
}

// ---------------------------------------------------------------------------
// Tool calling support
//
// OpenCode's own agent loop always executes tools itself, server-side, and has
// no concept of a "client-executed" tool call. To offer OpenAI/Anthropic/Gemini
// style tool calling (propose a call, hand control back to the caller, resume
// once they supply a result) we:
//
//   1. Dynamically register a tiny local MCP server ("bridge") whose tool list
//      is exactly the caller's declared tool schemas (see mcp-tool-bridge.js).
//   2. Enable only those tool IDs for this one prompt call.
//   3. Watch OpenCode's event stream. As soon as the model proposes calling one
//      of the bridge tools, the full call (name + arguments) is already present
//      on the event (see ToolStatePending in OpenCode's SDK types) - we grab it
//      and immediately abort the session before the bridge's harmless no-op
//      tools/call handler would ever matter.
//   4. Translate the captured call into the caller's expected tool-call shape.
//
// Bridge servers are reused from a small fixed-size pool of slot names (rather
// than registered fresh per request) since OpenCode's server API exposes no way
// to remove/deregister an MCP server once added.
// ---------------------------------------------------------------------------

function getToolBridgeState() {
  const state = getState()
  if (!state.toolBridge) {
    const configured = Number.parseInt(process.env.OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE ?? "", 10)
    const poolSize = Number.isFinite(configured) && configured > 0 ? configured : 8
    state.toolBridge = {
      freeSlots: Array.from({ length: poolSize }, (_, i) => `px_tools_${i}`),
      waiters: [],
      // Maps slot name -> the bridge tool IDs currently assigned to that slot (from
      // whichever turn most recently registered it). Needed because OpenCode has no
      // endpoint to deregister an MCP server, so a slot reused for a later request
      // stays connected under its old tool schema until it's next reused - see
      // buildToolsMap() below for why this must be tracked and explicitly disabled
      // per-turn, not just left out of the map.
      //
      // Keyed by slot (not an ever-growing set of every tool ID ever seen): each
      // slot's entry is *replaced*, not accumulated, every time that slot is
      // reused, so this stays bounded by the pool size regardless of how many
      // requests/unique tool schemas a long-lived process handles over its
      // lifetime.
      slotToolIDs: new Map(),
    }
  }
  return state.toolBridge
}

async function acquireBridgeSlot() {
  const bridgeState = getToolBridgeState()
  if (bridgeState.freeSlots.length > 0) {
    return bridgeState.freeSlots.shift()
  }
  return new Promise((resolve) => {
    bridgeState.waiters.push(resolve)
  })
}

function releaseBridgeSlot(slotName) {
  const bridgeState = getToolBridgeState()
  if (bridgeState.waiters.length > 0) {
    const resolve = bridgeState.waiters.shift()
    resolve(slotName)
  } else {
    bridgeState.freeSlots.push(slotName)
  }
}

export function sanitizeToolName(name, seen = new Set()) {
  let sanitized = String(name ?? "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 60)
  if (!sanitized) sanitized = "tool"
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `t_${sanitized}`

  let candidate = sanitized
  let suffix = 2
  while (seen.has(candidate)) {
    candidate = `${sanitized}_${suffix}`
    suffix++
  }
  seen.add(candidate)
  return candidate
}

function normalizeParameters(parameters) {
  if (parameters && typeof parameters === "object") return parameters
  return { type: "object", properties: {} }
}

export function parseOpenAITools(body) {
  const list = []
  if (Array.isArray(body?.tools)) {
    for (const entry of body.tools) {
      if (!entry || entry.type !== "function") continue
      // Chat Completions nests fields under `function`; the Responses API uses a flat shape.
      const fn = entry.function ?? entry
      if (typeof fn.name === "string" && fn.name) {
        list.push({
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: normalizeParameters(fn.parameters),
        })
      }
    }
  } else if (Array.isArray(body?.functions)) {
    // Legacy (pre-2023-08) OpenAI `functions` field.
    for (const fn of body.functions) {
      if (fn && typeof fn.name === "string" && fn.name) {
        list.push({
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: normalizeParameters(fn.parameters),
        })
      }
    }
  }
  return list
}

export function applyOpenAIToolChoice(tools, toolChoice) {
  if (toolChoice === "none") return []
  if (toolChoice && typeof toolChoice === "object") {
    const name = toolChoice.function?.name ?? toolChoice.name
    if (toolChoice.type === "function" && name) {
      return tools.filter((tool) => tool.name === name)
    }
  }
  return tools
}

export function parseAnthropicTools(body) {
  const list = []
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (tool && typeof tool.name === "string" && tool.name) {
        list.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: normalizeParameters(tool.input_schema),
        })
      }
    }
  }
  return list
}

export function applyAnthropicToolChoice(tools, toolChoice) {
  if (toolChoice?.type === "none") return []
  if (toolChoice?.type === "tool" && toolChoice.name) {
    return tools.filter((tool) => tool.name === toolChoice.name)
  }
  return tools
}

export function parseGeminiTools(body) {
  const list = []
  if (Array.isArray(body?.tools)) {
    for (const toolGroup of body.tools) {
      const declarations = Array.isArray(toolGroup?.functionDeclarations) ? toolGroup.functionDeclarations : []
      for (const decl of declarations) {
        if (decl && typeof decl.name === "string" && decl.name) {
          list.push({
            name: decl.name,
            description: typeof decl.description === "string" ? decl.description : "",
            parameters: normalizeParameters(decl.parameters),
          })
        }
      }
    }
  }
  return list
}

export function applyGeminiToolChoice(tools, toolConfig) {
  const mode = toolConfig?.functionCallingConfig?.mode
  if (mode === "NONE") return []
  const allowed = toolConfig?.functionCallingConfig?.allowedFunctionNames
  if (Array.isArray(allowed) && allowed.length > 0) {
    return tools.filter((tool) => allowed.includes(tool.name))
  }
  return tools
}

export async function registerToolBridge(client, tools) {
  const slotName = await acquireBridgeSlot()
  try {
    const seen = new Set()
    const nameMap = new Map() // full bridge tool ID ("<slot>_<sanitized>") -> original caller-facing name
    const bridgeTools = tools.map((tool) => {
      const sanitized = sanitizeToolName(tool.name, seen)
      nameMap.set(`${slotName}_${sanitized}`, tool.name)
      return { name: sanitized, description: tool.description, parameters: tool.parameters }
    })

    try {
      // Force a fresh respawn so the bridge process picks up this request's tool schema.
      await client.mcp.disconnect({ path: { name: slotName } })
    } catch {
      // Not previously connected; nothing to do.
    }

    await client.mcp.add({
      body: {
        name: slotName,
        config: {
          type: "local",
          command: ["node", BRIDGE_SCRIPT_PATH],
          environment: {
            OPENCODE_LLM_PROXY_BRIDGE_TOOLS: JSON.stringify(bridgeTools),
          },
          timeout: 10000,
        },
      },
    })

    const toolIDs = bridgeTools.map((tool) => `${slotName}_${tool.name}`)
    const bridgeState = getToolBridgeState()
    bridgeState.slotToolIDs.set(slotName, toolIDs)
    return { slotName, toolIDs, nameMap }
  } catch (error) {
    // If anything above fails after we've already acquired the slot (most likely
    // client.mcp.add() failing to spawn/register the bridge process), the caller
    // never gets a bridge object back to release via releaseToolBridge() in its
    // normal finally block - runAgentTurn() only knows about `bridge` once this
    // function successfully returns. Without this, the slot would be lost from the
    // pool forever, and repeated failures would eventually exhaust it and hang all
    // future tool-calling requests in acquireBridgeSlot().
    releaseBridgeSlot(slotName)
    throw error
  }
}

export function releaseToolBridge(bridge) {
  if (bridge) releaseBridgeSlot(bridge.slotName)
}

// Builds the per-turn `tools` map sent to OpenCode: the caller's bridge tools enabled,
// every OpenCode built-in disabled (as before), and - critically - every bridge tool ID
// ever registered by *any* pool slot explicitly disabled too, then re-enabling only this
// turn's own IDs.
//
// Why this is necessary: OpenCode's server API has no endpoint to deregister an MCP
// server, so a bridge slot reused for a later request/turn stays connected under its
// previous tool schema until it's next reused. getDisabledTools() also only snapshots
// OpenCode's built-in tool IDs once, before any bridge tools exist, so it can never know
// to disable them either. Without this explicit disable step, a stale, still-connected
// tool from a previously-used slot remains implicitly enabled and can get called by the
// model instead of (or alongside) this turn's own tool - the model has no way to tell
// them apart since both are live MCP tools as far as OpenCode is concerned.
export function buildToolsMap(baseTools, bridge) {
  const toolsMap = { ...baseTools }
  if (!bridge) return toolsMap
  const bridgeState = getToolBridgeState()
  for (const ids of bridgeState.slotToolIDs.values()) {
    for (const id of ids) toolsMap[id] = false
  }
  for (const id of bridge.toolIDs) toolsMap[id] = true
  return toolsMap
}

async function runAgentTurn(client, model, messages, system, callerTools, onChunk) {
  const baseTools = await getDisabledTools(client)
  let toolsMap = baseTools
  let bridge = null

  if (Array.isArray(callerTools) && callerTools.length > 0) {
    bridge = await registerToolBridge(client, callerTools)
    toolsMap = buildToolsMap(baseTools, bridge)
  }

  const session = await client.session.create({ body: { title: `Proxy: ${model.id}` } })
  const sessionID = session.data.id
  const prompt = buildPrompt(messages)
  const toolIDSet = bridge ? new Set(bridge.toolIDs) : null

  // Subscribe to the event stream before sending the prompt so we don't miss events.
  const { stream } = await client.event.subscribe()

  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      model: { providerID: model.providerID, modelID: model.modelID },
      system,
      tools: toolsMap,
      parts: [{ type: "text", text: prompt }],
    },
  })

  let errorMessage = null
  let content = ""
  // Tool calls collected live off the event stream, keyed by callID so parallel calls
  // and the pending -> running -> completed status updates for each collapse into one
  // entry. session.messages() does NOT carry the tool parts in current OpenCode, so the
  // live stream is the authoritative source here.
  const toolCallsByID = new Map()
  // The assistant message that carries this turn's tool calls. Once set, we only accept
  // tool parts (and the terminating step-finish) from this same message, so a follow-up
  // agent step can never leak spurious calls into the result.
  let toolMessageID = null

  const recordToolPart = (part) => {
    const callID = part.callID
    if (!callID) return
    const input = part.state?.input
    const hasInput =
      input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0
    const existing = toolCallsByID.get(callID)
    if (!existing) {
      toolCallsByID.set(callID, {
        id: callID,
        name: bridge.nameMap.get(part.tool) ?? part.tool,
        arguments: hasInput ? input : {},
        hasInput: Boolean(hasInput),
      })
    } else if (hasInput && !existing.hasInput) {
      // Upgrade from the empty-input "pending" snapshot to the populated one that
      // arrives with "running"/"completed".
      existing.arguments = input
      existing.hasInput = true
    }
  }

  try {
    for await (const event of stream) {
      if (event.type === "message.part.delta") {
        // Real incremental token deltas arrive here, as flat properties (sessionID,
        // partID, field, delta) - NOT nested under event.properties.part like
        // message.part.updated below. This is the actual live-streaming source; the
        // fallback via session.messages() after the loop covers turns where OpenCode
        // doesn't emit these (see below).
        const props = event.properties
        if (
          props?.sessionID === sessionID &&
          props?.field === "text" &&
          typeof props.delta === "string" &&
          props.delta.length > 0
        ) {
          content += props.delta
          onChunk?.(props.delta)
        }
      } else if (event.type === "message.part.updated") {
        const part = event.properties?.part
        if (!part || part.sessionID !== sessionID) continue

        if (
          toolIDSet &&
          part.type === "tool" &&
          toolIDSet.has(part.tool) &&
          (!toolMessageID || part.messageID === toolMessageID)
        ) {
          // A bridge tool call. Input is empty on "pending" and only populated on
          // "running"/"completed", so we keep updating until we have the arguments.
          if (part.messageID) toolMessageID = part.messageID
          recordToolPart(part)
        } else if (
          part.type === "step-finish" &&
          toolCallsByID.size > 0 &&
          (!toolMessageID || part.messageID === toolMessageID)
        ) {
          // The tool-calling step is complete: every tool call in this assistant
          // message (including parallel ones) has now been observed with its arguments.
          // Abort before OpenCode runs a follow-up step on the placeholder bridge
          // results (which would waste tokens and could emit spurious calls).
          try {
            await client.session.abort({ path: { id: sessionID } })
          } catch {
            // Best effort - we're ending our own read loop regardless.
          }
          break
        }
      } else if (event.type === "session.error") {
        if (!event.properties?.sessionID || event.properties.sessionID === sessionID) {
          errorMessage = event.properties?.error?.message ?? "Model call failed."
        }
        break
      } else if (event.type === "session.idle") {
        if (event.properties?.sessionID === sessionID) {
          break
        }
      }
    }
  } finally {
    releaseToolBridge(bridge)
  }

  const toolCalls = [...toolCallsByID.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments ?? {},
  }))

  if (errorMessage && toolCalls.length === 0) {
    throw new Error(errorMessage)
  }

  // Each list item is { info: Message, parts: Part[] } - matching the shape
  // client.session.prompt() (the non-tool-calling path) already returns directly.
  const messagesResult = await client.session.messages({ path: { id: sessionID } })
  const assistantEntry = (messagesResult.data ?? []).filter((m) => m.info?.role === "assistant").at(-1)
  const assistantInfo = assistantEntry?.info

  // Fallback for turns where message.part.delta never fired (observed for some
  // multi-step turns, e.g. continuing a conversation with prior tool calls/results in
  // history): use the authoritative final text from the fetched message's parts
  // instead of leaving content empty.
  if (!content && toolCalls.length === 0) {
    content = extractAssistantText(assistantEntry?.parts ?? [])
  }

  return {
    sessionID,
    content,
    toolCalls,
    tokens: assistantInfo?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: toolCalls.length > 0 ? "tool_calls" : assistantInfo?.finish,
  }
}

async function listModels(client) {
  const result = await client.config.providers()
  const payload = result.data
  const all = Array.isArray(payload?.providers) ? payload.providers : []

  return all.flatMap((provider) => {
    const models = provider.models ?? {}
    return Object.values(models).map((model) => ({
      id: `${provider.id}/${model.id}`,
      providerID: provider.id,
      modelID: model.id,
      name: model.name ?? model.id,
    }))
  })
}

export async function resolveModel(client, requestedModel, providerOverride) {
  const allModels = await listModels(client)
  if (providerOverride) {
    const match = allModels.find(
      (model) => model.providerID === providerOverride && model.modelID === requestedModel,
    )
    if (match) return match
  }

  if (requestedModel.includes("/")) {
    const [providerID, ...rest] = requestedModel.split("/")
    const modelID = rest.join("/")
    const fullMatch = allModels.find(
      (model) => model.providerID === providerID && model.modelID === modelID,
    )
    if (fullMatch) return fullMatch
  }

  const bareMatches = allModels.filter((model) => model.modelID === requestedModel)
  if (providerOverride) {
    const providerMatch = bareMatches.find((model) => model.providerID === providerOverride)
    if (providerMatch) return providerMatch
  }
  if (bareMatches.length === 1) return bareMatches[0]
  if (bareMatches.length > 1) {
    throw new Error(
      `Model '${requestedModel}' is ambiguous. Use provider/model, for example '${bareMatches[0].id}'.`,
    )
  }
  throw new Error(`Unknown model '${requestedModel}'. Call GET /v1/models to inspect available IDs.`)
}

export function createSseQueue() {
  const chunks = []
  let resolve = null
  let done = false

  function enqueue(value) {
    chunks.push(value)
    if (resolve) {
      const r = resolve
      resolve = null
      r()
    }
  }

  function finish() {
    done = true
    if (resolve) {
      const r = resolve
      resolve = null
      r()
    }
  }

  async function* generateChunks() {
    while (true) {
      while (chunks.length > 0) {
        yield chunks.shift()
      }
      if (done) break
      await new Promise((r) => {
        resolve = r
      })
    }
    // Drain any remaining chunks
    while (chunks.length > 0) {
      yield chunks.shift()
    }
  }

  return { enqueue, finish, generateChunks }
}

function sseResponse(corsHeadersObj, generator) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(chunk))
        }
      } catch {
        // Stream errors are surfaced via SSE data before this point.
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeadersObj,
    },
  })
}

function createModelResponse(models) {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.providerID,
      root: model.id,
    })),
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API helpers
// ---------------------------------------------------------------------------

export function normalizeAnthropicMessages(messages) {
  const toolNameByUseId = new Map()

  return messages
    .map((message) => {
      let content = ""
      if (typeof message.content === "string") {
        content = message.content.trim()
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((block) => {
            if (!block) return ""
            if (block.type === "text" && typeof block.text === "string") {
              return block.text.trim()
            }
            if (block.type === "tool_use") {
              if (block.id) toolNameByUseId.set(block.id, block.name)
              return `[Called tool ${block.name} with arguments ${JSON.stringify(block.input ?? {})}]`
            }
            if (block.type === "tool_result") {
              const name = toolNameByUseId.get(block.tool_use_id) ?? "tool"
              let resultText = ""
              if (typeof block.content === "string") {
                resultText = block.content
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter((inner) => inner && inner.type === "text" && typeof inner.text === "string")
                  .map((inner) => inner.text)
                  .join("\n\n")
              }
              return `[Result from tool ${name}]: ${resultText}`
            }
            return ""
          })
          .filter(Boolean)
          .join("\n\n")
      }
      return { role: message.role, content }
    })
    .filter((message) => message.content.length > 0)
}

export function normalizeAnthropicSystem(system) {
  if (typeof system === "string") {
    const trimmed = system.trim()
    return trimmed || null
  }
  if (Array.isArray(system)) {
    const text = system
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n")
    return text || null
  }
  return null
}

export function mapFinishReasonToAnthropic(finish) {
  if (!finish) return "end_turn"
  if (finish.includes("length")) return "max_tokens"
  if (finish.includes("tool")) return "tool_use"
  return "end_turn"
}

function createAnthropicResponse(result, model) {
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0
  const toolCalls = result.toolCalls ?? []
  const content =
    toolCalls.length > 0
      ? toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        }))
      : [{ type: "text", text: result.content }]

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    model: model.id,
    stop_reason: toolCalls.length > 0 ? "tool_use" : mapFinishReasonToAnthropic(result.completion.data.info?.finish),
    stop_sequence: null,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
  }
}

function anthropicBadRequest(message, status = 400, request) {
  return json(
    { type: "error", error: { type: "invalid_request_error", message } },
    status,
    {},
    request,
  )
}

function anthropicInternalError(message, status = 500, request) {
  return json(
    { type: "error", error: { type: "api_error", message } },
    status,
    {},
    request,
  )
}

// ---------------------------------------------------------------------------
// Google Gemini API helpers
// ---------------------------------------------------------------------------

export function normalizeGeminiContents(contents) {
  if (!Array.isArray(contents)) return []
  return contents
    .map((item) => {
      const role = item.role === "model" ? "assistant" : (item.role ?? "user")
      const content = Array.isArray(item.parts)
        ? item.parts
            .map((part) => {
              if (!part) return ""
              if (typeof part.text === "string") return part.text.trim()
              if (part.functionCall) {
                return `[Called tool ${part.functionCall.name} with arguments ${JSON.stringify(part.functionCall.args ?? {})}]`
              }
              if (part.functionResponse) {
                return `[Result from tool ${part.functionResponse.name}]: ${JSON.stringify(part.functionResponse.response ?? {})}`
              }
              return ""
            })
            .filter(Boolean)
            .join("\n\n")
        : ""
      return { role, content }
    })
    .filter((m) => m.content.length > 0)
}

export function extractGeminiSystemInstruction(systemInstruction) {
  if (!systemInstruction) return null
  if (typeof systemInstruction === "string") return systemInstruction.trim()
  if (Array.isArray(systemInstruction.parts)) {
    return systemInstruction.parts
      .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
  }
  return null
}

export function mapFinishReasonToGemini(finish) {
  if (!finish) return "STOP"
  if (finish.includes("length")) return "MAX_TOKENS"
  if (finish.includes("tool")) return "STOP"
  return "STOP"
}

function createGeminiResponse(content, finish, tokens, toolCalls) {
  const calls = toolCalls ?? []
  const parts =
    calls.length > 0
      ? calls.map((call) => ({ functionCall: { name: call.name, args: call.arguments ?? {} } }))
      : [{ text: content }]

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReasonToGemini(finish),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: tokens?.input ?? 0,
      candidatesTokenCount: tokens?.output ?? 0,
      totalTokenCount: (tokens?.input ?? 0) + (tokens?.output ?? 0),
    },
  }
}

function geminiModelFromPath(pathname) {
  // Matches /v1beta/models/some-model:generateContent or :streamGenerateContent
  const match = pathname.match(/^\/v1beta\/models\/([^/:]+)(?::(?:generate|stream)(?:Content|GenerateContent))?$/)
  return match ? match[1] : null
}

export function createProxyFetchHandler(client) {
  return async (request) => {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    if (!isAuthorized(request)) {
      return unauthorized(request)
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ healthy: true, service: "opencode-openai-proxy" }, 200, {}, request)
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        const models = await listModels(client)
        return json(createModelResponse(models), 200, {}, request)
      } catch (error) {
        await safeLog(client, "error", "Failed to list proxy models", {
          error: error instanceof Error ? error.message : String(error),
        })
        return internalError("Failed to load models from OpenCode.", 500, request)
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body
      try {
        body = await request.json()
      } catch {
        return badRequest("Request body must be valid JSON.", 400, request)
      }

      if (!body.model) {
        return badRequest("The 'model' field is required.", 400, request)
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return badRequest("The 'messages' field must contain at least one message.", 400, request)
      }

      const messages = normalizeMessages(body.messages)
      if (messages.length === 0) {
        return badRequest("No text content was found in the supplied messages.", 400, request)
      }

      let model
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        model = await resolveModel(client, body.model, providerOverride)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy completion failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(message, 502, request)
      }

      const system = buildSystemPrompt(messages, body)
      const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice)

      if (body.stream) {
        const completionID = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`
        const now = Math.floor(Date.now() / 1000)

        const queue = createSseQueue()

        async function* generateSse() {
          const runPromise = executePromptStreaming(
            client,
            model,
            messages,
            system,
            (delta) => {
              const chunk = JSON.stringify({
                id: completionID,
                object: "chat.completion.chunk",
                created: now,
                model: model.id,
                choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }],
              })
              queue.enqueue(`data: ${chunk}\n\n`)
            },
            callerTools,
          )
            .then((streamResult) => {
              const toolCalls = streamResult.toolCalls ?? []
              if (toolCalls.length > 0) {
                const toolCallChunk = JSON.stringify({
                  id: completionID,
                  object: "chat.completion.chunk",
                  created: now,
                  model: model.id,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        tool_calls: toolCalls.map((call, index) => ({
                          index,
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments ?? {}),
                          },
                        })),
                      },
                      finish_reason: null,
                    },
                  ],
                })
                queue.enqueue(`data: ${toolCallChunk}\n\n`)
              }

              const finalChunk = JSON.stringify({
                id: completionID,
                object: "chat.completion.chunk",
                created: now,
                model: model.id,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(streamResult.finish),
                  },
                ],
                usage: {
                  prompt_tokens: streamResult.tokens.input,
                  completion_tokens: streamResult.tokens.output,
                  total_tokens: streamResult.tokens.input + streamResult.tokens.output,
                },
              })
              queue.enqueue(`data: ${finalChunk}\n\ndata: [DONE]\n\n`)
            })
            .catch(async (err) => {
              const streamError = err instanceof Error ? err.message : String(err)
              await safeLog(client, "error", "Proxy streaming completion failed", {
                error: streamError,
                requestedModel: body.model,
              })
              const errChunk = JSON.stringify({
                error: { message: streamError, type: "server_error" },
              })
              queue.enqueue(`data: ${errChunk}\n\ndata: [DONE]\n\n`)
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()

          await runPromise
        }

        return sseResponse(corsHeaders(request), generateSse())
      }

      try {
        const result = await executePrompt(client, body, model, messages, system, callerTools)
        return json(createChatCompletionResponse(result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy completion failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(message, 502, request)
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/responses") {
      let body
      try {
        body = await request.json()
      } catch {
        return badRequest("Request body must be valid JSON.", 400, request)
      }

      if (!body.model) {
        return badRequest("The 'model' field is required.", 400, request)
      }

      const messages = normalizeResponseInput(body.input)
      if (messages.length === 0) {
        return badRequest("The 'input' field must contain at least one text message.", 400, request)
      }

      const instructionMessages =
        typeof body.instructions === "string" && body.instructions.trim()
          ? [{ role: "system", content: body.instructions.trim() }, ...messages]
          : messages

      const system = buildSystemPrompt(instructionMessages, {
        temperature: body.temperature,
        max_tokens: body.max_output_tokens,
        max_completion_tokens: body.max_output_tokens,
      })
      const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice)

      let model
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        model = await resolveModel(client, body.model, providerOverride)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy responses call failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(message, 502, request)
      }

      if (body.stream) {
        const responseID = `resp_${crypto.randomUUID().replace(/-/g, "")}`
        const itemID = `msg_${crypto.randomUUID().replace(/-/g, "")}`
        const now = Math.floor(Date.now() / 1000)

        const queue = createSseQueue()

        function sseEvent(eventType, data) {
          return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
        }

        async function* generateSse() {
          queue.enqueue(
            sseEvent("response.created", {
              type: "response.created",
              response: {
                id: responseID,
                object: "response",
                created_at: now,
                status: "in_progress",
                model: model.id,
                output: [],
              },
            }),
          )
          queue.enqueue(
            sseEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: 0,
              item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] },
            }),
          )

          let partIndex = 0
          // Accumulate delta tokens so we can populate `text` on output_text.done and content_part.done per the
          // OpenAI Responses API SSE spec (https://platform.openai.com/docs/api-reference/responses-streaming).
          let accumulatedText = ""
          const runPromise = executePromptStreaming(
            client,
            model,
            messages,
            system,
            (delta) => {
              if (partIndex === 0) {
                queue.enqueue(
                  sseEvent("response.content_part.added", {
                    type: "response.content_part.added",
                    item_id: itemID,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                )
                partIndex++
              }
              accumulatedText += delta
              queue.enqueue(
                sseEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: itemID,
                  output_index: 0,
                  content_index: 0,
                  delta,
                }),
              )
            },
            callerTools,
          )
            .then((streamResult) => {
              const toolCalls = streamResult.toolCalls ?? []
              if (toolCalls.length > 0) {
                // Each parallel tool call is its own output item with a distinct output_index.
                toolCalls.forEach((call, index) => {
                  const args = JSON.stringify(call.arguments ?? {})
                  const callItemID = `fc_${crypto.randomUUID().replace(/-/g, "")}`
                  const outputIndex = index + 1
                  queue.enqueue(
                    sseEvent("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: outputIndex,
                      item: {
                        id: callItemID,
                        type: "function_call",
                        status: "in_progress",
                        call_id: call.id,
                        name: call.name,
                        arguments: "",
                      },
                    }),
                  )
                  queue.enqueue(
                    sseEvent("response.function_call_arguments.delta", {
                      type: "response.function_call_arguments.delta",
                      item_id: callItemID,
                      output_index: outputIndex,
                      delta: args,
                    }),
                  )
                  queue.enqueue(
                    sseEvent("response.function_call_arguments.done", {
                      type: "response.function_call_arguments.done",
                      item_id: callItemID,
                      output_index: outputIndex,
                      arguments: args,
                    }),
                  )
                  queue.enqueue(
                    sseEvent("response.output_item.done", {
                      type: "response.output_item.done",
                      output_index: outputIndex,
                      item: {
                        id: callItemID,
                        type: "function_call",
                        status: "completed",
                        call_id: call.id,
                        name: call.name,
                        arguments: args,
                      },
                    }),
                  )
                })
                queue.enqueue(
                  sseEvent("response.completed", {
                    type: "response.completed",
                    response: {
                      id: responseID,
                      object: "response",
                      created_at: now,
                      status: "completed",
                      model: model.id,
                      usage: {
                        input_tokens: streamResult.tokens.input,
                        output_tokens: streamResult.tokens.output,
                        total_tokens: streamResult.tokens.input + streamResult.tokens.output,
                      },
                    },
                  }),
                )
                return
              }

              queue.enqueue(
                sseEvent("response.output_text.done", {
                  type: "response.output_text.done",
                  item_id: itemID,
                  output_index: 0,
                  content_index: 0,
                  text: accumulatedText,
                }),
              )
              if (partIndex > 0) {
                // Only emit content_part.done if content_part.added was emitted (i.e. at least one delta arrived).
                // Keeps the content-part lifecycle symmetric per the OpenAI Responses API spec.
                queue.enqueue(
                  sseEvent("response.content_part.done", {
                    type: "response.content_part.done",
                    item_id: itemID,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: accumulatedText, annotations: [] },
                  }),
                )
              }
              queue.enqueue(
                sseEvent("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { id: itemID, type: "message", status: "completed", role: "assistant" },
                }),
              )
              queue.enqueue(
                sseEvent("response.completed", {
                  type: "response.completed",
                  response: {
                    id: responseID,
                    object: "response",
                    created_at: now,
                    status: "completed",
                    model: model.id,
                    usage: {
                      input_tokens: streamResult.tokens.input,
                      output_tokens: streamResult.tokens.output,
                      total_tokens: streamResult.tokens.input + streamResult.tokens.output,
                    },
                  },
                }),
              )
            })
            .catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err)
              await safeLog(client, "error", "Proxy streaming responses call failed", {
                error: errMsg,
                requestedModel: body.model,
              })
              queue.enqueue(
                sseEvent("response.failed", {
                  type: "response.failed",
                  response: {
                    id: responseID,
                    object: "response",
                    created_at: now,
                    status: "failed",
                    error: { message: errMsg, code: "server_error" },
                  },
                }),
              )
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()

          await runPromise
        }

        return sseResponse(corsHeaders(request), generateSse())
      }

      try {
        const result = await executePrompt(client, body, model, messages, system, callerTools)
        return json(createResponsesApiResponse(result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy responses call failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(message, 502, request)
      }
    }

    // -----------------------------------------------------------------------
    // Anthropic Messages API  POST /v1/messages
    // -----------------------------------------------------------------------

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      let body
      try {
        body = await request.json()
      } catch {
        return anthropicBadRequest("Request body must be valid JSON.", 400, request)
      }

      if (!body.model) {
        return anthropicBadRequest("The 'model' field is required.", 400, request)
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return anthropicBadRequest("The 'messages' field must contain at least one message.", 400, request)
      }

      const messages = normalizeAnthropicMessages(body.messages)
      if (messages.length === 0) {
        return anthropicBadRequest("No text content was found in the supplied messages.", 400, request)
      }

      // Prepend Anthropic top-level `system` (string or array-of-content-blocks,
      // per the Messages API spec) as a system message so buildSystemPrompt
      // picks it up.
      const systemText = normalizeAnthropicSystem(body.system)
      const allMessages = systemText
        ? [{ role: "system", content: systemText }, ...messages]
        : messages

      const system = buildSystemPrompt(allMessages, {
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      })
      const callerTools = applyAnthropicToolChoice(parseAnthropicTools(body), body.tool_choice)

      let model
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        model = await resolveModel(client, body.model, providerOverride)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Anthropic proxy call failed (model resolve)", { error: message, requestedModel: body.model })
        return anthropicBadRequest(message, 400, request)
      }

      if (body.stream) {
        const msgID = `msg_${crypto.randomUUID().replace(/-/g, "")}`
        const queue = createSseQueue()

        function sseEvent(eventType, data) {
          return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
        }

        async function* generateSse() {
          queue.enqueue(sseEvent("message_start", {
            type: "message_start",
            message: {
              id: msgID,
              type: "message",
              role: "assistant",
              content: [],
              model: model.id,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }))

          let textBlockStarted = false
          const runPromise = executePromptStreaming(
            client,
            model,
            messages,
            system,
            (delta) => {
              if (!textBlockStarted) {
                queue.enqueue(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                }))
                textBlockStarted = true
              }
              queue.enqueue(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: delta },
              }))
            },
            callerTools,
          )
            .then((streamResult) => {
              const toolCalls = streamResult.toolCalls ?? []
              if (toolCalls.length > 0) {
                if (textBlockStarted) {
                  queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }))
                }
                // Each parallel tool call is a separate tool_use content block. Block
                // indexes follow the (optional) leading text block at index 0.
                const baseIndex = textBlockStarted ? 1 : 0
                toolCalls.forEach((call, i) => {
                  const blockIndex = baseIndex + i
                  const argsJson = JSON.stringify(call.arguments ?? {})
                  queue.enqueue(sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
                  }))
                  queue.enqueue(sseEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "input_json_delta", partial_json: argsJson },
                  }))
                  queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }))
                })
                queue.enqueue(sseEvent("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "tool_use", stop_sequence: null },
                  usage: { output_tokens: streamResult.tokens.output },
                }))
                queue.enqueue(sseEvent("message_stop", { type: "message_stop" }))
                return
              }

              if (!textBlockStarted) {
                queue.enqueue(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                }))
              }
              queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }))
              queue.enqueue(sseEvent("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: mapFinishReasonToAnthropic(streamResult.finish),
                  stop_sequence: null,
                },
                usage: { output_tokens: streamResult.tokens.output },
              }))
              queue.enqueue(sseEvent("message_stop", { type: "message_stop" }))
            })
            .catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err)
              await safeLog(client, "error", "Anthropic proxy streaming call failed", { error: errMsg, requestedModel: body.model })
              queue.enqueue(sseEvent("error", { type: "error", error: { type: "api_error", message: errMsg } }))
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()
          await runPromise
        }

        return sseResponse(corsHeaders(request), generateSse())
      }

      try {
        const result = await executePrompt(client, body, model, messages, system, callerTools)
        return json(createAnthropicResponse(result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Anthropic proxy call failed", { error: message, requestedModel: body.model })
        return anthropicInternalError(message, 500, request)
      }
    }

    // -----------------------------------------------------------------------
    // Google Gemini API  POST /v1beta/models/:model:generateContent (non-streaming)
    //                    POST /v1beta/models/:model:streamGenerateContent (streaming)
    // -----------------------------------------------------------------------

    const isGeminiNonStream = request.method === "POST" && url.pathname.endsWith(":generateContent")
    const isGeminiStream = request.method === "POST" && url.pathname.endsWith(":streamGenerateContent")

    if (isGeminiNonStream || isGeminiStream) {
      const geminiModelName = geminiModelFromPath(url.pathname)
      if (!geminiModelName) {
        return badRequest("Could not extract model name from URL.", 400, request)
      }

      let body
      try {
        body = await request.json()
      } catch {
        return badRequest("Request body must be valid JSON.", 400, request)
      }

      if (!Array.isArray(body.contents) || body.contents.length === 0) {
        return badRequest("The 'contents' field must contain at least one item.", 400, request)
      }

      const messages = normalizeGeminiContents(body.contents)
      if (messages.length === 0) {
        return badRequest("No text content was found in the supplied contents.", 400, request)
      }

      const systemText = extractGeminiSystemInstruction(body.systemInstruction)
      const systemMessages = systemText ? [{ role: "system", content: systemText }, ...messages] : messages
      const system = buildSystemPrompt(systemMessages, {
        temperature: body.generationConfig?.temperature,
        max_tokens: body.generationConfig?.maxOutputTokens,
      })
      const callerTools = applyGeminiToolChoice(parseGeminiTools(body), body.toolConfig)

      let model
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        model = await resolveModel(client, geminiModelName, providerOverride)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Gemini proxy call failed (model resolve)", { error: message, requestedModel: geminiModelName })
        return badRequest(message, 400, request)
      }

      if (isGeminiStream) {
        const queue = createSseQueue()

        async function* generateNdJson() {
          const runPromise = executePromptStreaming(
            client,
            model,
            messages,
            system,
            (delta) => {
              const chunk = JSON.stringify(createGeminiResponse(delta, null, null))
              queue.enqueue(chunk + "\n")
            },
            callerTools,
          )
            .then((streamResult) => {
              const toolCalls = streamResult.toolCalls ?? []
              const finalChunk = JSON.stringify(
                toolCalls.length > 0
                  ? createGeminiResponse("", streamResult.finish, streamResult.tokens, toolCalls)
                  : createGeminiResponse("", streamResult.finish, streamResult.tokens),
              )
              queue.enqueue(finalChunk + "\n")
            })
            .catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err)
              await safeLog(client, "error", "Gemini proxy streaming call failed", { error: errMsg, requestedModel: geminiModelName })
              const errChunk = JSON.stringify({ error: { code: 500, message: errMsg, status: "INTERNAL" } })
              queue.enqueue(errChunk + "\n")
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()
          await runPromise
        }

        const encoder = new TextEncoder()
        const body_ = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of generateNdJson()) {
                controller.enqueue(encoder.encode(chunk))
              }
            } catch {
              // errors surfaced via data
            } finally {
              controller.close()
            }
          },
        })

        return new Response(body_, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...corsHeaders(request),
          },
        })
      }

      try {
        const result = await executePrompt(client, body, model, messages, system, callerTools)
        const finish = result.completion.data.info?.finish
        const tokens = result.completion.data.info?.tokens
        return json(createGeminiResponse(result.content, finish, tokens, result.toolCalls), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Gemini proxy call failed", { error: message, requestedModel: geminiModelName })
        return badRequest(message, 500, request)
      }
    }

    return text("Not found", 404, request)
  }
}

export const OpenAIProxyPlugin = async ({ client }) => {
  const state = getState()
  if (state.started) {
    return {}
  }

  state.started = true

  const hostname = process.env.OPENCODE_LLM_PROXY_HOST ?? "127.0.0.1"
  const port = Number.parseInt(process.env.OPENCODE_LLM_PROXY_PORT ?? "4010", 10)

  let server
  try {
    server = Bun.serve({
      hostname,
      port,
      fetch: createProxyFetchHandler(client),
    })
  } catch (error) {
    // Never fail OpenCode startup because the proxy port is busy.
    await safeLog(client, "warn", "OpenAI proxy server failed to start", {
      hostname,
      port,
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }

  state.server = server

  await safeLog(client, "info", "OpenAI proxy server started", {
    hostname,
    port,
    protected: Boolean(process.env.OPENCODE_LLM_PROXY_TOKEN),
  })

  return {}
}

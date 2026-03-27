const STATE_KEY = "__opencodeOpenAIProxyState"

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
  const allowOrigin = configuredOrigin === "*" ? "*" : configuredOrigin

  const headers = {
    vary: "origin, access-control-request-method, access-control-request-headers",
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": requestedHeaders ?? "authorization, content-type, x-opencode-provider",
    "access-control-allow-methods": requestedMethod ?? "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  }

  if (requestedPrivateNetwork === "true") {
    headers["access-control-allow-private-network"] = "true"
  }

  return headers
}

function json(data, status = 200, headers = {}, request) {
  return new Response(JSON.stringify(data, null, 2), {
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

function toTextContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
}

function normalizeMessages(messages) {
  return messages
    .map((message) => ({
      role: message.role,
      content: toTextContent(message.content).trim(),
    }))
    .filter((message) => message.content.length > 0)
}

function normalizeResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input.trim() }].filter((message) => message.content)
  }

  if (!Array.isArray(input)) return []

  return input
    .map((item) => {
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

function buildSystemPrompt(messages, request) {
  const systemMessages = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)

  const hints = [
    "You are answering through an OpenAI-compatible proxy backed by OpenCode.",
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

function buildPrompt(messages) {
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

function extractAssistantText(parts) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim()
}

async function executePrompt(client, request, model, messages, system) {
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
    completion,
    request,
    sessionID: session.data.id,
  }
}

function createChatCompletionResponse(result, model) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: now,
    model: model.id,
    choices: [
      {
        index: 0,
        finish_reason: mapFinishReason(result.completion.data.info?.finish),
        message: {
          role: "assistant",
          content: result.content,
        },
      },
    ],
    usage: {
      prompt_tokens: result.completion.data.info?.tokens?.input ?? 0,
      completion_tokens: result.completion.data.info?.tokens?.output ?? 0,
      total_tokens:
        (result.completion.data.info?.tokens?.input ?? 0) +
        (result.completion.data.info?.tokens?.output ?? 0),
    },
  }
}

function createResponsesApiResponse(result, model) {
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0

  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: model.id,
    output: [
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
    ],
    output_text: result.content,
    parallel_tool_calls: false,
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

function mapFinishReason(finish) {
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

async function resolveModel(client, requestedModel, providerOverride) {
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

      if (body.stream) {
        return badRequest("Streaming is not implemented yet.", 400, request)
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

      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        const model = await resolveModel(client, body.model, providerOverride)
        const system = buildSystemPrompt(messages, body)
        const result = await executePrompt(client, body, model, messages, system)
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

      if (body.stream) {
        return badRequest("Streaming is not implemented yet.", 400, request)
      }

      if (!body.model) {
        return badRequest("The 'model' field is required.", 400, request)
      }

      const messages = normalizeResponseInput(body.input)
      if (messages.length === 0) {
        return badRequest("The 'input' field must contain at least one text message.", 400, request)
      }

      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        const model = await resolveModel(client, body.model, providerOverride)
        const system = buildSystemPrompt(
          typeof body.instructions === "string" && body.instructions.trim()
            ? [{ role: "system", content: body.instructions.trim() }, ...messages]
            : messages,
          {
            temperature: body.temperature,
            max_tokens: body.max_output_tokens,
            max_completion_tokens: body.max_output_tokens,
          },
        )
        const result = await executePrompt(client, body, model, messages, system)
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

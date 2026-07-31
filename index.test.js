import test, { describe, it, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { PassThrough } from "node:stream"

import {
  createProxyFetchHandler,
  createSseQueue,
  toTextContent,
  normalizeMessages,
  normalizeResponseInput,
  buildSystemPrompt,
  buildPrompt,
  extractAssistantText,
  mapFinishReason,
  resolveModel,
  normalizeAnthropicMessages,
  mapFinishReasonToAnthropic,
  normalizeAnthropicSystem,
  normalizeGeminiContents,
  extractGeminiSystemInstruction,
  mapFinishReasonToGemini,
  sanitizeToolName,
  parseOpenAITools,
  applyOpenAIToolChoice,
  parseAnthropicTools,
  applyAnthropicToolChoice,
  parseGeminiTools,
  applyGeminiToolChoice,
  registerToolBridge,
  releaseToolBridge,
  buildToolsMap,
  OpenAIProxyPlugin,
} from "./index.js"

import { dispatch, parseTools, runStdioServer } from "./mcp-tool-bridge.js"

// Keep the suite hermetic: environment variables leaking in from the developer's
// shell or CI (e.g. OPENCODE_LLM_PROXY_TOKEN) must not change test outcomes.
// Tests that need these set do so explicitly inside the test body.
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENCODE_LLM_PROXY_")) delete process.env[name]
  }
})

// ---------------------------------------------------------------------------
// Integration: createProxyFetchHandler
// ---------------------------------------------------------------------------

function createClient() {
  return {
    app: {
      log: async () => {},
    },
    config: {
      providers: async () => ({
        data: {
          providers: [],
        },
      }),
    },
  }
}

function createStreamingClient(chunks) {
  async function* makeStream() {
    for (const chunk of chunks) {
      yield chunk
    }
  }

  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "openai",
              models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } },
            },
          ],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-123" } }),
      promptAsync: async () => {},
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "end_turn",
            },
            parts: [],
          },
        ],
      }),
    },
    event: {
      subscribe: async () => ({ stream: makeStream() }),
    },
  }
}

function parseSseStream(text) {
  // Parses SSE `event: <name>\ndata: <json>\n\n` chunks into an ordered array.
  // Local to this test file; not exported.
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const eventLine = block.match(/^event: (.+)$/m)
      const dataLine = block.match(/^data: (.+)$/m)
      if (!eventLine || !dataLine) return null
      return { event: eventLine[1], data: JSON.parse(dataLine[1]) }
    })
    .filter(Boolean)
}

test("OPTIONS preflight returns CORS headers", async () => {
  process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN = "https://app.example.com"
  process.env.OPENCODE_LLM_PROXY_ALLOW_PRIVATE_NETWORK = "true"
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/v1/models", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, x-opencode-provider",
      "Access-Control-Request-Private-Network": "true",
    },
  })

  const response = await handler(request)

  assert.equal(response.status, 204)
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com")
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS")
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "authorization, content-type, x-opencode-provider, x-opencode-variant, x-request-id",
  )
  assert.equal(response.headers.get("access-control-allow-private-network"), "true")
  assert.equal(response.headers.get("access-control-max-age"), "86400")
})

test("health response includes CORS headers for an allowed origin", async () => {
  process.env.OPENCODE_LLM_PROXY_CORS_ORIGINS = '["*"]'
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/health", {
    headers: {
      Origin: "https://app.example.com",
    },
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("access-control-allow-origin"), "*")
  assert.deepEqual(body, { healthy: true, service: "opencode-openai-proxy" })
})

test("configured origin is returned for normal requests", async () => {
  process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN = "https://console.example.com"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/health", {
      headers: {
        Origin: "https://console.example.com",
      },
    })

    const response = await handler(request)

    assert.equal(response.headers.get("access-control-allow-origin"), "https://console.example.com")
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN
  }
})

test("disallowed origin does not receive its own origin back", async () => {
  process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN = "https://allowed.example.com"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/health", {
      headers: { Origin: "https://evil.example.com" },
    })

    const response = await handler(request)

    assert.equal(response.status, 403)
    assert.equal(response.headers.get("access-control-allow-origin"), null)
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN
  }
})

test("invalid generation controls return 400 instead of throwing", async () => {
  const handler = createProxyFetchHandler(createResponsesClient())
  const response = await handler(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", input: "hi", temperature: 99 }),
  }))
  assert.equal(response.status, 400)
})

test("remote media URLs are rejected to prevent SSRF", async () => {
  const handler = createProxyFetchHandler(createResponsesClient())
  const response = await handler(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "http://127.0.0.1/private" }] }],
    }),
  }))
  assert.equal(response.status, 400)
})

test("request with no Origin header is handled gracefully", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/health")

  const response = await handler(request)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("access-control-allow-origin"), null)
})

test("OPTIONS preflight for a disallowed origin returns 403 without allow-origin", async () => {
  process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN = "https://allowed.example.com"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    })

    const response = await handler(request)

    assert.equal(response.status, 403)
    assert.equal(response.headers.get("access-control-allow-origin"), null)
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN
  }
})

// ---------------------------------------------------------------------------
// Integration: authentication
// ---------------------------------------------------------------------------

test("missing token returns 401 when token is configured", async () => {
  process.env.OPENCODE_LLM_PROXY_TOKEN = "secret-token"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/health")

    const response = await handler(request)
    const body = await response.json()

    assert.equal(response.status, 401)
    assert.equal(body.error.type, "invalid_request_error")
    assert.ok(response.headers.get("www-authenticate")?.includes("Bearer"))
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_TOKEN
  }
})

test("wrong token returns 401", async () => {
  process.env.OPENCODE_LLM_PROXY_TOKEN = "secret-token"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/health", {
      headers: { Authorization: "Bearer wrong-token" },
    })

    const response = await handler(request)

    assert.equal(response.status, 401)
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_TOKEN
  }
})

test("correct token passes through", async () => {
  process.env.OPENCODE_LLM_PROXY_TOKEN = "secret-token"

  try {
    const handler = createProxyFetchHandler(createClient())
    const request = new Request("http://127.0.0.1:4010/health", {
      headers: { Authorization: "Bearer secret-token" },
    })

    const response = await handler(request)

    assert.equal(response.status, 200)
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_TOKEN
  }
})

test("no token configured allows all requests through", async () => {
  delete process.env.OPENCODE_LLM_PROXY_TOKEN
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/health")

  const response = await handler(request)

  assert.equal(response.status, 200)
})

test("any configured bearer token is accepted", async () => {
  process.env.OPENCODE_LLM_PROXY_TOKENS = '["first-token","second-token"]'
  const handler = createProxyFetchHandler(createClient())

  for (const token of ["first-token", "second-token"]) {
    const response = await handler(new Request("http://127.0.0.1:4010/health", {
      headers: { Authorization: `Bearer ${token}` },
    }))
    assert.equal(response.status, 200)
  }
})

// ---------------------------------------------------------------------------
// Integration: /v1/chat/completions error handling
// ---------------------------------------------------------------------------

test("malformed JSON body returns 400", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not valid json",
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error.type, "invalid_request_error")
})

test("top-level null JSON returns 400", async () => {
  const handler = createProxyFetchHandler(createClient())
  const response = await handler(new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  }))

  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /JSON object/)
})

test("request body over the configured byte limit returns 413", async () => {
  process.env.OPENCODE_LLM_PROXY_MAX_REQUEST_BYTES = "32"
  const handler = createProxyFetchHandler(createClient())
  const response = await handler(new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "a".repeat(40) }] }),
  }))

  assert.equal(response.status, 413)
})

test("responses include no-store and browser security headers", async () => {
  const response = await createProxyFetchHandler(createClient())(
    new Request("http://127.0.0.1:4010/health", { headers: { "x-request-id": "request-123" } }),
  )

  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("pragma"), "no-cache")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.equal(response.headers.get("x-frame-options"), "DENY")
  assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'")
  assert.equal(response.headers.get("x-request-id"), "request-123")
})

test("missing model field returns 400", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.ok(body.error.message.includes("model"))
})

test("missing messages field returns 400", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o" }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.ok(body.error.message.includes("messages"))
})

test("stream: true returns SSE response", async () => {
  const events = [
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "Hello",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: " world",
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)

  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"))

  const text = await response.text()
  assert.ok(text.includes("chat.completion.chunk"))
  assert.ok(text.includes("Hello"))
  assert.ok(text.includes(" world"))
  assert.ok(text.includes("[DONE]"))
})

test("stream: true with unknown model returns a safe 400", async () => {
  const handler = createProxyFetchHandler(createClient()) // no providers
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "nonexistent-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error.message, "The requested model is unavailable.")
})

test("stream: true propagates session.error into the SSE stream", async () => {
  const events = [
    {
      type: "session.error",
      properties: {
        sessionID: "sess-123",
        error: { message: "Model overloaded" },
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)
  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"))

  const text = await response.text()
  assert.ok(text.includes("server_error") || text.includes("Model overloaded"))
  assert.ok(text.includes("[DONE]"))
})

test("unknown model returns a safe 400", async () => {
  const handler = createProxyFetchHandler(createClient()) // client returns no providers
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "nonexistent-model",
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error.message, "The requested model is unavailable.")
})

test("unknown route returns 404", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/unknown-path")

  const response = await handler(request)

  assert.equal(response.status, 404)
})

// ---------------------------------------------------------------------------
describe("toTextContent", () => {
  it("returns a string unchanged", () => {
    assert.equal(toTextContent("hello"), "hello")
  })

  it("returns empty string for non-string non-array", () => {
    assert.equal(toTextContent(null), "")
    assert.equal(toTextContent(42), "")
    assert.equal(toTextContent({}), "")
  })

  it("joins text parts from an array", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    assert.equal(toTextContent(parts), "hello\n\nworld")
  })

  it("ignores non-text parts", () => {
    const parts = [
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: "only this" },
    ]
    assert.equal(toTextContent(parts), "only this")
  })

  it("filters out empty text parts", () => {
    const parts = [
      { type: "text", text: "" },
      { type: "text", text: "  " },
      { type: "text", text: "kept" },
    ]
    assert.equal(toTextContent(parts), "kept")
  })

  it("returns empty string for an empty array", () => {
    assert.equal(toTextContent([]), "")
  })
})

// ---------------------------------------------------------------------------
// Unit: normalizeMessages
// ---------------------------------------------------------------------------
describe("normalizeMessages", () => {
  it("passes through simple user messages", () => {
    const input = [{ role: "user", content: "hello" }]
    assert.deepEqual(normalizeMessages(input), [{ role: "user", content: "hello" }])
  })

  it("trims whitespace from content", () => {
    const input = [{ role: "user", content: "  hi  " }]
    assert.deepEqual(normalizeMessages(input), [{ role: "user", content: "hi" }])
  })

  it("drops messages with empty content", () => {
    const input = [
      { role: "user", content: "" },
      { role: "assistant", content: "response" },
    ]
    assert.deepEqual(normalizeMessages(input), [{ role: "assistant", content: "response" }])
  })

  it("converts array content to text", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]
    assert.deepEqual(normalizeMessages(input), [{ role: "user", content: "question" }])
  })
})

// ---------------------------------------------------------------------------
// Unit: normalizeResponseInput
// ---------------------------------------------------------------------------
describe("normalizeResponseInput", () => {
  it("wraps a plain string in a user message", () => {
    assert.deepEqual(normalizeResponseInput("hi"), [{ role: "user", content: "hi" }])
  })

  it("returns empty array for empty string", () => {
    assert.deepEqual(normalizeResponseInput("   "), [])
  })

  it("returns empty array for non-array non-string input", () => {
    assert.deepEqual(normalizeResponseInput(null), [])
    assert.deepEqual(normalizeResponseInput(42), [])
  })

  it("handles array of objects with string content", () => {
    const input = [{ role: "user", content: "hello" }]
    assert.deepEqual(normalizeResponseInput(input), [{ role: "user", content: "hello" }])
  })

  it("handles array content with text parts", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "from parts" }] },
    ]
    assert.deepEqual(normalizeResponseInput(input), [{ role: "user", content: "from parts" }])
  })

  it("handles input array with text parts", () => {
    const input = [
      { role: "user", input: [{ text: "from input array" }] },
    ]
    assert.deepEqual(normalizeResponseInput(input), [{ role: "user", content: "from input array" }])
  })

  it("falls back to type field for role", () => {
    const input = [{ type: "user", content: "hello" }]
    assert.deepEqual(normalizeResponseInput(input), [{ role: "user", content: "hello" }])
  })

  it("drops items with empty content", () => {
    const input = [
      { role: "user", content: "" },
      { role: "assistant", content: "kept" },
    ]
    assert.deepEqual(normalizeResponseInput(input), [{ role: "assistant", content: "kept" }])
  })
})

// ---------------------------------------------------------------------------
// Unit: buildSystemPrompt
// ---------------------------------------------------------------------------
describe("buildSystemPrompt", () => {
  it("includes system message content", () => {
    const messages = [{ role: "system", content: "Be concise." }]
    const result = buildSystemPrompt(messages, {})
    assert.ok(result.includes("Be concise."))
  })

  it("includes developer message content", () => {
    const messages = [{ role: "developer", content: "Dev instructions." }]
    const result = buildSystemPrompt(messages, {})
    assert.ok(result.includes("Dev instructions."))
  })

  it("always includes the proxy hint lines", () => {
    const result = buildSystemPrompt([], {})
    assert.ok(result.includes("proxy backed by OpenCode"))
    assert.ok(result.includes("Return only the assistant"))
  })

  it("does not turn generation controls into prompt hints", () => {
    const baseline = buildSystemPrompt([], {})
    assert.equal(buildSystemPrompt([], { temperature: 0.7 }), baseline)
    assert.equal(buildSystemPrompt([], { max_completion_tokens: 512, max_tokens: 256 }), baseline)
  })

  it("ignores non-system roles", () => {
    const messages = [
      { role: "user", content: "user message" },
      { role: "assistant", content: "assistant message" },
    ]
    const result = buildSystemPrompt(messages, {})
    assert.ok(!result.includes("user message"))
    assert.ok(!result.includes("assistant message"))
  })
})

// ---------------------------------------------------------------------------
// Unit: buildPrompt
// ---------------------------------------------------------------------------
describe("buildPrompt", () => {
  it("returns fallback for empty messages", () => {
    assert.equal(buildPrompt([]), "Say hello.")
  })

  it("returns bare content for single user message", () => {
    const messages = [{ role: "user", content: "What is 2+2?" }]
    assert.equal(buildPrompt(messages), "What is 2+2?")
  })

  it("builds a transcript for multi-turn conversations", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]
    const result = buildPrompt(messages)
    assert.ok(result.includes("USER:\nHello"))
    assert.ok(result.includes("ASSISTANT:\nHi there"))
    assert.ok(result.includes("USER:\nHow are you?"))
    assert.ok(result.includes("Continue the conversation"))
  })

  it("excludes system messages from the transcript", () => {
    const messages = [
      { role: "system", content: "System instruction" },
      { role: "user", content: "User question" },
    ]
    const result = buildPrompt(messages)
    assert.ok(!result.includes("System instruction"))
    assert.equal(result, "User question")
  })
})

// ---------------------------------------------------------------------------
// Unit: extractAssistantText
// ---------------------------------------------------------------------------
describe("extractAssistantText", () => {
  it("joins text parts", () => {
    const parts = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]
    assert.equal(extractAssistantText(parts), "Hello world")
  })

  it("ignores non-text parts", () => {
    const parts = [
      { type: "tool_use", id: "1" },
      { type: "text", text: "answer" },
    ]
    assert.equal(extractAssistantText(parts), "answer")
  })

  it("returns empty string for empty array", () => {
    assert.equal(extractAssistantText([]), "")
  })

  it("trims surrounding whitespace", () => {
    const parts = [{ type: "text", text: "  trimmed  " }]
    assert.equal(extractAssistantText(parts), "trimmed")
  })
})

// ---------------------------------------------------------------------------
// Unit: mapFinishReason
// ---------------------------------------------------------------------------
describe("mapFinishReason", () => {
  it("returns 'stop' for undefined", () => {
    assert.equal(mapFinishReason(undefined), "stop")
  })

  it("returns 'stop' for null", () => {
    assert.equal(mapFinishReason(null), "stop")
  })

  it("returns 'length' when finish includes 'length'", () => {
    assert.equal(mapFinishReason("max_length"), "length")
    assert.equal(mapFinishReason("length"), "length")
  })

  it("returns 'tool_calls' when finish includes 'tool'", () => {
    assert.equal(mapFinishReason("tool_use"), "tool_calls")
    assert.equal(mapFinishReason("tool"), "tool_calls")
  })

  it("returns 'stop' for unrecognised values", () => {
    assert.equal(mapFinishReason("end_turn"), "stop")
    assert.equal(mapFinishReason("stop"), "stop")
  })
})

// ---------------------------------------------------------------------------
// Unit: resolveModel
// ---------------------------------------------------------------------------
describe("resolveModel", () => {
  function makeClient(providers) {
    return {
      config: {
        providers: async () => ({ data: { providers } }),
      },
    }
  }

  const providers = [
    {
      id: "openai",
      models: {
        "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
        "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      },
    },
    {
      id: "anthropic",
      models: {
        "claude-3-5-sonnet": { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
      },
    },
  ]

  it("resolves a fully-qualified provider/model ID", async () => {
    const client = makeClient(providers)
    const model = await resolveModel(client, "openai/gpt-4o")
    assert.equal(model.providerID, "openai")
    assert.equal(model.modelID, "gpt-4o")
  })

  it("resolves an unambiguous bare model ID", async () => {
    const client = makeClient(providers)
    const model = await resolveModel(client, "claude-3-5-sonnet")
    assert.equal(model.providerID, "anthropic")
    assert.equal(model.modelID, "claude-3-5-sonnet")
  })

  it("throws for an unknown model", async () => {
    const client = makeClient(providers)
    await assert.rejects(
      () => resolveModel(client, "unknown-model"),
      /Unknown model/,
    )
  })

  it("throws for an ambiguous bare model ID present in multiple providers", async () => {
    const ambiguousProviders = [
      { id: "providerA", models: { shared: { id: "shared" } } },
      { id: "providerB", models: { shared: { id: "shared" } } },
    ]
    const client = makeClient(ambiguousProviders)
    await assert.rejects(
      () => resolveModel(client, "shared"),
      /ambiguous/,
    )
  })

  it("resolves with providerOverride when bare model matches", async () => {
    const client = makeClient(providers)
    const model = await resolveModel(client, "gpt-4o", "openai")
    assert.equal(model.providerID, "openai")
    assert.equal(model.modelID, "gpt-4o")
  })

  it("resolves fully-qualified ID with a matching providerOverride", async () => {
    const client = makeClient(providers)
    const model = await resolveModel(client, "openai/gpt-4o-mini", "openai")
    assert.equal(model.providerID, "openai")
    assert.equal(model.modelID, "gpt-4o-mini")
  })
})

// ---------------------------------------------------------------------------
// Unit: createSseQueue
// ---------------------------------------------------------------------------
describe("createSseQueue", () => {
  it("enqueue followed by generateChunks yields the value", async () => {
    const queue = createSseQueue()
    queue.enqueue("hello")
    queue.finish()
    const results = []
    for await (const chunk of queue.generateChunks()) {
      results.push(chunk)
    }
    assert.deepEqual(results, ["hello"])
  })

  it("multiple enqueues before finish yields all values in order", async () => {
    const queue = createSseQueue()
    queue.enqueue("a")
    queue.enqueue("b")
    queue.enqueue("c")
    queue.finish()
    const results = []
    for await (const chunk of queue.generateChunks()) {
      results.push(chunk)
    }
    assert.deepEqual(results, ["a", "b", "c"])
  })

  it("finish with no enqueues yields nothing", async () => {
    const queue = createSseQueue()
    queue.finish()
    const results = []
    for await (const chunk of queue.generateChunks()) {
      results.push(chunk)
    }
    assert.deepEqual(results, [])
  })

  it("enqueue after generateChunks starts still yields the value", async () => {
    const queue = createSseQueue()
    // Start consuming before anything is enqueued
    const generatorPromise = (async () => {
      const results = []
      for await (const chunk of queue.generateChunks()) {
        results.push(chunk)
      }
      return results
    })()
    // Enqueue asynchronously
    await Promise.resolve()
    queue.enqueue("late")
    queue.finish()
    const results = await generatorPromise
    assert.deepEqual(results, ["late"])
  })
})

// ---------------------------------------------------------------------------
// Integration: GET /v1/models
// ---------------------------------------------------------------------------

function createModelsClient(providers = []) {
  return {
    app: { log: async () => {} },
    config: {
      providers: async () => ({ data: { providers } }),
    },
  }
}

test("GET /v1/models returns model list", async () => {
  const client = createModelsClient([
    {
      id: "openai",
      models: {
        "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
        "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      },
    },
    {
      id: "anthropic",
      models: {
        "claude-3-5-sonnet": { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
      },
    },
  ])
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/models")

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.object, "list")
  assert.ok(Array.isArray(body.data))
  assert.equal(body.data.length, 3)

  const ids = body.data.map((m) => m.id)
  assert.ok(ids.includes("openai/gpt-4o"))
  assert.ok(ids.includes("openai/gpt-4o-mini"))
  assert.ok(ids.includes("anthropic/claude-3-5-sonnet"))

  const first = body.data[0]
  assert.equal(first.object, "model")
  assert.ok("owned_by" in first)
  assert.ok("created" in first)
})

test("GET /v1/models returns empty list when no providers configured", async () => {
  const handler = createProxyFetchHandler(createModelsClient([]))
  const request = new Request("http://127.0.0.1:4010/v1/models")

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(body, { object: "list", data: [] })
})

test("GET /v1/models exposes rich OpenCode model metadata", async () => {
  const metadata = {
    capabilities: { input: { text: true, image: true }, output: { text: true } },
    limit: { context: 128000, output: 4096 },
    cost: { input: 1, output: 2 },
    status: "active",
    variants: { fast: { temperature: 0.2 } },
  }
  const response = await createProxyFetchHandler(createModelsClient([
    { id: "openai", models: { "gpt-rich": { id: "gpt-rich", name: "Rich Model", ...metadata } } },
  ]))(new Request("http://127.0.0.1:4010/v1/models"))
  const model = (await response.json()).data[0]

  assert.equal(model.root, "openai/gpt-rich")
  assert.deepEqual(model.x_opencode, {
    name: "Rich Model",
    status: metadata.status,
    capabilities: metadata.capabilities,
    limits: metadata.limit,
    variants: metadata.variants,
    cost: metadata.cost,
  })
})

test("GET /v1/models returns 500 when providers call throws", async () => {
  const client = {
    app: { log: async () => {} },
    config: {
      providers: async () => {
        throw new Error("upstream failure")
      },
    },
  }
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/models")

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.equal(body.error.type, "server_error")
})

// ---------------------------------------------------------------------------
// Integration: POST /v1/responses
// ---------------------------------------------------------------------------

function createResponsesClient(responseContent = "The answer is 42.") {
  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "anthropic",
              models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" } },
            },
          ],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-resp-1" } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: responseContent }],
          info: { tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
        },
      }),
    },
  }
}

test("POST /v1/responses returns a well-formed response object", async () => {
  const handler = createProxyFetchHandler(createResponsesClient("Hello from Claude."))
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      input: "Say hello.",
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.object, "response")
  assert.equal(body.status, "completed")
  assert.ok(body.id.startsWith("resp_"))
  assert.equal(body.output_text, "Hello from Claude.")
  assert.ok(Array.isArray(body.output))
  assert.equal(body.output[0].role, "assistant")
  assert.equal(body.usage.input_tokens, 20)
  assert.equal(body.usage.output_tokens, 8)
  assert.equal(body.usage.total_tokens, 28)
})

test("completed sessions are deleted when the client supports deletion", async () => {
  const client = createResponsesClient()
  const deleted = []
  client.session.delete = async (request) => deleted.push(request)

  const response = await createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", input: "hi" }),
  }))

  assert.equal(response.status, 200)
  assert.deepEqual(deleted, [{ path: { id: "sess-resp-1" } }])
})

test("structured output schema is forwarded and structured data is extracted", async () => {
  const client = createResponsesClient()
  let promptBody
  client.session.prompt = async ({ body }) => {
    promptBody = body
    return {
      data: {
        parts: [{ type: "text", text: "ignored" }],
        info: { structured: { answer: 42 }, tokens: { input: 1, output: 1 }, finish: "stop" },
      },
    }
  }
  const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
  const response = await createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      input: "answer",
      text: { format: { type: "json_schema", schema } },
    }),
  }))
  const body = await response.json()

  assert.deepEqual(promptBody.format, { type: "json_schema", schema })
  assert.equal(body.output_text, '{"answer":42}')
})

test("OpenAI image content is forwarded as an OpenCode file part", async () => {
  const client = createResponsesClient()
  let parts
  client.session.prompt = async ({ body }) => {
    parts = body.parts
    return { data: { parts: [{ type: "text", text: "seen" }], info: { tokens: {}, finish: "stop" } } }
  }
  const image = "data:image/png;base64,aGVsbG8="
  const response = await createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      input: [{ role: "user", content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: image }] }],
    }),
  }))

  assert.equal(response.status, 200)
  assert.deepEqual(parts[1], { type: "file", mime: "image/png", url: image })
})

test("model aliases fall back to the next target after an upstream failure", async () => {
  process.env.OPENCODE_LLM_PROXY_MODEL_ALIASES = JSON.stringify({ smart: ["openai/first", "openai/second"] })
  const attempted = []
  const client = createResponsesClient("fallback worked")
  client.config.providers = async () => ({ data: { providers: [{ id: "openai", models: {
    first: { id: "first" },
    second: { id: "second" },
  } }] } })
  client.session.prompt = async ({ body }) => {
    attempted.push(body.model.modelID)
    if (body.model.modelID === "first") throw new Error("temporary upstream failure")
    return { data: { parts: [{ type: "text", text: "fallback worked" }], info: { tokens: {}, finish: "stop" } } }
  }

  const response = await createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "smart", input: "hi" }),
  }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(attempted, ["first", "second"])
  assert.equal(body.model, "openai/second")
})

test("POST /v1/responses missing model returns 400", async () => {
  const handler = createProxyFetchHandler(createResponsesClient())
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hi" }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.ok(body.error.message.includes("model"))
})

test("POST /v1/responses empty input returns 400", async () => {
  const handler = createProxyFetchHandler(createResponsesClient())
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet", input: "   " }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.ok(body.error.message.includes("input"))
})

test("POST /v1/responses malformed JSON returns 400", async () => {
  const handler = createProxyFetchHandler(createResponsesClient())
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ bad json",
  })

  const response = await handler(request)

  assert.equal(response.status, 400)
})

test("POST /v1/responses unknown model returns a safe 400", async () => {
  const handler = createProxyFetchHandler(createModelsClient([])) // no providers
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nonexistent", input: "hi" }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error.message, "The requested model is unavailable.")
})

test("POST /v1/responses instructions field is incorporated", async () => {
  let capturedSystem = null
  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "anthropic", models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet" } } }],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-instr" } }),
      prompt: async ({ body }) => {
        capturedSystem = body.system
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
          },
        }
      },
    },
  }

  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      input: "What is 2+2?",
      instructions: "You are a math tutor.",
    }),
  })

  await handler(request)
  assert.ok(capturedSystem?.includes("You are a math tutor."))
})

test("POST /v1/responses stream: true returns SSE lifecycle events", async () => {
  const events = [
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "The answer",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: " is 42.",
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      input: "What is 6 times 7?",
    }),
  })

  const response = await handler(request)

  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"))

  const text = await response.text()
  assert.ok(text.includes("response.created"))
  assert.ok(text.includes("response.output_text.delta"))
  assert.ok(text.includes("The answer"))
  assert.ok(text.includes(" is 42."))
  assert.ok(text.includes("response.completed"))
})

test("POST /v1/responses stream: true emits content_part.done with accumulated text per OpenAI spec", async () => {
  const events = [
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "The answer",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: " is 42.",
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      input: "What is 6 times 7?",
    }),
  })

  const response = await handler(request)
  const text = await response.text()
  const parsed = parseSseStream(text)
  const names = parsed.map((e) => e.event)

  // Discriminator 1 (gap #3): output_text.done.text must be the accumulated content
  const outputTextDone = parsed.find((e) => e.event === "response.output_text.done")
  assert.ok(outputTextDone, "response.output_text.done event must be present")
  assert.equal(outputTextDone.data.text, "The answer is 42.")

  // Discriminator 2 (gap #2): content_part.done must be present with populated part.text
  const contentPartDone = parsed.find((e) => e.event === "response.content_part.done")
  assert.ok(contentPartDone, "response.content_part.done event must be present")
  assert.equal(contentPartDone.data.part.type, "output_text")
  assert.equal(contentPartDone.data.part.text, "The answer is 42.")
  assert.deepEqual(contentPartDone.data.part.annotations, [])

  // Ordering: output_text.done -> content_part.done -> output_item.done
  const idxOutputTextDone = names.indexOf("response.output_text.done")
  const idxContentPartDone = names.indexOf("response.content_part.done")
  const idxOutputItemDone = names.indexOf("response.output_item.done")
  assert.ok(idxOutputTextDone >= 0, "output_text.done must be in the stream")
  assert.ok(
    idxContentPartDone > idxOutputTextDone,
    "content_part.done must follow output_text.done",
  )
  assert.ok(
    idxOutputItemDone > idxContentPartDone,
    "output_item.done must follow content_part.done",
  )
})

test("POST /v1/responses stream: true with session.error emits response.failed", async () => {
  const events = [
    {
      type: "session.error",
      properties: {
        sessionID: "sess-123",
        error: { message: "Rate limit exceeded" },
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      input: "hi",
    }),
  })

  const response = await handler(request)
  assert.equal(response.status, 200)

  const text = await response.text()
  assert.ok(text.includes("response.failed") || text.includes("Rate limit exceeded"))
})

// ---------------------------------------------------------------------------
// Unit: normalizeAnthropicMessages
// ---------------------------------------------------------------------------
describe("normalizeAnthropicMessages", () => {
  it("passes through string content unchanged", () => {
    const input = [{ role: "user", content: "hello" }]
    assert.deepEqual(normalizeAnthropicMessages(input), [{ role: "user", content: "hello" }])
  })

  it("trims whitespace from string content", () => {
    const input = [{ role: "user", content: "  hi  " }]
    assert.deepEqual(normalizeAnthropicMessages(input), [{ role: "user", content: "hi" }])
  })

  it("joins text blocks from array content", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]
    assert.deepEqual(normalizeAnthropicMessages(input), [{ role: "user", content: "first\n\nsecond" }])
  })

  it("ignores non-text blocks in array content", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "image", source: {} },
          { type: "text", text: "only this" },
        ],
      },
    ]
    assert.deepEqual(normalizeAnthropicMessages(input), [{ role: "user", content: "only this" }])
  })

  it("drops messages with empty content", () => {
    const input = [
      { role: "user", content: "" },
      { role: "assistant", content: "response" },
    ]
    assert.deepEqual(normalizeAnthropicMessages(input), [{ role: "assistant", content: "response" }])
  })
})

// ---------------------------------------------------------------------------
// Unit: mapFinishReasonToAnthropic
// ---------------------------------------------------------------------------
describe("mapFinishReasonToAnthropic", () => {
  it("returns end_turn for undefined", () => {
    assert.equal(mapFinishReasonToAnthropic(undefined), "end_turn")
  })

  it("returns end_turn for null", () => {
    assert.equal(mapFinishReasonToAnthropic(null), "end_turn")
  })

  it("returns max_tokens when finish includes length", () => {
    assert.equal(mapFinishReasonToAnthropic("max_length"), "max_tokens")
  })

  it("returns tool_use when finish includes tool", () => {
    assert.equal(mapFinishReasonToAnthropic("tool_use"), "tool_use")
  })

  it("returns end_turn for unrecognised values", () => {
    assert.equal(mapFinishReasonToAnthropic("stop"), "end_turn")
  })
})

// ---------------------------------------------------------------------------
// Unit: normalizeGeminiContents
// ---------------------------------------------------------------------------
describe("normalizeGeminiContents", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeGeminiContents(null), [])
    assert.deepEqual(normalizeGeminiContents("string"), [])
  })

  it("converts user role and joins text parts", () => {
    const contents = [{ role: "user", parts: [{ text: "hello" }] }]
    assert.deepEqual(normalizeGeminiContents(contents), [{ role: "user", content: "hello" }])
  })

  it("maps model role to assistant", () => {
    const contents = [{ role: "model", parts: [{ text: "hi there" }] }]
    assert.deepEqual(normalizeGeminiContents(contents), [{ role: "assistant", content: "hi there" }])
  })

  it("joins multiple parts with double newline", () => {
    const contents = [{ role: "user", parts: [{ text: "line one" }, { text: "line two" }] }]
    assert.deepEqual(normalizeGeminiContents(contents), [{ role: "user", content: "line one\n\nline two" }])
  })

  it("drops items with no text content", () => {
    const contents = [
      { role: "user", parts: [{ text: "" }] },
      { role: "user", parts: [{ text: "kept" }] },
    ]
    assert.deepEqual(normalizeGeminiContents(contents), [{ role: "user", content: "kept" }])
  })
})

// ---------------------------------------------------------------------------
// Unit: extractGeminiSystemInstruction
// ---------------------------------------------------------------------------
describe("extractGeminiSystemInstruction", () => {
  it("returns null for null/undefined input", () => {
    assert.equal(extractGeminiSystemInstruction(null), null)
    assert.equal(extractGeminiSystemInstruction(undefined), null)
  })

  it("returns trimmed string for string input", () => {
    assert.equal(extractGeminiSystemInstruction("  be helpful  "), "be helpful")
  })

  it("joins parts array", () => {
    const si = { parts: [{ text: "be concise" }, { text: "and clear" }] }
    assert.equal(extractGeminiSystemInstruction(si), "be concise\n\nand clear")
  })

  it("returns null for object without parts", () => {
    assert.equal(extractGeminiSystemInstruction({ role: "system" }), null)
  })
})

// ---------------------------------------------------------------------------
// Unit: mapFinishReasonToGemini
// ---------------------------------------------------------------------------
describe("mapFinishReasonToGemini", () => {
  it("returns STOP for undefined", () => {
    assert.equal(mapFinishReasonToGemini(undefined), "STOP")
  })

  it("returns MAX_TOKENS when finish includes length", () => {
    assert.equal(mapFinishReasonToGemini("max_length"), "MAX_TOKENS")
  })

  it("returns STOP for tool_use", () => {
    assert.equal(mapFinishReasonToGemini("tool_use"), "STOP")
  })

  it("returns STOP for end_turn", () => {
    assert.equal(mapFinishReasonToGemini("end_turn"), "STOP")
  })
})

// ---------------------------------------------------------------------------
// Integration: POST /v1/messages (Anthropic Messages API)
// ---------------------------------------------------------------------------

function createAnthropicClient(responseContent = "Hello from Anthropic.") {
  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "anthropic",
              models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" } },
            },
          ],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-ant-1" } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: responseContent }],
          info: { tokens: { input: 15, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
        },
      }),
    },
  }
}

test("POST /v1/messages returns a well-formed Anthropic response", async () => {
  const handler = createProxyFetchHandler(createAnthropicClient("Hi there!"))
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Say hello." }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.type, "message")
  assert.equal(body.role, "assistant")
  assert.ok(body.id.startsWith("msg_"))
  assert.ok(Array.isArray(body.content))
  assert.equal(body.content[0].type, "text")
  assert.equal(body.content[0].text, "Hi there!")
  assert.equal(body.stop_reason, "end_turn")
  assert.equal(body.usage.input_tokens, 15)
  assert.equal(body.usage.output_tokens, 10)
})

test("POST /v1/messages system string is included in prompt", async () => {
  let capturedSystem = null
  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "anthropic", models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet" } } }],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-ant-sys" } }),
      prompt: async ({ body }) => {
        capturedSystem = body.system
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
          },
        }
      },
    },
  }

  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      system: "You are a pirate.",
      messages: [{ role: "user", content: "Hello." }],
    }),
  })

  await handler(request)
  assert.ok(capturedSystem?.includes("You are a pirate."))
})

test("POST /v1/messages system as content-block array is included in prompt", async () => {
  let capturedSystem = null
  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "anthropic", models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet" } } }],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-ant-sys-arr" } }),
      prompt: async ({ body }) => {
        capturedSystem = body.system
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
          },
        }
      },
    },
  }

  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      system: [{ type: "text", text: "You are a pirate." }],
      messages: [{ role: "user", content: "Hello." }],
    }),
  })

  await handler(request)
  assert.ok(capturedSystem?.includes("You are a pirate."))
})

test("POST /v1/messages system as multi-block array concatenates text", async () => {
  let capturedSystem = null
  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "anthropic", models: { "claude-3-5-sonnet": { id: "claude-3-5-sonnet" } } }],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-ant-sys-multi" } }),
      prompt: async ({ body }) => {
        capturedSystem = body.system
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
          },
        }
      },
    },
  }

  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-3-5-sonnet",
      system: [
        { type: "text", text: "Line one." },
        { type: "text", text: "Line two." },
      ],
      messages: [{ role: "user", content: "Hello." }],
    }),
  })

  await handler(request)
  assert.ok(capturedSystem?.includes("Line one."))
  assert.ok(capturedSystem?.includes("Line two."))
})

test("normalizeAnthropicSystem handles string, array, and edge cases", () => {
  assert.equal(normalizeAnthropicSystem("hello"), "hello")
  assert.equal(normalizeAnthropicSystem("  hi  "), "hi")
  assert.equal(normalizeAnthropicSystem(""), null)
  assert.equal(normalizeAnthropicSystem("   "), null)
  assert.equal(normalizeAnthropicSystem([{ type: "text", text: "a" }]), "a")
  assert.equal(
    normalizeAnthropicSystem([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\n\nb",
  )
  assert.equal(normalizeAnthropicSystem([{ type: "image", source: {} }]), null)
  assert.equal(normalizeAnthropicSystem([]), null)
  assert.equal(normalizeAnthropicSystem([{ type: "text", text: "" }]), null)
  assert.equal(normalizeAnthropicSystem(undefined), null)
  assert.equal(normalizeAnthropicSystem(null), null)
  assert.equal(normalizeAnthropicSystem(42), null)
  assert.equal(normalizeAnthropicSystem([null, { type: "text", text: "x" }]), "x")
})

test("POST /v1/messages missing model returns Anthropic error format", async () => {
  const handler = createProxyFetchHandler(createAnthropicClient())
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.type, "error")
  assert.ok(body.error.type === "invalid_request_error")
  assert.ok(body.error.message.includes("model"))
})

test("POST /v1/messages missing messages returns 400", async () => {
  const handler = createProxyFetchHandler(createAnthropicClient())
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-3-5-sonnet" }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.type, "error")
})

test("POST /v1/messages malformed JSON returns 400", async () => {
  const handler = createProxyFetchHandler(createAnthropicClient())
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ bad json",
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.type, "error")
})

test("POST /v1/messages stream: true returns Anthropic SSE events", async () => {
  const events = [
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "Hello",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: " world",
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)

  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"))

  const text = await response.text()
  assert.ok(text.includes("message_start"))
  assert.ok(text.includes("content_block_start"))
  assert.ok(text.includes("content_block_delta"))
  assert.ok(text.includes("Hello"))
  assert.ok(text.includes(" world"))
  assert.ok(text.includes("message_stop"))
})

test("POST /v1/messages stream: true with session.error emits SSE error event", async () => {
  const events = [
    {
      type: "session.error",
      properties: {
        sessionID: "sess-123",
        error: { message: "Model overloaded" },
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  const handler = createProxyFetchHandler(createStreamingClient(events))
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  const response = await handler(request)
  assert.equal(response.status, 200)

  const text = await response.text()
  assert.ok(text.includes("error") || text.includes("Model overloaded"))
})

// ---------------------------------------------------------------------------
// Integration: POST /v1beta/models/:model:generateContent (Gemini API)
// ---------------------------------------------------------------------------

function createGeminiClient(responseContent = "Hello from Gemini.") {
  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "google",
              models: { "gemini-2.0-flash": { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" } },
            },
          ],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-gem-1" } }),
      prompt: async () => ({
        data: {
          parts: [{ type: "text", text: responseContent }],
          info: { tokens: { input: 12, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
        },
      }),
    },
  }
}

test("POST /v1beta/models/gemini-2.0-flash:generateContent returns Gemini response", async () => {
  const handler = createProxyFetchHandler(createGeminiClient("Gemini says hi!"))
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Say hi." }] }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.ok(Array.isArray(body.candidates))
  assert.equal(body.candidates[0].content.role, "model")
  assert.equal(body.candidates[0].content.parts[0].text, "Gemini says hi!")
  assert.equal(body.candidates[0].finishReason, "STOP")
  assert.equal(body.usageMetadata.promptTokenCount, 12)
  assert.equal(body.usageMetadata.candidatesTokenCount, 7)
  assert.equal(body.usageMetadata.totalTokenCount, 19)
})

test("POST /v1beta/models/:model:generateContent systemInstruction is included", async () => {
  let capturedSystem = null
  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "google", models: { "gemini-2.0-flash": { id: "gemini-2.0-flash" } } }],
        },
      }),
    },
    session: {
      create: async () => ({ data: { id: "sess-gem-sys" } }),
      prompt: async ({ body }) => {
        capturedSystem = body.system
        return {
          data: {
            parts: [{ type: "text", text: "ok" }],
            info: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "end_turn" },
          },
        }
      },
    },
  }

  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Hello." }] }],
      systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
    }),
  })

  await handler(request)
  assert.ok(capturedSystem?.includes("You are a helpful assistant."))
})

test("POST /v1beta/models/:model:generateContent missing contents returns 400", async () => {
  const handler = createProxyFetchHandler(createGeminiClient())
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generationConfig: { maxOutputTokens: 100 } }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.ok(body.error.message.includes("contents"))
})

test("POST /v1beta/models/:model:generateContent malformed JSON returns 400", async () => {
  const handler = createProxyFetchHandler(createGeminiClient())
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  })

  const response = await handler(request)

  assert.equal(response.status, 400)
})

test("POST /v1beta/models/:model:streamGenerateContent returns NDJSON stream", async () => {
  const events = [
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "Gem",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "sess-123",
        field: "text",
        delta: "ini",
      },
    },
    { type: "session.idle", properties: { sessionID: "sess-123" } },
  ]

  // Use streaming client but swap provider to google
  const streamingClient = createStreamingClient(events)
  streamingClient.config = {
    providers: async () => ({
      data: {
        providers: [
          { id: "google", models: { "gemini-2.0-flash": { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" } } },
        ],
      },
    }),
  }

  const handler = createProxyFetchHandler(streamingClient)
  const request = new Request(
    "http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Stream this." }] }],
      }),
    },
  )

  const response = await handler(request)

  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type")?.includes("application/x-ndjson"))

  const text = await response.text()
  // Should contain NDJSON lines with candidates
  assert.ok(text.includes("candidates"))
  assert.ok(text.includes("Gem"))
  assert.ok(text.includes("ini"))
})

// ---------------------------------------------------------------------------
// Unit: tool parsing / tool_choice helpers
// ---------------------------------------------------------------------------

test("sanitizeToolName replaces invalid characters and de-duplicates", () => {
  assert.equal(sanitizeToolName("get_weather"), "get_weather")
  assert.equal(sanitizeToolName("get-weather.v2"), "get_weather_v2")
  assert.equal(sanitizeToolName("123start"), "t_123start")
  assert.equal(sanitizeToolName(""), "tool")

  const seen = new Set()
  assert.equal(sanitizeToolName("dup", seen), "dup")
  assert.equal(sanitizeToolName("dup", seen), "dup_2")
  assert.equal(sanitizeToolName("dup", seen), "dup_3")
})

test("parseOpenAITools extracts function tools (Chat Completions nested shape)", () => {
  const tools = parseOpenAITools({
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
      { type: "function", function: { name: "no_params" } },
      { type: "not_function", function: { name: "ignored" } },
    ],
  })

  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, "get_weather")
  assert.equal(tools[0].description, "Get the weather")
  assert.deepEqual(tools[0].parameters, { type: "object", properties: { city: { type: "string" } } })
  assert.equal(tools[1].name, "no_params")
  assert.deepEqual(tools[1].parameters, { type: "object", properties: {} })
})

test("parseOpenAITools extracts function tools (Responses API flat shape)", () => {
  const tools = parseOpenAITools({
    tools: [
      { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } },
    ],
  })

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "get_weather")
})

test("parseOpenAITools supports legacy 'functions' field", () => {
  const tools = parseOpenAITools({ functions: [{ name: "legacy_fn", description: "d" }] })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "legacy_fn")
})

test("parseOpenAITools returns empty array when no tools present", () => {
  assert.deepEqual(parseOpenAITools({}), [])
})

test("applyOpenAIToolChoice filters to a single named function, or none, or unchanged", () => {
  const tools = [{ name: "a", description: "", parameters: {} }, { name: "b", description: "", parameters: {} }]
  assert.deepEqual(applyOpenAIToolChoice(tools, "none"), [])
  assert.deepEqual(applyOpenAIToolChoice(tools, "auto"), tools)
  assert.deepEqual(
    applyOpenAIToolChoice(tools, { type: "function", function: { name: "b" } }).map((t) => t.name),
    ["b"],
  )
  assert.deepEqual(applyOpenAIToolChoice(tools, { type: "function", name: "a" }).map((t) => t.name), ["a"])
})

test("parseAnthropicTools extracts tools with input_schema", () => {
  const tools = parseAnthropicTools({
    tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
  })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "get_weather")
  assert.deepEqual(tools[0].parameters, { type: "object" })
})

test("applyAnthropicToolChoice supports none and named tool", () => {
  const tools = [{ name: "a" }, { name: "b" }]
  assert.deepEqual(applyAnthropicToolChoice(tools, { type: "none" }), [])
  assert.deepEqual(applyAnthropicToolChoice(tools, { type: "tool", name: "a" }).map((t) => t.name), ["a"])
  assert.deepEqual(applyAnthropicToolChoice(tools, { type: "auto" }), tools)
})

test("parseGeminiTools flattens functionDeclarations across tool groups", () => {
  const tools = parseGeminiTools({
    tools: [
      { functionDeclarations: [{ name: "get_weather", description: "d", parameters: { type: "object" } }] },
      { functionDeclarations: [{ name: "get_time" }] },
    ],
  })
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, "get_weather")
  assert.equal(tools[1].name, "get_time")
})

test("applyGeminiToolChoice supports NONE mode and allowedFunctionNames", () => {
  const tools = [{ name: "a" }, { name: "b" }]
  assert.deepEqual(applyGeminiToolChoice(tools, { functionCallingConfig: { mode: "NONE" } }), [])
  assert.deepEqual(
    applyGeminiToolChoice(tools, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["b"] } }).map(
      (t) => t.name,
    ),
    ["b"],
  )
  assert.deepEqual(applyGeminiToolChoice(tools, undefined), tools)
})

// ---------------------------------------------------------------------------
// Unit: tool-call round-tripping in conversation history normalizers
// ---------------------------------------------------------------------------

test("normalizeMessages renders prior OpenAI tool_calls and tool results as text", () => {
  const messages = normalizeMessages([
    { role: "user", content: "What's the weather in NYC?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "Sunny, 72F" },
  ])

  assert.equal(messages.length, 3)
  assert.ok(messages[1].content.includes("get_weather"))
  assert.ok(messages[1].content.includes('{"city":"NYC"}'))
  assert.ok(messages[2].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("Sunny, 72F"))
})

test("normalizeAnthropicMessages renders prior tool_use and tool_result blocks as text", () => {
  const messages = normalizeAnthropicMessages([
    { role: "user", content: "What's the weather in NYC?" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NYC" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny, 72F" }],
    },
  ])

  assert.equal(messages.length, 3)
  assert.ok(messages[1].content.includes("get_weather"))
  assert.ok(messages[1].content.includes("NYC"))
  assert.ok(messages[2].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("Sunny, 72F"))
})

test("normalizeGeminiContents renders prior functionCall and functionResponse parts as text", () => {
  const messages = normalizeGeminiContents([
    { role: "user", parts: [{ text: "What's the weather in NYC?" }] },
    { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: "72F" } } }] },
  ])

  assert.equal(messages.length, 3)
  assert.ok(messages[1].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("72F"))
})

test("normalizeResponseInput renders prior function_call and function_call_output items as text", () => {
  const messages = normalizeResponseInput([
    { role: "user", content: "What's the weather in NYC?" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' },
    { type: "function_call_output", call_id: "call_1", output: "Sunny, 72F" },
  ])

  assert.equal(messages.length, 3)
  assert.ok(messages[1].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("get_weather"))
  assert.ok(messages[2].content.includes("Sunny, 72F"))
})

// ---------------------------------------------------------------------------
// Integration: end-to-end tool calling via the dynamic MCP bridge
// ---------------------------------------------------------------------------

function createToolCallClient({ toolName, toolArgs, callID = "call_1", finish = "tool_calls", providers } = {}) {
  let capturedSlotName = null

  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: providers ?? [{ id: "openai", models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } } }],
        },
      }),
    },
    mcp: {
      disconnect: async () => {
        throw new Error("not connected")
      },
      add: async ({ body }) => {
        capturedSlotName = body.name
        assert.equal(body.config.type, "local")
        assert.ok(Array.isArray(body.config.command))
        return { data: {} }
      },
    },
    session: {
      create: async () => ({ data: { id: "sess-tool-1" } }),
      promptAsync: async () => {},
      abort: async () => ({ data: true }),
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              finish,
            },
            parts: [],
          },
        ],
      }),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          const tool = `${capturedSlotName}_${toolName}`
          // Real OpenCode lifecycle: input is empty on "pending" and only populated on
          // "running"; the tool-calling step ends with a step-finish for the same message.
          yield {
            type: "message.part.updated",
            properties: {
              part: { sessionID: "sess-tool-1", messageID: "msg-1", type: "tool", tool, callID, state: { status: "pending", input: {} } },
            },
          }
          yield {
            type: "message.part.updated",
            properties: {
              part: { sessionID: "sess-tool-1", messageID: "msg-1", type: "tool", tool, callID, state: { status: "running", input: toolArgs } },
            },
          }
          yield {
            type: "message.part.updated",
            properties: { part: { sessionID: "sess-tool-1", messageID: "msg-1", type: "step-finish" } },
          }
        })(),
      }),
    },
  }
}

test("POST /v1/chat/completions returns tool_calls when the model calls a caller-supplied tool", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" } })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.equal(body.choices[0].message.content, null)
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "get_weather")
  assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { city: "NYC" })
  assert.equal(body.choices[0].message.tool_calls[0].id, "call_1")
})

test("POST /v1/chat/completions stream: true emits tool_calls delta and finish_reason", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" } })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
    }),
  })

  const response = await handler(request)
  const text = await response.text()

  assert.ok(text.includes('"tool_calls"'))
  assert.ok(text.includes("get_weather"))
  assert.ok(text.includes('"finish_reason":"tool_calls"'))
})

test("POST /v1/messages returns tool_use content block when the model calls a tool", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" }, callID: "toolu_1" })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.stop_reason, "tool_use")
  assert.equal(body.content[0].type, "tool_use")
  assert.equal(body.content[0].name, "get_weather")
  assert.equal(body.content[0].id, "toolu_1")
  assert.deepEqual(body.content[0].input, { city: "NYC" })
})

test("POST /v1/messages stream: true emits a tool_use content block", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" }, callID: "toolu_1" })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [{ name: "get_weather" }],
    }),
  })

  const response = await handler(request)
  const text = await response.text()

  assert.ok(text.includes("tool_use"))
  assert.ok(text.includes("get_weather"))
  assert.ok(text.includes('"stop_reason":"tool_use"'))
})

// Regression test for: OpenCode delivers real incremental streaming text via
// message.part.delta events (flat properties: sessionID, partID, field, delta) - a
// completely separate event type from message.part.updated, which only carries status/
// snapshot updates (used here for tool-call detection). For some turns (observed with a
// multi-message conversation history, e.g. continuing after a prior tool call/result),
// OpenCode never emits message.part.delta at all for the final reply - only
// message.part.updated snapshots - so relying on message.part.delta alone would silently
// produce empty content. The fallback: after the loop, fetch the session's messages
// (client.session.messages()) and extract the final text from the assistant message's
// parts array directly, exactly as the non-tool-calling path already does via
// extractAssistantText().
//
// Each list item from client.session.messages() is `{ info: Message, parts: Part[] }` -
// info.role/info.tokens/info.finish, NOT flat role/tokens/finish directly on the item.
function createToolAwareTextClient({ events, assistantParts, tokens, finish }) {
  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: { providers: [{ id: "openai", models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } } }] },
      }),
    },
    mcp: {
      disconnect: async () => {
        throw new Error("not connected")
      },
      add: async () => ({ data: {} }),
    },
    session: {
      create: async () => ({ data: { id: "sess-text-1" } }),
      promptAsync: async () => {},
      abort: async () => ({ data: true }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", tokens, finish },
            parts: assistantParts,
          },
        ],
      }),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          for (const event of events) yield event
        })(),
      }),
    },
  }
}

test("POST /v1/chat/completions falls back to the final message's parts when message.part.delta never fires", async () => {
  const client = createToolAwareTextClient({
    events: [{ type: "session.idle", properties: { sessionID: "sess-text-1" } }],
    assistantParts: [{ type: "step-start" }, { type: "text", text: "Agentic AI startups raise record funding" }],
    tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Search the web then summarize." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "some search result" },
      ],
      tools: [{ type: "function", function: { name: "search" } }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.choices[0].message.content, "Agentic AI startups raise record funding")
  assert.equal(body.choices[0].finish_reason, "stop")
  // Also locks in the .info.tokens fix - these were always read as undefined (silently
  // falling back to all-zero usage) before, since the flat .tokens field this code used
  // to read doesn't exist on the real API's { info, parts } shape.
  assert.equal(body.usage.prompt_tokens, 42)
  assert.equal(body.usage.completion_tokens, 7)
})

test("POST /v1/chat/completions accumulates content from message.part.delta events", async () => {
  const client = createToolAwareTextClient({
    events: [
      { type: "message.part.delta", properties: { sessionID: "sess-text-1", field: "text", delta: "Hello" } },
      { type: "message.part.delta", properties: { sessionID: "sess-text-1", field: "text", delta: " world" } },
      { type: "session.idle", properties: { sessionID: "sess-text-1" } },
    ],
    assistantParts: [{ type: "text", text: "Hello world" }],
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Say hello world." }],
      tools: [{ type: "function", function: { name: "search" } }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.choices[0].message.content, "Hello world")
})

// Regression test for: a bridge slot reused by an earlier turn stays connected under its
// old tool schema (OpenCode has no MCP deregistration endpoint), and getDisabledTools()
// only snapshots OpenCode's built-in tool IDs once, before any bridge tools ever exist -
// so neither mechanism disables a stale, previously-registered bridge tool ID on its own.
// Without explicitly disabling every previously-seen bridge tool ID per turn, a stale tool
// from an earlier turn's slot remains implicitly enabled and can be called by the model
// instead of (or alongside) the current turn's own tool.
describe("buildToolsMap / registerToolBridge slot isolation", () => {
  function createMcpMockClient() {
    const addCalls = []
    return {
      client: {
        mcp: {
          disconnect: async () => {
            throw new Error("not connected")
          },
          add: async ({ body }) => {
            addCalls.push(body)
            return { data: {} }
          },
        },
      },
      addCalls,
    }
  }

  it("disables a previously-registered bridge tool ID from a different pool slot", async () => {
    const { client } = createMcpMockClient()

    const firstTurnTools = [{ name: "weather_a", description: "", parameters: { type: "object", properties: {} } }]
    const secondTurnTools = [{ name: "weather_b", description: "", parameters: { type: "object", properties: {} } }]

    // Simulate turn 1: registers a bridge slot and (per the real bug) never gets
    // explicitly disabled afterwards, since OpenCode can't deregister an MCP server.
    const bridge1 = await registerToolBridge(client, firstTurnTools)
    assert.equal(bridge1.toolIDs.length, 1)

    // Simulate turn 2 reusing a *different* slot (mirrors the pool cycling to the next
    // free slot for a new in-flight request) with its own, different tool.
    const bridge2 = await registerToolBridge(client, secondTurnTools)
    assert.equal(bridge2.toolIDs.length, 1)
    assert.notEqual(
      bridge1.toolIDs[0],
      bridge2.toolIDs[0],
      "test setup assumption: the two turns must land on different bridge tool IDs",
    )

    // Release both acquired slots back to the shared pool once we're done with them -
    // otherwise, since the pool is a fixed-size global resource shared across the whole
    // test process, leaking slots here could exhaust it and make later
    // acquireBridgeSlot() calls (in other tests, or a re-run) hang forever waiting for
    // a free slot.
    after(() => {
      releaseToolBridge(bridge1)
      releaseToolBridge(bridge2)
    })

    const baseTools = { bash: false, read: false, edit: false }
    const toolsMap = buildToolsMap(baseTools, bridge2)

    // Turn 2's own tool must be enabled.
    assert.equal(toolsMap[bridge2.toolIDs[0]], true)
    // Turn 1's stale, still-connected tool must be *explicitly* disabled - not merely
    // absent from the map, since an absent key left a live MCP tool implicitly enabled
    // (the actual bug: the model could call it instead of turn 2's own tool).
    assert.equal(toolsMap[bridge1.toolIDs[0]], false)
    // OpenCode's built-ins must be untouched.
    assert.equal(toolsMap.bash, false)
    assert.equal(toolsMap.read, false)
    assert.equal(toolsMap.edit, false)
  })

  it("returns a plain copy of baseTools when there is no bridge for this turn", () => {
    const baseTools = { bash: false, read: false }
    const toolsMap = buildToolsMap(baseTools, null)
    assert.deepEqual(toolsMap, baseTools)
    assert.notEqual(toolsMap, baseTools, "must be a copy, not the same object")
  })

  // Regression test for: if registerToolBridge() throws after acquireBridgeSlot() has
  // already handed out a slot (e.g. client.mcp.add() fails to spawn/register the
  // bridge process), the slot must still be released back to the pool. Otherwise the
  // caller never gets a bridge object back to release via the normal
  // releaseToolBridge()-in-a-finally path in runAgentTurn() - the slot would be lost
  // forever, and enough repeated failures would eventually exhaust the whole pool and
  // hang every future tool-calling request in acquireBridgeSlot().
  it("releases the acquired slot back to the pool when registration fails after acquiring it", async () => {
    let shouldFail = true
    const client = {
      mcp: {
        disconnect: async () => {
          throw new Error("not connected")
        },
        add: async () => {
          if (shouldFail) throw new Error("simulated client.mcp.add failure")
          return { data: {} }
        },
      },
    }
    const tools = [{ name: "flaky_tool", description: "", parameters: { type: "object", properties: {} } }]

    // We can't directly inspect the pool's internals from here, but repeating the same
    // failure many times in a row (comfortably more than the pool size, so this would
    // exhaust it if any single one leaked its slot) and then confirming one more
    // registration still succeeds - rather than hanging forever waiting for a free
    // slot in acquireBridgeSlot() - only holds if every failure released its slot.
    // Wrap the whole sequence in a timeout race so a regression fails this test
    // clearly and quickly instead of hanging the suite: node:test has no default
    // per-test timeout, and a leaked-slot regression would hang acquireBridgeSlot()
    // forever with nothing else to catch it.
    const timeout = delay(2000).then(() => {
      throw new Error("timed out - one or more slots were leaked, not released")
    })

    const bridge = await Promise.race([
      (async () => {
        for (let i = 0; i < 20; i++) {
          await assert.rejects(() => registerToolBridge(client, tools), /simulated client\.mcp\.add failure/)
        }
        shouldFail = false
        return registerToolBridge(client, tools)
      })(),
      timeout,
    ])

    assert.ok(bridge.slotName)
    after(() => releaseToolBridge(bridge))
  })

  it("releases the bridge slot when event subscription fails", async () => {
    const state = globalThis.__opencodeOpenAIProxyState
    state.toolBridge = { freeSlots: ["px_tools_0"], waiters: [], slotToolIDs: new Map() }
    const client = createToolCallClient({ toolName: "flaky", toolArgs: {} })
    client.event.subscribe = async () => {
      throw new Error("subscribe failed")
    }
    client.session.delete = async () => {}

    const response = await createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "flaky" } }],
      }),
    }))

    assert.equal(response.status, 502)
    assert.deepEqual(state.toolBridge.freeSlots, ["px_tools_0"])
  })
})

test("POST /v1beta/models/:model:generateContent returns a functionCall part", async () => {
  const client = createToolCallClient({
    toolName: "get_weather",
    toolArgs: { city: "NYC" },
    providers: [{ id: "google", models: { "gemini-2.0-flash": { id: "gemini-2.0-flash" } } }],
  })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "What's the weather in NYC?" }] }],
      tools: [{ functionDeclarations: [{ name: "get_weather", description: "Get weather" }] }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.ok(body.candidates[0].content.parts[0].functionCall)
  assert.equal(body.candidates[0].content.parts[0].functionCall.name, "get_weather")
  assert.deepEqual(body.candidates[0].content.parts[0].functionCall.args, { city: "NYC" })
})

test("POST /v1/responses returns a function_call output item", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" } })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "What's the weather in NYC?",
      tools: [{ type: "function", name: "get_weather", description: "Get weather" }],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.output[0].type, "function_call")
  assert.equal(body.output[0].name, "get_weather")
  assert.deepEqual(JSON.parse(body.output[0].arguments), { city: "NYC" })
  assert.equal(body.output_text, "")
})

test("POST /v1/responses stream: true emits function_call SSE events", async () => {
  const client = createToolCallClient({ toolName: "get_weather", toolArgs: { city: "NYC" } })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      input: "What's the weather in NYC?",
      tools: [{ type: "function", name: "get_weather" }],
    }),
  })

  const response = await handler(request)
  const text = await response.text()

  assert.ok(text.includes("response.function_call_arguments.done"))
  assert.ok(text.includes("get_weather"))
  assert.ok(text.includes('"type":"function_call"'))
})

test("tool_choice: none disables tool calling even when tools are supplied", async () => {
  const events = [{ type: "session.idle", properties: { sessionID: "sess-123" } }]
  const client = createStreamingClient(events)
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      tool_choice: "none",
    }),
  })

  const response = await handler(request)
  assert.equal(response.status, 200)
  // No mcp/tool bridge client methods were exercised because callerTools resolved to [].
  assert.equal(client.mcp, undefined)
})

test("POST /v1beta/models/:model:streamGenerateContent emits a functionCall in the final chunk", async () => {
  const client = createToolCallClient({
    toolName: "get_weather",
    toolArgs: { city: "NYC" },
    providers: [{ id: "google", models: { "gemini-2.0-flash": { id: "gemini-2.0-flash" } } }],
  })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:streamGenerateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "What's the weather in NYC?" }] }],
      tools: [{ functionDeclarations: [{ name: "get_weather", description: "Get weather" }] }],
    }),
  })

  const response = await handler(request)
  const text = await response.text()
  const chunks = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const functionCall = chunks.at(-1).candidates[0].content.parts[0].functionCall

  assert.ok(functionCall)
  assert.equal(functionCall.name, "get_weather")
  assert.deepEqual(functionCall.args, { city: "NYC" })
})

// ---------------------------------------------------------------------------
// Integration: parallel tool calling (a single assistant turn requesting multiple
// tools at once). The completed assistant message is the authoritative source of the
// full set - it carries every tool part before the first goes pending - so the mock
// returns them all from session.messages() while the event stream only surfaces the
// first (which is what triggers the abort in runAgentTurn).
// ---------------------------------------------------------------------------

function createParallelToolCallClient({ tools, finish = "tool_calls", providers } = {}) {
  let capturedSlotName = null
  const toolPart = (tool, status, input) => ({
    sessionID: "sess-par-1",
    messageID: "msg-par-1",
    type: "tool",
    tool: `${capturedSlotName}_${tool.name}`,
    callID: tool.callID,
    state: { status, input },
  })

  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: providers ?? [{ id: "openai", models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o" } } }],
        },
      }),
    },
    mcp: {
      disconnect: async () => {
        throw new Error("not connected")
      },
      add: async ({ body }) => {
        capturedSlotName = body.name
        return { data: {} }
      },
    },
    session: {
      create: async () => ({ data: { id: "sess-par-1" } }),
      promptAsync: async () => {},
      abort: async () => ({ data: true }),
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
              finish,
            },
            parts: [{ type: "step-start" }, { type: "text", text: "" }, { type: "step-finish" }],
          },
        ],
      }),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          // Real OpenCode emits parallel tool calls sequentially within one assistant
          // message: each goes pending (empty input) then running (populated), and the
          // step ends with a single step-finish. All belong to the same messageID.
          for (const tool of tools) {
            yield { type: "message.part.updated", properties: { part: toolPart(tool, "pending", {}) } }
            yield { type: "message.part.updated", properties: { part: toolPart(tool, "running", tool.args) } }
          }
          yield {
            type: "message.part.updated",
            properties: { part: { sessionID: "sess-par-1", messageID: "msg-par-1", type: "step-finish" } },
          }
        })(),
      }),
    },
  }
}

const PARALLEL_TOOLS = [
  { name: "get_weather", args: { city: "NYC" }, callID: "call_1" },
  { name: "get_time", args: { tz: "EST" }, callID: "call_2" },
]

test("POST /v1/chat/completions returns multiple tool_calls for parallel tool use", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather and time?" }],
      tools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "get_time" } },
      ],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  const calls = body.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  assert.deepEqual(
    calls.map((c) => c.function.name),
    ["get_weather", "get_time"],
  )
  assert.deepEqual(
    calls.map((c) => c.id),
    ["call_1", "call_2"],
  )
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { tz: "EST" })
})

test("POST /v1/chat/completions stream emits parallel tool_calls with distinct indexes", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "weather and time?" }],
      tools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "get_time" } },
      ],
    }),
  })

  const response = await handler(request)
  const text = await response.text()
  const toolChunk = text
    .split("\n\n")
    .map((block) => block.replace(/^data: /, ""))
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line))
    .find((chunk) => chunk.choices?.[0]?.delta?.tool_calls)

  assert.ok(toolChunk, "expected a chunk carrying tool_calls")
  const calls = toolChunk.choices[0].delta.tool_calls
  assert.equal(calls.length, 2)
  assert.deepEqual(
    calls.map((c) => c.index),
    [0, 1],
  )
  assert.deepEqual(
    calls.map((c) => c.function.name),
    ["get_weather", "get_time"],
  )
  assert.ok(text.includes('"finish_reason":"tool_calls"'))
})

test("POST /v1/responses returns multiple function_call output items for parallel tool use", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "weather and time?",
      tools: [
        { type: "function", name: "get_weather" },
        { type: "function", name: "get_time" },
      ],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.output.length, 2)
  assert.deepEqual(
    body.output.map((item) => item.type),
    ["function_call", "function_call"],
  )
  assert.deepEqual(
    body.output.map((item) => item.name),
    ["get_weather", "get_time"],
  )
  assert.deepEqual(
    body.output.map((item) => item.call_id),
    ["call_1", "call_2"],
  )
  assert.equal(body.parallel_tool_calls, true)
})

test("POST /v1/responses stream emits parallel function_call items with distinct output_index", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      input: "weather and time?",
      tools: [
        { type: "function", name: "get_weather" },
        { type: "function", name: "get_time" },
      ],
    }),
  })

  const response = await handler(request)
  const text = await response.text()
  const doneEvents = parseSseStream(text).filter((e) => e.event === "response.output_item.done")

  assert.equal(doneEvents.length, 2)
  assert.deepEqual(
    doneEvents.map((e) => e.data.output_index),
    [0, 1],
  )
  assert.deepEqual(
    doneEvents.map((e) => e.data.item.name),
    ["get_weather", "get_time"],
  )
})

test("POST /v1/messages returns multiple tool_use blocks for parallel tool use", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [{ role: "user", content: "weather and time?" }],
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" } },
      ],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.stop_reason, "tool_use")
  assert.equal(body.content.length, 2)
  assert.deepEqual(
    body.content.map((block) => block.type),
    ["tool_use", "tool_use"],
  )
  assert.deepEqual(
    body.content.map((block) => block.name),
    ["get_weather", "get_time"],
  )
  assert.deepEqual(body.content[1].input, { tz: "EST" })
})

test("POST /v1/messages stream emits parallel tool_use blocks with distinct indexes", async () => {
  const client = createParallelToolCallClient({ tools: PARALLEL_TOOLS })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "weather and time?" }],
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" } },
      ],
    }),
  })

  const response = await handler(request)
  const text = await response.text()
  const starts = parseSseStream(text).filter(
    (e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use",
  )

  assert.equal(starts.length, 2)
  assert.deepEqual(
    starts.map((e) => e.data.index),
    [0, 1],
  )
  assert.deepEqual(
    starts.map((e) => e.data.content_block.name),
    ["get_weather", "get_time"],
  )
})

test("POST /v1beta/models/:model:generateContent returns multiple functionCall parts for parallel tool use", async () => {
  const client = createParallelToolCallClient({
    tools: PARALLEL_TOOLS,
    providers: [{ id: "google", models: { "gemini-2.0-flash": { id: "gemini-2.0-flash" } } }],
  })
  const handler = createProxyFetchHandler(client)
  const request = new Request("http://127.0.0.1:4010/v1beta/models/gemini-2.0-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "weather and time?" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "get_weather", description: "Get weather" },
            { name: "get_time", description: "Get time" },
          ],
        },
      ],
    }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 200)
  const parts = body.candidates[0].content.parts
  assert.equal(parts.length, 2)
  assert.deepEqual(
    parts.map((part) => part.functionCall.name),
    ["get_weather", "get_time"],
  )
  assert.deepEqual(parts[1].functionCall.args, { tz: "EST" })
})



describe("mcp-tool-bridge parseTools", () => {
  it("parses a valid JSON array", () => {
    const tools = parseTools('[{"name":"a"},{"name":"b"}]')
    assert.deepEqual(tools, [{ name: "a" }, { name: "b" }])
  })

  it("defaults to an empty array when input is undefined", () => {
    assert.deepEqual(parseTools(undefined), [])
  })

  it("returns an empty array and reports the error on malformed JSON", () => {
    let reported
    const tools = parseTools("{not json", (err) => {
      reported = err
    })
    assert.deepEqual(tools, [])
    assert.ok(reported instanceof Error)
  })

  it("returns an empty array when JSON is valid but not an array", () => {
    assert.deepEqual(parseTools('{"name":"a"}'), [])
  })
})

describe("mcp-tool-bridge dispatch", () => {
  it("responds to initialize with server info and the requested protocol version", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-01-01" } })
    assert.equal(response.jsonrpc, "2.0")
    assert.equal(response.id, 1)
    assert.equal(response.result.protocolVersion, "2025-01-01")
    assert.deepEqual(response.result.capabilities, { tools: {} })
    assert.equal(response.result.serverInfo.name, "opencode-llm-proxy-bridge")
  })

  it("falls back to the default protocol version when none is supplied", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" })
    assert.equal(response.result.protocolVersion, "2024-11-05")
  })

  it("maps tool schemas into MCP tools/list shape", () => {
    const tools = [
      { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: {} } } },
      { name: "no_desc" },
    ]
    const response = dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tools)
    assert.deepEqual(response.result.tools, [
      { name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: { city: {} } } },
      { name: "no_desc", description: "", inputSchema: { type: "object", properties: {} } },
    ])
  })

  it("returns an empty tools list when no tools are configured", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    assert.deepEqual(response.result.tools, [])
  })

  it("responds to ping with an empty result", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 4, method: "ping" })
    assert.deepEqual(response.result, {})
  })

  it("returns a placeholder text content for tools/call", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x" } })
    assert.equal(response.result.content[0].type, "text")
    assert.match(response.result.content[0].text, /intercepted by opencode-llm-proxy/)
  })

  it("returns null (no response) for notifications/initialized", () => {
    assert.equal(dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }), null)
  })

  it("returns null for a request without an id", () => {
    assert.equal(dispatch({ jsonrpc: "2.0", method: "ping" }), null)
  })

  it("returns a JSON-RPC method-not-found error for unknown methods", () => {
    const response = dispatch({ jsonrpc: "2.0", id: 6, method: "does/not/exist" })
    assert.equal(response.error.code, -32601)
    assert.match(response.error.message, /Method not found: does\/not\/exist/)
  })

  it("does not emit an error response for an unknown method without an id", () => {
    assert.equal(dispatch({ jsonrpc: "2.0", method: "does/not/exist" }), null)
  })

  it("rejects requests without jsonrpc 2.0", () => {
    assert.deepEqual(dispatch({ id: 1, method: "ping" }), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    })
  })
})

describe("mcp-tool-bridge runStdioServer", () => {
  function collect(stream) {
    const chunks = []
    stream.on("data", (chunk) => chunks.push(chunk.toString()))
    return () => chunks.join("")
  }

  it("processes newline-delimited requests and writes JSON-RPC responses", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const readOutput = collect(output)
    const readError = collect(errorOutput)
    let ended = false

    runStdioServer([{ name: "get_weather", description: "d", parameters: { type: "object" } }], {
      input,
      output,
      errorOutput,
      onEnd: () => {
        ended = true
      },
    })

    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n')
    input.write("\n") // blank line is ignored
    input.write("{ not valid json\n") // malformed line goes to errorOutput
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n') // notification -> no output
    input.end()

    await delay(10)

    const lines = readOutput()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(lines.length, 3)
    assert.deepEqual(lines[0], { jsonrpc: "2.0", id: 1, result: {} })
    assert.equal(lines[1].result.tools[0].name, "get_weather")
    assert.deepEqual(lines[2], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    assert.match(readError(), /failed to parse message/)
    assert.equal(ended, true)
  })

  it("reassembles a request split across multiple chunks", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const readOutput = collect(output)

    runStdioServer([], {
      input,
      output,
      errorOutput: new PassThrough(),
      onEnd: () => {},
    })

    input.write('{"jsonrpc":"2.0","id":')
    await delay(5)
    input.write('7,"method":"ping"}\n')
    await delay(5)

    assert.deepEqual(JSON.parse(readOutput().trim()), { jsonrpc: "2.0", id: 7, result: {} })
  })
})

// ---------------------------------------------------------------------------
// OpenAIProxyPlugin (plugin entrypoint / server bootstrap)
// ---------------------------------------------------------------------------

describe("OpenAIProxyPlugin", () => {
  const STATE_KEY = "__opencodeOpenAIProxyState"

  function withMockedBun(serve, run) {
    const savedBun = globalThis.Bun
    delete globalThis[STATE_KEY]
    globalThis.Bun = { serve }
    return Promise.resolve()
      .then(run)
      .finally(() => {
        if (savedBun === undefined) delete globalThis.Bun
        else globalThis.Bun = savedBun
        delete globalThis[STATE_KEY]
      })
  }

  it("starts a Bun server and records it in global state", async () => {
    const calls = []
    const fakeServer = { stopped: false }

    await withMockedBun(
      (opts) => {
        calls.push(opts)
        return fakeServer
      },
      async () => {
        process.env.OPENCODE_LLM_PROXY_HOST = "127.0.0.1"
        process.env.OPENCODE_LLM_PROXY_PORT = "4999"
        try {
          const result = await OpenAIProxyPlugin({ client: createClient() })

          assert.equal(typeof result["chat.params"], "function")
          assert.equal(calls.length, 1)
          assert.equal(calls[0].hostname, "127.0.0.1")
          assert.equal(calls[0].port, 4999)
          assert.equal(typeof calls[0].fetch, "function")
          assert.equal(globalThis[STATE_KEY].started, true)
          assert.equal(globalThis[STATE_KEY].server, fakeServer)
        } finally {
          delete process.env.OPENCODE_LLM_PROXY_HOST
          delete process.env.OPENCODE_LLM_PROXY_PORT
        }
      },
    )
  })

  it("chat.params applies captured generation controls", async () => {
    let hooks
    let releasePrompt
    const promptStarted = new Promise((resolve) => {
      releasePrompt = resolve
    })
    await withMockedBun(
      () => ({}),
      async () => {
        hooks = await OpenAIProxyPlugin({ client: createClient() })
        const client = createResponsesClient()
        client.session.prompt = async () => {
          releasePrompt()
          await delay(20)
          return { data: { parts: [{ type: "text", text: "ok" }], info: { tokens: {}, finish: "stop" } } }
        }
        const responsePromise = createProxyFetchHandler(client)(new Request("http://127.0.0.1:4010/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "anthropic/claude-3-5-sonnet",
            input: "hi",
            temperature: 0.4,
            top_p: 0.8,
          }),
        }))
        await promptStarted
        const output = {}
        await hooks["chat.params"]({ sessionID: "sess-resp-1" }, output)
        assert.deepEqual(output, { temperature: 0.4, topP: 0.8 })
        await responsePromise
      },
    )
  })

  it("does not start a second server when already started", async () => {
    let served = false

    await withMockedBun(
      () => {
        served = true
        return {}
      },
      async () => {
        globalThis[STATE_KEY] = { started: true }
        const result = await OpenAIProxyPlugin({ client: createClient() })

        assert.deepEqual(result, {})
        assert.equal(served, false)
      },
    )
  })

  it("returns gracefully when Bun.serve throws (e.g. port in use)", async () => {
    await withMockedBun(
      () => {
        throw new Error("EADDRINUSE: port already in use")
      },
      async () => {
        const result = await OpenAIProxyPlugin({ client: createClient() })

        assert.deepEqual(result, {})
        assert.equal(globalThis[STATE_KEY].server, undefined)
      },
    )
  })

  it("retries startup after Bun.serve fails", async () => {
    let attempts = 0
    await withMockedBun(
      () => {
        attempts++
        if (attempts === 1) throw new Error("temporary failure")
        return { started: true }
      },
      async () => {
        assert.deepEqual(await OpenAIProxyPlugin({ client: createClient() }), {})
        const hooks = await OpenAIProxyPlugin({ client: createClient() })
        assert.equal(attempts, 2)
        assert.equal(typeof hooks["chat.params"], "function")
      },
    )
  })

  it("refuses a non-loopback bind without a token", async () => {
    let served = false
    await withMockedBun(
      () => {
        served = true
        return {}
      },
      async () => {
        process.env.OPENCODE_LLM_PROXY_HOST = "0.0.0.0"
        try {
          assert.deepEqual(await OpenAIProxyPlugin({ client: createClient() }), {})
          assert.equal(served, false)
        } finally {
          delete process.env.OPENCODE_LLM_PROXY_HOST
        }
      },
    )
  })
})

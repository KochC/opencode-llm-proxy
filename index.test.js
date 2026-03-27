import test, { describe, it } from "node:test"
import assert from "node:assert/strict"

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
} from "./index.js"

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
            role: "assistant",
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "end_turn",
          },
        ],
      }),
    },
    event: {
      subscribe: async () => ({ stream: makeStream() }),
    },
  }
}

test("OPTIONS preflight returns CORS headers", async () => {
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
  assert.equal(response.headers.get("access-control-allow-origin"), "*")
  assert.equal(response.headers.get("access-control-allow-methods"), "POST")
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "authorization, content-type, x-opencode-provider",
  )
  assert.equal(response.headers.get("access-control-allow-private-network"), "true")
  assert.equal(response.headers.get("access-control-max-age"), "86400")
})

test("health response includes CORS headers", async () => {
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
        Origin: "https://app.example.com",
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

    // The header must be the configured origin, not the request's origin
    assert.equal(response.headers.get("access-control-allow-origin"), "https://allowed.example.com")
    assert.notEqual(response.headers.get("access-control-allow-origin"), "https://evil.example.com")
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN
  }
})

test("request with no Origin header is handled gracefully", async () => {
  const handler = createProxyFetchHandler(createClient())
  const request = new Request("http://127.0.0.1:4010/health")

  const response = await handler(request)

  assert.equal(response.status, 200)
  // CORS header is still present (wildcard default) even without an Origin
  assert.equal(response.headers.get("access-control-allow-origin"), "*")
})

test("OPTIONS preflight for disallowed origin returns configured origin, not request origin", async () => {
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

    assert.equal(response.status, 204)
    assert.equal(response.headers.get("access-control-allow-origin"), "https://allowed.example.com")
    assert.notEqual(response.headers.get("access-control-allow-origin"), "https://evil.example.com")
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
      type: "message.part.updated",
      properties: {
        part: { sessionID: "sess-123", type: "text" },
        delta: "Hello",
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { sessionID: "sess-123", type: "text" },
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

test("stream: true with unknown model returns 502", async () => {
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

  assert.equal(response.status, 502)
  assert.ok(body.error.message.includes("nonexistent-model"))
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

test("unknown model returns 502", async () => {
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

  assert.equal(response.status, 502)
  assert.ok(body.error.message.includes("nonexistent-model"))
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

  it("appends temperature hint when provided", () => {
    const result = buildSystemPrompt([], { temperature: 0.7 })
    assert.ok(result.includes("0.7"))
  })

  it("appends max_completion_tokens hint when provided", () => {
    const result = buildSystemPrompt([], { max_completion_tokens: 512 })
    assert.ok(result.includes("512"))
  })

  it("appends max_tokens hint when provided", () => {
    const result = buildSystemPrompt([], { max_tokens: 256 })
    assert.ok(result.includes("256"))
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

test("POST /v1/responses unknown model returns 502", async () => {
  const handler = createProxyFetchHandler(createModelsClient([])) // no providers
  const request = new Request("http://127.0.0.1:4010/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nonexistent", input: "hi" }),
  })

  const response = await handler(request)
  const body = await response.json()

  assert.equal(response.status, 502)
  assert.ok(body.error.message.includes("nonexistent"))
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
      type: "message.part.updated",
      properties: {
        part: { sessionID: "sess-123", type: "text" },
        delta: "The answer",
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { sessionID: "sess-123", type: "text" },
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

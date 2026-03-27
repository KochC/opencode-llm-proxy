import test, { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  createProxyFetchHandler,
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

// ---------------------------------------------------------------------------
// Unit: toTextContent
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
    assert.ok(result.includes("OpenAI-compatible proxy"))
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

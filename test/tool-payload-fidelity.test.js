import assert from "node:assert/strict"
import test, { beforeEach, describe } from "node:test"

import { createProxyFetchHandler } from "../index.js"

// Regression coverage for #93: structured tool payloads (nested objects, arrays,
// additionalProperties, caller-chosen key order) must survive translation between
// the OpenAI, Anthropic and Gemini formats unchanged, in both directions.

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENCODE_LLM_PROXY_")) delete process.env[name]
  }
})

const ROOT = "http://127.0.0.1:4010"
const MODEL = "test-model"
const TOOL = "uh_classify"

// Deliberately non-alphabetical keys, nesting, arrays, mixed types, nulls and a
// property literally named "type" - anything a lossy translation would disturb.
const PAYLOAD = {
  message: "Type mismatch in verifier",
  code: "E_TYPE",
  hint: {
    stage: "verify",
    failureClass: "type",
    type: "nested-field-named-type",
    ranked: [{ z: 1, a: 2 }, { score: 0.5, file: "src/a.ts", meta: null }],
    budget: { used: 1200, limit: 4000, unit: "tokens" },
  },
  flags: [true, false],
}

const SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    code: { type: "string", enum: ["E_TYPE", "E_TEST"] },
    hint: {
      type: "object",
      properties: { type: { type: "string" }, ranked: { type: "array", items: { type: "object" } } },
      additionalProperties: true,
    },
    flags: { type: "array", items: { type: "boolean" } },
  },
  required: ["message", "code"],
  additionalProperties: false,
}

function createClient(args = PAYLOAD) {
  const captured = { bridgeTools: null, prompt: null }
  let bridgeName

  async function* events() {
    for (const [status, input] of [["pending", {}], ["running", args]]) {
      yield {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "s1", messageID: "m1", type: "tool", tool: `${bridgeName}_${TOOL}`, callID: "call_1", state: { status, input } },
        },
      }
    }
    yield { type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m1", type: "step-finish" } } }
  }

  const client = {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({ data: { providers: [{ id: "test", models: { [MODEL]: { id: MODEL, name: MODEL } } }] } }),
    },
    mcp: {
      disconnect: async () => {},
      add: async ({ body }) => {
        bridgeName = body.name
        captured.bridgeTools = JSON.parse(body.config.environment.OPENCODE_LLM_PROXY_BRIDGE_TOOLS)
        return { data: {} }
      },
    },
    event: { subscribe: async () => ({ stream: events() }) },
    session: {
      create: async () => ({ data: { id: "s1" } }),
      promptAsync: async ({ body }) => {
        captured.prompt = body.parts[0].text
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      messages: async () => ({
        data: [{ info: { role: "assistant", tokens: { input: 1, output: 1 }, finish: "tool_calls" }, parts: [] }],
      }),
    },
  }
  return { client, captured }
}

function post(path, body) {
  return new Request(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function sse(text) {
  return text.split("\n\n").filter(Boolean).flatMap((block) => {
    const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7)
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    return data && data !== "[DONE]" ? [{ event, data: JSON.parse(data) }] : []
  })
}

// Order-sensitive equality: JSON.stringify compares key order as well as values.
function assertExact(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected))
}

const formats = [
  {
    name: "openai-chat",
    path: () => "/v1/chat/completions",
    body: (stream) => ({
      model: MODEL,
      stream,
      messages: [{ role: "user", content: "classify" }],
      tools: [{ type: "function", function: { name: TOOL, parameters: SCHEMA } }],
    }),
    args: (json) => JSON.parse(json.choices[0].message.tool_calls[0].function.arguments),
    streamArgs: (text) =>
      JSON.parse(
        sse(text)
          .flatMap(({ data }) => data.choices?.[0]?.delta?.tool_calls ?? [])
          .map((call) => call.function?.arguments ?? "")
          .join(""),
      ),
  },
  {
    name: "openai-responses",
    path: () => "/v1/responses",
    body: (stream) => ({
      model: MODEL,
      stream,
      input: "classify",
      tools: [{ type: "function", name: TOOL, parameters: SCHEMA }],
    }),
    args: (json) => JSON.parse(json.output.find((item) => item.type === "function_call").arguments),
    streamArgs: (text) =>
      JSON.parse(sse(text).find(({ event }) => event === "response.function_call_arguments.done").data.arguments),
  },
  {
    name: "anthropic",
    path: () => "/v1/messages",
    body: (stream) => ({
      model: MODEL,
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "classify" }],
      tools: [{ name: TOOL, input_schema: SCHEMA }],
    }),
    args: (json) => json.content.find((block) => block.type === "tool_use").input,
    streamArgs: (text) =>
      JSON.parse(
        sse(text)
          .filter(({ data }) => data.delta?.type === "input_json_delta")
          .map(({ data }) => data.delta.partial_json)
          .join(""),
      ),
  },
  {
    name: "gemini",
    path: (stream) => `/v1beta/models/${MODEL}:${stream ? "streamGenerateContent" : "generateContent"}`,
    body: () => ({
      contents: [{ role: "user", parts: [{ text: "classify" }] }],
      tools: [{ functionDeclarations: [{ name: TOOL, parametersJsonSchema: SCHEMA }] }],
    }),
    args: (json) => json.candidates[0].content.parts.find((part) => part.functionCall).functionCall.args,
    streamArgs: (text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
        .find((part) => part.functionCall).functionCall.args,
  },
]

describe("tool payload fidelity across API formats", () => {
  for (const format of formats) {
    for (const stream of [false, true]) {
      test(`${format.name}${stream ? " (streaming)" : ""}: schema and arguments survive unchanged`, async () => {
        const { client, captured } = createClient()
        const response = await createProxyFetchHandler(client)(post(format.path(stream), format.body(stream)))
        assert.equal(response.status, 200)
        // Streaming responses start before the bridge registers, so drain first.
        const text = await response.text()

        assertExact(captured.bridgeTools[0].parameters, SCHEMA)
        assertExact(stream ? format.streamArgs(text) : format.args(JSON.parse(text)), PAYLOAD)
      })
    }
  }
})

// Decodes the canonical transcript the proxy sends to OpenCode and returns every
// tool result's payload, parsed back to a value whether it was carried as text or JSON.
function toolResultPayloads(prompt) {
  return prompt
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .flatMap((message) => message.content.filter((part) => part.type === "tool_result"))
    .flatMap((result) => result.content)
    .map((part) => (part.type === "json" ? part.value : JSON.parse(part.text)))
}

const history = [
  {
    name: "openai-chat (string content)",
    path: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: [
        { role: "user", content: "classify" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: TOOL, arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: JSON.stringify(PAYLOAD) },
      ],
    },
  },
  {
    name: "openai-chat (object content)",
    path: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: [
        { role: "user", content: "classify" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: TOOL, arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: PAYLOAD },
      ],
    },
  },
  {
    name: "openai-responses",
    path: "/v1/responses",
    body: {
      model: MODEL,
      input: [
        { role: "user", content: "classify" },
        { type: "function_call", call_id: "c1", name: TOOL, arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: PAYLOAD },
      ],
    },
  },
  {
    name: "anthropic",
    path: "/v1/messages",
    body: {
      model: MODEL,
      max_tokens: 64,
      messages: [
        { role: "user", content: "classify" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: TOOL, input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: JSON.stringify(PAYLOAD) }] },
      ],
    },
  },
  {
    name: "gemini",
    path: `/v1beta/models/${MODEL}:generateContent`,
    body: {
      contents: [
        { role: "user", parts: [{ text: "classify" }] },
        { role: "model", parts: [{ functionCall: { name: TOOL, args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: TOOL, response: PAYLOAD } }] },
      ],
    },
  },
]

describe("tool result fidelity in conversation history", () => {
  // Clients resend their tool definitions on every turn, so each follow-up request
  // carries them too (reusing the matching format's tool declaration).
  const toolsFor = (path) => formats.find((format) => format.path(false).split(":")[0] === path.split(":")[0]).body(false)
  for (const item of history) {
    test(`${item.name}: tool result reaches the model unchanged`, async () => {
      const { client, captured } = createClient()
      const { tools } = toolsFor(item.path)
      const response = await createProxyFetchHandler(client)(post(item.path, { ...item.body, tools }))
      assert.equal(response.status, 200)
      const payloads = toolResultPayloads(captured.prompt)
      assert.equal(payloads.length, 1)
      assertExact(payloads[0], PAYLOAD)
    })
  }
})

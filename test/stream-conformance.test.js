import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createProxyFetchHandler } from "../index.js"

const ROOT = "http://127.0.0.1:4010"
const TOKENS = { input: 11, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }
const TOOLS = [
  { name: "get_weather", callID: "call_weather", args: { city: "Paris" } },
  { name: "get_time", callID: "call_time", args: { timezone: "Europe/Paris" } },
]

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/streams/${name}.json`, import.meta.url), "utf8"))
}

function createClient({ model, deltas = [], tools = [] }) {
  const sessionID = `session_${model}`
  const messageID = `assistant_${model}`
  let bridgeName

  async function* events() {
    for (const delta of deltas) {
      yield { type: "message.part.delta", properties: { sessionID, field: "text", delta } }
    }
    for (const tool of tools) {
      for (const [status, input] of [["pending", {}], ["running", tool.args]]) {
        yield {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID,
              messageID,
              type: "tool",
              tool: `${bridgeName}_${tool.name}`,
              callID: tool.callID,
              state: { status, input },
            },
          },
        }
      }
    }
    if (tools.length > 0) {
      yield {
        type: "message.part.updated",
        properties: { part: { sessionID, messageID, type: "step-finish" } },
      }
    } else {
      yield { type: "session.idle", properties: { sessionID } }
    }
  }

  return {
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: { providers: [{ id: "test", models: { [model]: { id: model, name: model } } }] },
      }),
    },
    mcp: {
      disconnect: async () => {},
      add: async ({ body }) => {
        bridgeName = body.name
        return { data: {} }
      },
    },
    event: { subscribe: async () => ({ stream: events() }) },
    session: {
      create: async () => ({ data: { id: sessionID } }),
      promptAsync: async () => {},
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      messages: async () => ({
        data: [{
          info: { role: "assistant", tokens: TOKENS, finish: tools.length > 0 ? "tool_calls" : "end_turn" },
          parts: deltas.map((text) => ({ type: "text", text })),
        }],
      }),
    },
  }
}

function request(path, body) {
  return new Request(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function parseSse(text, named) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n")
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7)
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6)
    if (data === "[DONE]") return { done: true }
    return named ? { event, data: JSON.parse(data) } : JSON.parse(data)
  })
}

function normalize(events) {
  const ids = new Map()
  const counts = new Map()
  const prefixes = [
    ["chatcmpl_", "chat"],
    ["resp_", "response"],
    ["msg_", "message"],
    ["fc_", "function-item"],
  ]

  function value(input, key) {
    if ((key === "created" || key === "created_at") && typeof input === "number") return "<timestamp>"
    if (Array.isArray(input)) return input.map((entry) => value(entry))
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, value(entry, name)]))
    }
    if (typeof input !== "string") return input
    const match = prefixes.find(([prefix]) => input.startsWith(prefix))
    if (!match) return input
    if (!ids.has(input)) {
      const label = match[1]
      const count = (counts.get(label) ?? 0) + 1
      counts.set(label, count)
      ids.set(input, `<${label}-${count}>`)
    }
    return ids.get(input)
  }

  return value(events)
}

const protocols = [
  {
    name: "openai-chat",
    path: "/v1/chat/completions",
    named: false,
    textBody: { model: "chat-model", stream: true, messages: [{ role: "user", content: "Greet me" }] },
    toolBody: {
      model: "chat-model",
      stream: true,
      messages: [{ role: "user", content: "Weather and time?" }],
      tools: TOOLS.map((tool) => ({ type: "function", function: { name: tool.name, parameters: { type: "object" } } })),
    },
  },
  {
    name: "openai-responses",
    path: "/v1/responses",
    named: true,
    textBody: { model: "responses-model", stream: true, input: "Greet me" },
    toolBody: {
      model: "responses-model",
      stream: true,
      input: "Weather and time?",
      tools: TOOLS.map((tool) => ({ type: "function", name: tool.name, parameters: { type: "object" } })),
    },
  },
  {
    name: "anthropic",
    path: "/v1/messages",
    named: true,
    textBody: { model: "anthropic-model", max_tokens: 32, stream: true, messages: [{ role: "user", content: "Greet me" }] },
    toolBody: {
      model: "anthropic-model",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "Weather and time?" }],
      tools: TOOLS.map((tool) => ({ name: tool.name, input_schema: { type: "object" } })),
    },
  },
  {
    name: "gemini",
    path: "/v1beta/models/gemini-model:streamGenerateContent",
    named: false,
    textBody: { contents: [{ role: "user", parts: [{ text: "Greet me" }] }] },
    toolBody: {
      contents: [{ role: "user", parts: [{ text: "Weather and time?" }] }],
      tools: [{ functionDeclarations: TOOLS.map((tool) => ({ name: tool.name, parameters: { type: "object" } })) }],
    },
  },
]

for (const protocol of protocols) {
  test(`${protocol.name} emits normalized complete text and parallel-tool streams`, async () => {
    const expected = await fixture(protocol.name)
    const model = protocol.textBody.model ?? "gemini-model"

    const textResponse = await createProxyFetchHandler(createClient({ model, deltas: ["Hello", " world"] }))(
      request(protocol.path, protocol.textBody),
    )
    const toolResponse = await createProxyFetchHandler(createClient({ model, tools: TOOLS }))(
      request(protocol.path, protocol.toolBody),
    )

    assert.equal(textResponse.status, 200)
    assert.equal(toolResponse.status, 200)
    const parse = protocol.name === "gemini"
      ? (text) => text.trim().split("\n").map((line) => JSON.parse(line))
      : (text) => parseSse(text, protocol.named)
    assert.deepEqual(normalize(parse(await textResponse.text())), expected.text)
    assert.deepEqual(normalize(parse(await toolResponse.text())), expected.parallelTools)
  })
}

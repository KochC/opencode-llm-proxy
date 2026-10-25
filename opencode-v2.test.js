import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"

import * as mod from "./index.js"
import { createProxyFetchHandler } from "./index.js"
import { createV2Backend, normalizeV2Model, parseStructured, toolName, transcriptOutcome, transcriptToolCalls } from "./opencode-v2.js"
import { resetMetrics } from "./metrics.js"

const PROXY_STATE_KEY = "__opencodeOpenAIProxyState"

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENCODE_LLM_PROXY_")) delete process.env[name]
  }
  resetMetrics()
})

const MODEL_INFO = {
  id: "gpt-x",
  modelID: "gpt-x",
  providerID: "acme",
  name: "GPT X",
  capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: true },
  variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
  cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 1000, output: 100 },
}

const MODEL = normalizeV2Model(MODEL_INFO)

// Minimal stand-in for the OpenCode V2 plugin context. `onPrompt` scripts the
// events a session emits after a prompt; `emit` sends one event to every live
// subscription, the way OpenCode's public event stream does.
function createCtx({ models = [MODEL_INFO], onPrompt = () => {}, context = [], wait, silent = false } = {}) {
  const subscribers = new Set()
  const ctx = {
    hooks: {},
    registrations: [],
    transforms: [],
    created: [],
    prompts: [],
    removed: [],
    interrupted: [],
    waitSignals: [],
    emit(type, data) {
      if (silent) return
      for (const subscriber of subscribers) subscriber.push({ type, data })
    },
    model: { list: async () => ({ location: {}, data: models }) },
    session: {
      hook: async (name, callback) => {
        ctx.hooks[name] = callback
        return { dispose: async () => {} }
      },
      create: async (input) => {
        ctx.created.push(input)
        return { id: `ses_${ctx.created.length}`, title: input.title }
      },
      prompt: async (input) => {
        ctx.prompts.push(input)
        Promise.resolve().then(() => onPrompt(input.sessionID, ctx, input))
        return { id: "msg_user", sessionID: input.sessionID }
      },
      interrupt: async ({ sessionID }) => {
        ctx.interrupted.push(sessionID)
        ctx.onInterrupt?.(sessionID)
        return { interrupted: true }
      },
      remove: async ({ sessionID }) => {
        ctx.removed.push(sessionID)
      },
      context: async () => (typeof context === "function" ? context() : context),
      ...(wait
        ? {
            wait: (input, options) => {
              ctx.waitSignals.push(options?.signal)
              return wait(input, options)
            },
          }
        : {}),
    },
    tool: {
      transform: async (callback) => {
        const added = []
        callback({ add: (tool) => added.push(tool) })
        const registration = { tools: added, disposed: false, dispose: async () => { registration.disposed = true } }
        ctx.registrations.push(registration)
        return registration
      },
    },
    event: {
      subscribe: ({ signal } = {}) => ({
        [Symbol.asyncIterator]() {
          const queue = [{ type: "server.connected", data: {} }]
          let wake = null
          const subscriber = { push: (event) => { queue.push(event); wake?.() } }
          subscribers.add(subscriber)
          const close = () => { subscribers.delete(subscriber); wake?.() }
          signal?.addEventListener("abort", close, { once: true })
          return {
            async next() {
              while (queue.length === 0) {
                if (signal?.aborted) return { done: true, value: undefined }
                await new Promise((resolve) => { wake = resolve })
                wake = null
              }
              return { done: false, value: queue.shift() }
            },
            async return() {
              close()
              return { done: true, value: undefined }
            },
          }
        },
      }),
    },
  }
  return ctx
}

function contextEvent(sessionID, tools = {}) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "acme", id: "gpt-x" },
    system: [{ type: "text", text: "OpenCode coding agent prompt" }],
    messages: [],
    tools: { read: { description: "read", input: {} }, shell: { description: "shell", input: {} }, ...tools },
    options: {},
  }
}

const usage = { input: 5, output: 7, reasoning: 1, cache: { read: 2, write: 0 } }

function textReply(text) {
  return (sessionID, ctx) => {
    for (const delta of text) ctx.emit("session.text.delta", { sessionID, assistantMessageID: "msg_a", ordinal: 0, delta })
    ctx.emit("session.step.ended", { sessionID, assistantMessageID: "msg_a", finish: "stop", tokens: usage, cost: 0 })
    ctx.emit("session.execution.succeeded", { sessionID })
  }
}

describe("V2 helpers", () => {
  it("normalizes V2 model info to the proxy's model shape", () => {
    assert.deepEqual(MODEL, {
      id: "acme/gpt-x",
      providerID: "acme",
      modelID: "gpt-x",
      name: "GPT X",
      capabilities: {
        tools: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: ["text"],
        temperature: true,
      },
      limit: MODEL_INFO.limit,
      cost: MODEL_INFO.cost,
      status: "active",
      variants: { high: { reasoningEffort: "high" } },
    })
  })

  it("builds unique, provider-safe prefixed tool names", () => {
    const seen = new Set()
    assert.equal(toolName("px0_", "get-weather", seen), "px0_get_weather")
    assert.equal(toolName("px0_", "get.weather", seen), "px0_get_weather_2")
    assert.equal(toolName("px0_", "", seen), "px0_tool")
    assert.ok(toolName("px0_", "x".repeat(200), seen).length <= 64)
  })

  it("parses structured output with or without code fences", () => {
    assert.deepEqual(parseStructured('{"a":1}'), { a: 1 })
    assert.deepEqual(parseStructured('```json\n{"a":1}\n```'), { a: 1 })
    assert.equal(parseStructured("not json"), undefined)
  })

  it("reads the finished turn from the transcript only once the session is idle", () => {
    const assistant = { type: "assistant", content: [{ type: "text", text: " Hi" }], finish: "stop", tokens: usage }
    assert.equal(transcriptOutcome([{ type: "user", text: "x" }, assistant]), null)
    assert.deepEqual(transcriptOutcome([{ type: "user", text: "x" }, assistant, { type: "idle", outcome: "succeeded" }]), {
      kind: "done",
      text: " Hi",
      finish: "stop",
      tokens: usage,
      error: null,
    })
    assert.equal(
      transcriptOutcome([assistant, { type: "idle", outcome: "failed", error: { type: "api", message: "boom" } }]).error,
      "boom",
    )
  })

  it("reads proxy tool calls from the transcript once the model finished streaming them", () => {
    const bridge = { toolNames: new Set(["px0_w"]), nameMap: new Map([["px0_w", "weather"]]) }
    const message = (streamed) => ({
      type: "assistant",
      time: { created: 1, ...(streamed ? { streamed: 2 } : {}) },
      content: [
        { type: "tool", id: "c1", name: "px0_w", state: { status: "running", input: { city: "Paris" } } },
        { type: "tool", id: "c2", name: "px0_w", state: { status: "streaming", input: '{"city":"Berlin"}' } },
        { type: "tool", id: "c3", name: "read", state: { status: "running", input: {} } },
      ],
    })
    assert.equal(transcriptToolCalls([message(false)], bridge), null)
    assert.deepEqual(transcriptToolCalls([message(true)], bridge), {
      kind: "tools",
      calls: [
        { id: "c1", name: "weather", arguments: { city: "Paris" } },
        { id: "c2", name: "weather", arguments: { city: "Berlin" } },
      ],
    })
  })
})

describe("V2 backend", () => {
  it("lists enabled models only", async () => {
    const backend = createV2Backend(createCtx({ models: [MODEL_INFO, { ...MODEL_INFO, modelID: "off", enabled: false }] }))
    assert.deepEqual((await backend.listModels()).map((model) => model.id), ["acme/gpt-x"])
  })

  it("streams a text turn, applies the request through the context hook and removes the session", async () => {
    let hooked
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        hooked = contextEvent(sessionID, { px9_other: { description: "x", input: {} } })
        c.hooks.context(hooked)
        textReply("Hi!")(sessionID, c)
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const chunks = []
    const result = await backend.runTurn({
      model: MODEL,
      system: "Be brief.",
      text: "hello",
      variant: "high",
      controls: { temperature: 0.3, topP: 0.9, topK: 4 },
      onChunk: (delta) => chunks.push(delta),
    })

    assert.deepEqual(chunks, ["H", "i", "!"])
    assert.equal(result.content, "Hi!")
    assert.equal(result.finish, "stop")
    assert.deepEqual(result.tokens, usage)
    assert.deepEqual(result.toolCalls, [])
    assert.deepEqual(ctx.created[0].model, { providerID: "acme", id: "gpt-x", variant: "high" })
    assert.deepEqual(ctx.prompts[0], { sessionID: "ses_1", text: "hello" })
    assert.deepEqual(hooked.system, [{ type: "text", text: "Be brief." }])
    assert.deepEqual(hooked.tools, {})
    assert.deepEqual(hooked.options, { temperature: 0.3, topP: 0.9, topK: 4 })
    assert.deepEqual(ctx.removed, ["ses_1"])
  })

  it("leaves other sessions alone except for hiding in-flight proxy tools", async () => {
    const ctx = createCtx()
    const backend = createV2Backend(ctx)
    await backend.install()
    const event = contextEvent("ses_user", { px3_get_weather: { description: "x", input: {} } })
    ctx.hooks.context(event)
    assert.deepEqual(Object.keys(event.tools), ["read", "shell"])
    assert.deepEqual(event.system, [{ type: "text", text: "OpenCode coding agent prompt" }])
    assert.deepEqual(event.options, {})
  })

  it("captures parallel tool calls, interrupts the session and disposes the tools", async () => {
    let hooked
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        const name = c.registrations[0].tools[0].name
        hooked = contextEvent(sessionID, { [name]: { description: "w", input: {} } })
        c.hooks.context(hooked)
        const base = { sessionID, assistantMessageID: "msg_a" }
        c.emit("session.tool.input.started", { ...base, id: "call_1", name })
        c.emit("session.tool.called", { ...base, id: "call_1", input: { city: "Paris" }, executed: false })
        c.emit("session.tool.input.started", { ...base, id: "call_2", name })
        c.emit("session.tool.called", { ...base, id: "call_2", input: { city: "Berlin" }, executed: false })
        c.emit("session.step.streamed", base)
        c.emit("session.tool.success", { ...base, id: "call_1" })
        c.emit("session.step.ended", { ...base, finish: "tool-calls", tokens: usage, cost: 0 })
        c.emit("session.execution.interrupted", { sessionID, reason: "user" })
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const result = await backend.runTurn({
      model: MODEL,
      text: "weather?",
      tools: [{ name: "get-weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    })

    const registered = ctx.registrations[0].tools[0]
    assert.equal(registered.name, "px0_get_weather")
    assert.deepEqual(registered.options, { codemode: false })
    assert.deepEqual(Object.keys(hooked.tools), ["px0_get_weather"])
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "get-weather", arguments: { city: "Paris" } },
      { id: "call_2", name: "get-weather", arguments: { city: "Berlin" } },
    ])
    assert.equal(result.finish, "tool_calls")
    assert.deepEqual(result.tokens, usage)
    assert.deepEqual(ctx.interrupted, ["ses_1"])
    assert.equal(ctx.registrations[0].disposed, true)
    assert.deepEqual(ctx.removed, ["ses_1"])
  })

  it("keeps exact tool names and the native tool map with native passthrough", async () => {
    process.env.OPENCODE_LLM_PROXY_NATIVE_PASSTHROUGH = "1"
    let hooked
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        const name = c.registrations[0].tools[0].name
        hooked = contextEvent(sessionID, { [name]: { description: "w", input: {} } })
        c.hooks.context(hooked)
        const base = { sessionID, assistantMessageID: "msg_a" }
        c.emit("session.tool.input.started", { ...base, id: "call_1", name })
        c.emit("session.tool.called", { ...base, id: "call_1", input: { city: "Paris" }, executed: false })
        c.emit("session.step.streamed", base)
        c.emit("session.step.ended", { ...base, finish: "tool-calls", tokens: usage, cost: 0 })
        c.emit("session.execution.interrupted", { sessionID, reason: "user" })
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const result = await backend.runTurn({
      model: MODEL,
      text: "weather?",
      tools: [{ name: "get-weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    })

    const registered = ctx.registrations[0].tools[0]
    assert.equal(registered.name, "get_weather")
    assert.deepEqual(Object.keys(hooked.tools).sort(), ["get_weather", "read", "shell"])
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "get-weather", arguments: { city: "Paris" } },
    ])
  })

  it("tool executors wait for the turn to be interrupted", async () => {
    const ctx = createCtx()
    const backend = createV2Backend(ctx, { toolPlaceholderTimeoutMs: 1000 })
    await backend.install()
    let result
    ctx.session.prompt = async (input) => {
      const { execute } = ctx.registrations[0].tools[0]
      const controller = new AbortController()
      let settled = false
      const pending = execute({}, { signal: controller.signal }).then((value) => { settled = true; return value })
      await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(settled, false)
      controller.abort()
      result = await pending
      ctx.emit("session.execution.succeeded", { sessionID: input.sessionID })
      return {}
    }
    await backend.runTurn({ model: MODEL, text: "x", tools: [{ name: "t", description: "", parameters: { type: "object" } }] })
    assert.deepEqual(result, { content: "The tool call was forwarded to the API caller." })
  })

  it("throws the session error and still removes the session", async () => {
    const ctx = createCtx({
      onPrompt: (sessionID, c) => c.emit("session.execution.failed", { sessionID, error: { type: "api", message: "quota exceeded" } }),
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    await assert.rejects(backend.runTurn({ model: MODEL, text: "x" }), /quota exceeded/)
    assert.deepEqual(ctx.removed, ["ses_1"])
  })

  it("falls back to the session transcript when no deltas were streamed", async () => {
    const ctx = createCtx({
      context: [{ type: "user", text: "x" }, { type: "assistant", content: [{ type: "text", text: "from transcript" }] }],
      onPrompt: (sessionID, c) => c.emit("session.execution.succeeded", { sessionID }),
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    assert.equal((await backend.runTurn({ model: MODEL, text: "x" })).content, "from transcript")
  })

  it("asks for JSON when structured output is requested and parses the reply", async () => {
    let hooked
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        hooked = contextEvent(sessionID)
        c.hooks.context(hooked)
        textReply('```json\n{"fruit":"apple"}\n```')(sessionID, c)
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const schema = { type: "object", properties: { fruit: { type: "string" } } }
    const result = await backend.runTurn({ model: MODEL, system: "S", text: "x", format: { type: "json_schema", schema } })
    assert.deepEqual(result.structured, { fruit: "apple" })
    assert.equal(result.content, '{"fruit":"apple"}')
    assert.match(hooked.system[0].text, /^S\n\nRespond with only a JSON value/)
    assert.ok(hooked.system[0].text.includes(JSON.stringify(schema)))
  })

  it("passes embedded media as prompt files and keeps sessions on request", async () => {
    const ctx = createCtx({ onPrompt: textReply("red") })
    const backend = createV2Backend(ctx)
    await backend.install()
    await backend.runTurn({
      model: MODEL,
      text: "describe",
      media: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "a.png" }],
      keepSessions: true,
    })
    assert.deepEqual(ctx.prompts[0].files, [{ uri: "data:image/png;base64,AAAA", name: "a.png" }])
    assert.deepEqual(ctx.removed, [])
  })

  it("interrupts the session and rejects when the caller cancels", async () => {
    const controller = new AbortController()
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        c.emit("session.text.delta", { sessionID, assistantMessageID: "m", ordinal: 0, delta: "partial" })
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const reason = Object.assign(new Error("Request was cancelled."), { code: "cancelled" })
    const run = backend.runTurn({ model: MODEL, text: "x", signal: controller.signal, onChunk: () => controller.abort(reason) })
    await assert.rejects(run, (error) => error === reason)
    assert.deepEqual(ctx.interrupted, ["ses_1"])
    assert.deepEqual(ctx.removed, ["ses_1"])
  })
})

describe("V2 turn when the event stream is silent", () => {
  // A session whose outcome is only visible through session.wait() and the transcript.
  function quietSession() {
    let release
    const finished = new Promise((resolve) => { release = resolve })
    const messages = [{ type: "user", text: "x" }]
    return { messages, finished, finish: () => release(), wait: () => finished }
  }

  it("completes a text turn from the transcript", async () => {
    const session = quietSession()
    const ctx = createCtx({
      silent: true,
      wait: session.wait,
      context: () => session.messages,
      onPrompt: () => {
        session.messages.push(
          { type: "assistant", content: [{ type: "text", text: "Hello there" }], finish: "stop", tokens: usage },
          { type: "idle", outcome: "succeeded" },
        )
        session.finish()
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const result = await backend.runTurn({ model: MODEL, text: "x" })
    assert.equal(result.content, "Hello there")
    assert.equal(result.finish, "stop")
    assert.deepEqual(result.tokens, usage)
    assert.deepEqual(ctx.removed, ["ses_1"])
  })

  it("streams only the text the event stream did not deliver", async () => {
    const session = quietSession()
    const ctx = createCtx({
      wait: session.wait,
      context: () => session.messages,
      onPrompt: (sessionID, c) => {
        c.emit("session.text.delta", { sessionID, assistantMessageID: "m", ordinal: 0, delta: "Hel" })
        setTimeout(() => {
          session.messages.push(
            { type: "assistant", content: [{ type: "text", text: "Hello there" }], finish: "stop", tokens: usage },
            { type: "idle", outcome: "succeeded" },
          )
          session.finish()
        }, 10)
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const chunks = []
    const result = await backend.runTurn({ model: MODEL, text: "x", onChunk: (delta) => chunks.push(delta) })
    assert.deepEqual(chunks, ["Hel", "lo there"])
    assert.equal(result.content, "Hello there")
  })

  it("captures tool calls through the tool executors and the transcript", async () => {
    const session = quietSession()
    const executor = new AbortController()
    let executed
    const ctx = createCtx({
      silent: true,
      wait: session.wait,
      context: () => session.messages,
      onPrompt: (sessionID, c) => {
        const { name, execute } = c.registrations[0].tools[0]
        session.messages.push({
          type: "assistant",
          time: { created: 1, streamed: 2 },
          content: [{ type: "tool", id: "call_1", name, state: { status: "running", input: { city: "Paris" } } }],
        })
        executed = execute({ city: "Paris" }, { sessionID, id: "call_1", signal: executor.signal })
      },
    })
    ctx.onInterrupt = () => {
      executor.abort()
      session.messages[1].tokens = usage
      session.messages.push({ type: "idle", outcome: "interrupted" })
      session.finish()
    }
    const backend = createV2Backend(ctx)
    await backend.install()
    const result = await backend.runTurn({
      model: MODEL,
      text: "weather?",
      tools: [{ name: "get-weather", description: "Weather", parameters: { type: "object" } }],
    })
    assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "get-weather", arguments: { city: "Paris" } }])
    assert.equal(result.finish, "tool_calls")
    assert.deepEqual(result.tokens, usage)
    assert.deepEqual(ctx.interrupted, ["ses_1"])
    assert.deepEqual(await executed, { content: "The tool call was forwarded to the API caller." })
    assert.equal(ctx.registrations[0].disposed, true)
  })

  it("surfaces a failed turn recorded in the transcript", async () => {
    const session = quietSession()
    const ctx = createCtx({
      silent: true,
      wait: session.wait,
      context: () => session.messages,
      onPrompt: () => {
        session.messages.push({ type: "idle", outcome: "failed", error: { type: "api", message: "rate limited" } })
        session.finish()
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    await assert.rejects(backend.runTurn({ model: MODEL, text: "x" }), /rate limited/)
    assert.deepEqual(ctx.removed, ["ses_1"])
  })

  it("stops waiting on the session once the event stream finished the turn", async () => {
    const ctx = createCtx({ onPrompt: textReply("ok"), wait: () => NEVER_SETTLES })
    const backend = createV2Backend(ctx)
    await backend.install()
    assert.equal((await backend.runTurn({ model: MODEL, text: "x" })).content, "ok")
    assert.equal(ctx.waitSignals.length, 1)
    assert.equal(ctx.waitSignals[0].aborted, true)
  })
})

const NEVER_SETTLES = new Promise(() => {})

describe("V2 through the HTTP handler", () => {
  it("serves /v1/models and chat completions from the V2 backend", async () => {
    const ctx = createCtx({ onPrompt: textReply("Hello there") })
    const backend = createV2Backend(ctx)
    await backend.install()
    const handler = createProxyFetchHandler(backend)

    const models = await (await handler(new Request("http://127.0.0.1:4010/v1/models"))).json()
    assert.deepEqual(models.data.map((model) => model.id), ["acme/gpt-x"])

    const response = await handler(new Request("http://127.0.0.1:4010/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-variant": "high" },
      body: JSON.stringify({ model: "acme/gpt-x", messages: [{ role: "system", content: "Sys" }, { role: "user", content: "Hi" }] }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, "Hello there")
    assert.equal(body.choices[0].finish_reason, "stop")
    assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })
    assert.equal(ctx.created[0].model.variant, "high")
  })

  it("returns tool calls in Anthropic format", async () => {
    const ctx = createCtx({
      onPrompt: (sessionID, c) => {
        const name = c.registrations[0].tools[0].name
        const base = { sessionID, assistantMessageID: "msg_a" }
        c.emit("session.tool.input.started", { ...base, id: "toolu_1", name })
        c.emit("session.tool.called", { ...base, id: "toolu_1", input: { path: "README.md" }, executed: false })
        c.emit("session.step.streamed", base)
        c.emit("session.step.ended", { ...base, finish: "tool-calls", tokens: usage, cost: 0 })
      },
    })
    const backend = createV2Backend(ctx)
    await backend.install()
    const response = await createProxyFetchHandler(backend)(new Request("http://127.0.0.1:4010/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "acme/gpt-x",
        max_tokens: 100,
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      }),
    }))
    const body = await response.json()
    assert.equal(body.stop_reason, "tool_use")
    assert.deepEqual(body.content, [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } }])
  })
})

describe("V2 plugin entrypoint", () => {
  function withMockedBun(run) {
    const savedBun = globalThis.Bun
    delete globalThis[PROXY_STATE_KEY]
    const servers = []
    globalThis.Bun = {
      serve: (options) => {
        const server = { options, stopped: false, stop: async () => { server.stopped = true } }
        servers.push(server)
        return server
      },
    }
    process.env.OPENCODE_LLM_PROXY_HOST = "127.0.0.1"
    return Promise.resolve()
      .then(() => run(servers))
      .finally(() => {
        if (savedBun === undefined) delete globalThis.Bun
        else globalThis.Bun = savedBun
        delete globalThis[PROXY_STATE_KEY]
      })
  }

  it("default export carries both the V2 setup and the V1 server entry points", () => {
    assert.equal(mod.default.id, "opencode-llm-proxy")
    assert.equal(typeof mod.default.setup, "function")
    assert.equal(typeof mod.default.server, "function")
  })

  it("setup installs the context hook, starts one shared server and stops it with the last instance", async () => {
    await withMockedBun(async (servers) => {
      const first = createCtx()
      const second = createCtx({ models: [{ ...MODEL_INFO, modelID: "second" }] })
      const cleanupFirst = await mod.default.setup(first)
      const cleanupSecond = await mod.default.setup(second)

      assert.equal(typeof first.hooks.context, "function")
      assert.equal(typeof second.hooks.context, "function")
      assert.equal(servers.length, 1)

      await cleanupFirst()
      assert.equal(servers[0].stopped, false)
      // Requests are now served through the remaining instance.
      const models = await (await servers[0].options.fetch(new Request("http://127.0.0.1:4010/v1/models"))).json()
      assert.deepEqual(models.data.map((model) => model.id), ["acme/second"])

      await cleanupSecond()
      assert.equal(servers[0].stopped, true)
      assert.equal(globalThis[PROXY_STATE_KEY].started, false)

      await mod.default.setup(createCtx())
      assert.equal(servers.length, 2)
    })
  })
})

// OpenCode V2 backend.
//
// The V1 plugin talks to OpenCode through the V1 SDK client and emulates
// client-executed tools with a pool of MCP bridge servers. V2 exposes a plugin
// context instead (https://opencode.ai/v2/docs/build/plugins), which lets the
// proxy do the same work directly:
//
//   - A shared session `context` hook replaces OpenCode's coding-agent system
//     prompt with the caller's, narrows the tool list of each proxy session to
//     exactly the caller's tools, and applies generation controls.
//   - Caller tools are registered for the duration of one turn through
//     `ctx.tool.transform` (V2 only sends tools that exist in the executable
//     tool snapshot). Their executors never run anything: they wait until the
//     turn is interrupted, so the model's proposed calls can be handed back to
//     the caller without OpenCode starting a follow-up step.
//   - Text deltas, tool calls, usage and errors come from the V2 event stream.

const TOOL_PREFIX = "px"
const MAX_TOOL_NAME = 64
const MEDIA_KINDS = ["text", "image", "audio", "video", "pdf"]
const TOOL_PLACEHOLDER_TIMEOUT_MS = 60000
const SUBSCRIBE_READY_TIMEOUT_MS = 2000
const USAGE_GRACE_MS = 3000
const EMPTY_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: Object.freeze({ read: 0, write: 0 }) })

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
}

function cancelled(signal) {
  const error = signal?.reason
  if (error instanceof Error) return error
  const fallback = new Error("Request was cancelled.")
  fallback.status = 499
  fallback.code = "cancelled"
  return fallback
}

export function toolName(prefix, name, seen) {
  let base = String(name ?? "").replace(/[^a-zA-Z0-9_]/g, "_") || "tool"
  base = base.slice(0, MAX_TOOL_NAME - prefix.length - 4)
  let candidate = `${prefix}${base}`
  let suffix = 2
  while (seen.has(candidate)) candidate = `${prefix}${base}_${suffix++}`
  seen.add(candidate)
  return candidate
}

export function normalizeV2Model(model) {
  const input = Array.isArray(model.capabilities?.input) ? model.capabilities.input : []
  const capabilities = {
    ...model.capabilities,
    input: Object.fromEntries([...new Set([...MEDIA_KINDS, ...input])].map((kind) => [kind, input.includes(kind)])),
  }
  return {
    id: `${model.providerID}/${model.modelID}`,
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name ?? model.modelID,
    capabilities,
    limit: model.limit,
    cost: model.cost,
    status: model.status,
    variants: Object.fromEntries((model.variants ?? []).map((variant) => [variant.id, variant.settings ?? {}])),
  }
}

function addTokens(total, tokens) {
  if (!tokens) return total
  return {
    input: total.input + (tokens.input ?? 0),
    output: total.output + (tokens.output ?? 0),
    reasoning: total.reasoning + (tokens.reasoning ?? 0),
    cache: {
      read: total.cache.read + (tokens.cache?.read ?? 0),
      write: total.cache.write + (tokens.cache?.write ?? 0),
    },
  }
}

function mapFinish(finish) {
  if (finish === "tool-calls") return "tool_calls"
  return finish
}

function structuredInstruction(format) {
  return [
    "Respond with only a JSON value that conforms to the following JSON Schema.",
    "Do not wrap it in Markdown code fences and do not add any commentary.",
    JSON.stringify(format.schema),
  ].join("\n")
}

export function parseStructured(text) {
  const trimmed = String(text ?? "").trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed)
  } catch {
    return undefined
  }
}

function assistantText(messages) {
  const assistant = (messages ?? []).filter((message) => message.type === "assistant").at(-1)
  return (assistant?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim()
}

function waitForAbort(signal, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve({ content: "The tool call was forwarded to the API caller." })
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    if (signal?.aborted) return done()
    signal?.addEventListener("abort", done, { once: true })
  })
}

export function createV2Backend(ctx, options = {}) {
  const turns = new Map()
  let nextTurn = 0
  const placeholderTimeoutMs = options.toolPlaceholderTimeoutMs ?? TOOL_PLACEHOLDER_TIMEOUT_MS

  const proxyToolPattern = new RegExp(`^${TOOL_PREFIX}\\d+_`)

  async function install() {
    await ctx.session.hook("context", (event) => {
      const turn = turns.get(event.sessionID)
      if (!turn) {
        // Tools registered for an in-flight proxy turn are global in V2; keep them out of other sessions.
        for (const name of Object.keys(event.tools)) {
          if (proxyToolPattern.test(name)) delete event.tools[name]
        }
        return
      }
      event.system = turn.system ? [{ type: "text", text: turn.system }] : []
      event.tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => turn.toolNames.has(name)))
      const controls = turn.controls ?? {}
      if (controls.temperature !== undefined) event.options.temperature = controls.temperature
      if (controls.topP !== undefined) event.options.topP = controls.topP
      if (controls.topK !== undefined) event.options.topK = controls.topK
    })
  }

  async function listModels() {
    const result = await ctx.model.list()
    const models = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
    return models.filter((model) => model.enabled !== false).map(normalizeV2Model)
  }

  async function registerTools(tools) {
    const prefix = `${TOOL_PREFIX}${nextTurn++}_`
    const seen = new Set()
    const nameMap = new Map()
    const definitions = tools.map((tool) => {
      const name = toolName(prefix, tool.name, seen)
      nameMap.set(name, tool.name)
      return {
        name,
        description: tool.description || tool.name,
        input: tool.parameters,
        // Direct tools only: Code Mode tools are reachable solely through OpenCode's `execute` tool.
        options: { codemode: false },
        execute: (_input, context) => waitForAbort(context?.signal, placeholderTimeoutMs),
      }
    })
    const registration = await ctx.tool.transform((editor) => {
      for (const definition of definitions) editor.add(definition)
    })
    return { registration, nameMap, toolNames: new Set(nameMap.keys()) }
  }

  async function runTurn(input) {
    const { model, system, text, media = [], tools = [], format, variant, controls, onChunk, signal, keepSessions } = input
    if (signal?.aborted) throw cancelled(signal)

    const bridge = tools.length > 0 ? await registerTools(tools) : null
    const subscription = new AbortController()
    const abortSubscription = () => subscription.abort()
    signal?.addEventListener("abort", abortSubscription, { once: true })

    let sessionID
    let content = ""
    let tokens = EMPTY_TOKENS
    let finish
    let errorMessage = null
    let toolMessageID = null
    const calls = new Map()

    const interrupt = () => ctx.session.interrupt({ sessionID }).catch(() => {})

    try {
      const session = await ctx.session.create({
        title: `Proxy: ${model.id}`,
        model: { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) },
      })
      sessionID = session.id
      turns.set(sessionID, {
        system: [system, format ? structuredInstruction(format) : ""].filter(Boolean).join("\n\n"),
        toolNames: bridge?.toolNames ?? new Set(),
        controls,
      })
      signal?.addEventListener("abort", interrupt, { once: true })

      const events = ctx.event.subscribe({ signal: subscription.signal })[Symbol.asyncIterator]()
      // Wait (briefly) for the subscription to be live so nothing emitted by the prompt is missed.
      let pending = events.next()
      const first = await Promise.race([pending, delay(SUBSCRIBE_READY_TIMEOUT_MS)])
      if (first && !first.done && first.value?.type === "server.connected") pending = null

      await ctx.session.prompt({
        sessionID,
        text,
        ...(media.length > 0 ? { files: media.map((part) => ({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) })) } : {}),
      })

      // Set once every call of the tool-calling step has streamed; the turn then only waits (briefly)
      // for that step's usage before returning.
      let captured = false
      while (true) {
        const next = await (captured ? Promise.race([pending ?? events.next(), delay(USAGE_GRACE_MS)]) : pending ?? events.next())
        pending = null
        if (!next || next.done) break
        const event = next.value
        const data = event?.data
        if (data?.sessionID !== sessionID) continue

        if (event.type === "session.text.delta") {
          if (typeof data.delta === "string" && data.delta.length > 0) {
            content += data.delta
            await onChunk?.(data.delta)
          }
        } else if (event.type === "session.tool.input.started") {
          if (bridge?.toolNames.has(data.name) && (!toolMessageID || data.assistantMessageID === toolMessageID)) {
            toolMessageID = data.assistantMessageID
            calls.set(data.id, { id: data.id, name: bridge.nameMap.get(data.name), arguments: {} })
          }
        } else if (event.type === "session.tool.called") {
          const call = calls.get(data.id)
          if (call && data.input && typeof data.input === "object") call.arguments = data.input
        } else if (event.type === "session.step.streamed") {
          if (!captured && calls.size > 0 && data.assistantMessageID === toolMessageID) {
            // The model finished the step, so every call (including parallel ones) has been observed.
            // OpenCode ends the step only after the tool executors return, which they do once interrupted.
            captured = true
            void interrupt()
          }
        } else if (event.type === "session.step.ended") {
          tokens = addTokens(tokens, data.tokens)
          finish = data.finish
          if (calls.size > 0 && data.assistantMessageID === toolMessageID) {
            if (!captured) await interrupt()
            break
          }
        } else if (event.type === "session.step.failed") {
          tokens = addTokens(tokens, data.tokens)
          errorMessage = data.error?.message ?? "Model call failed."
        } else if (event.type === "session.execution.failed") {
          errorMessage = data.error?.message ?? errorMessage ?? "Model call failed."
          break
        } else if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.interrupted" ||
          event.type === "session.idle"
        ) {
          break
        }
      }

      if (signal?.aborted) throw cancelled(signal)

      const toolCalls = [...calls.values()]
      if (errorMessage && toolCalls.length === 0) throw new Error(errorMessage)

      if (!content && toolCalls.length === 0) {
        try {
          content = assistantText(await ctx.session.context({ sessionID }))
        } catch {
          // Keep the streamed (empty) content when the transcript cannot be read.
        }
      }

      const structured = format && toolCalls.length === 0 ? parseStructured(content) : undefined
      return {
        sessionID,
        content: structured === undefined ? content : JSON.stringify(structured),
        structured,
        toolCalls,
        tokens,
        finish: toolCalls.length > 0 ? "tool_calls" : mapFinish(finish),
      }
    } catch (error) {
      if (signal?.aborted) throw cancelled(signal)
      throw error
    } finally {
      signal?.removeEventListener("abort", abortSubscription)
      signal?.removeEventListener("abort", interrupt)
      subscription.abort()
      if (sessionID) turns.delete(sessionID)
      if (bridge) await bridge.registration.dispose().catch(() => {})
      if (sessionID && !keepSessions) await ctx.session.remove({ sessionID }).catch(() => {})
    }
  }

  function log(level, message, extra) {
    // V2 has no logging API for plugins; console output goes to the OpenCode server log.
    // eslint-disable-next-line no-console
    const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log
    try {
      write(`[opencode-llm-proxy] ${message}`, extra ?? "")
    } catch {
      // Ignore logging failures so the proxy still works.
    }
  }

  return { v2: true, install, listModels, runTurn, log }
}

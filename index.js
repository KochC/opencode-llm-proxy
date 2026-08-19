import { fileURLToPath } from "node:url"
import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"
import {
  adaptAnthropic,
  adaptGemini,
  adaptOpenAIChat,
  adaptOpenAIResponses,
  renderOpenCodePrompt,
} from "./canonical-messages.js"
import { getMetrics } from "./metrics.js"
import { MediaError, prepareMedia } from "./remote-media.js"

const STATE_KEY = "__opencodeOpenAIProxyState"
const BRIDGE_SCRIPT_PATH = fileURLToPath(new URL("./mcp-tool-bridge.js", import.meta.url))

function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = { started: false }
  }
  return globalThis[STATE_KEY]
}

const DEFAULTS = Object.freeze({
  requestTimeoutMs: 120000,
  maxRequestBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
  maxQueuedRequests: 32,
  bridgeAcquireTimeoutMs: 10000,
  bridgeMaxQueue: 32,
})

class ProxyError extends Error {
  constructor(message, status = 500, code = "server_error") {
    super(message)
    this.name = "ProxyError"
    this.status = status
    this.code = code
  }
}

function integerEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProxyError(`${name} must be an integer between ${min} and ${max}.`, 500, "invalid_config")
  }
  return value
}

function jsonArrayEnv(name) {
  const raw = process.env[name]
  if (!raw?.trim()) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error()
    return value.map((entry) => entry.trim())
  } catch {
    throw new ProxyError(`${name} must be a JSON array of non-empty strings.`, 500, "invalid_config")
  }
}

function objectEnv(name) {
  const raw = process.env[name]
  if (!raw?.trim()) return {}
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new ProxyError(`${name} must be a JSON object.`, 500, "invalid_config")
  }
}

function booleanEnv(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  if (raw === "true") return true
  if (raw === "false") return false
  throw new ProxyError(`${name} must be 'true' or 'false'.`, 500, "invalid_config")
}

function jsonArrayEnvDefault(name, fallback) {
  return process.env[name]?.trim() ? jsonArrayEnv(name) : [...fallback]
}

function loadConfig() {
  const legacyToken = process.env.OPENCODE_LLM_PROXY_TOKEN?.trim()
  const configuredOrigin = process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN?.trim()
  const origins = jsonArrayEnv("OPENCODE_LLM_PROXY_CORS_ORIGINS")
  if (configuredOrigin) origins.push(configuredOrigin)
  const maxRequestBytes = integerEnv("OPENCODE_LLM_PROXY_MAX_REQUEST_BYTES", DEFAULTS.maxRequestBytes, { min: 1, max: 100 * 1024 * 1024 })
  return {
    tokens: [...new Set([legacyToken, ...jsonArrayEnv("OPENCODE_LLM_PROXY_TOKENS")].filter(Boolean))],
    corsOrigins: [...new Set(origins)],
    allowPrivateNetwork: process.env.OPENCODE_LLM_PROXY_ALLOW_PRIVATE_NETWORK === "true",
    requestTimeoutMs: integerEnv("OPENCODE_LLM_PROXY_REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs, { min: 1, max: 3600000 }),
    maxRequestBytes,
    maxConcurrentRequests: integerEnv("OPENCODE_LLM_PROXY_MAX_CONCURRENT_REQUESTS", DEFAULTS.maxConcurrentRequests, { min: 1, max: 1000 }),
    maxQueuedRequests: integerEnv("OPENCODE_LLM_PROXY_MAX_QUEUED_REQUESTS", DEFAULTS.maxQueuedRequests, { min: 0, max: 10000 }),
    bridgeAcquireTimeoutMs: integerEnv("OPENCODE_LLM_PROXY_TOOL_BRIDGE_ACQUIRE_TIMEOUT_MS", DEFAULTS.bridgeAcquireTimeoutMs, { min: 1, max: 3600000 }),
    bridgeMaxQueue: integerEnv("OPENCODE_LLM_PROXY_TOOL_BRIDGE_MAX_QUEUE", DEFAULTS.bridgeMaxQueue, { min: 0, max: 10000 }),
    keepSessions: process.env.OPENCODE_LLM_PROXY_KEEP_SESSIONS === "true",
    aliases: objectEnv("OPENCODE_LLM_PROXY_MODEL_ALIASES"),
    metricsEnabled: booleanEnv("OPENCODE_LLM_PROXY_METRICS_ENABLED"),
    remoteMedia: {
      enabled: booleanEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_ENABLED"),
      allowedSchemes: jsonArrayEnvDefault("OPENCODE_LLM_PROXY_REMOTE_MEDIA_ALLOWED_SCHEMES", ["https"]),
      maxBytes: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_BYTES", maxRequestBytes || 1024 * 1024, { min: 1, max: 100 * 1024 * 1024 }),
      maxItems: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_ITEMS", 4, { min: 0, max: 10000 }),
      maxTotalItems: integerEnv("OPENCODE_LLM_PROXY_MAX_MEDIA_ITEMS", 64, { min: 1, max: 10000 }),
      maxRedirects: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_REDIRECTS", 3, { min: 0, max: 100 }),
      timeoutMs: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_TIMEOUT_MS", 10000, { min: 1, max: 3600000 }),
    },
  }
}

function commonHeaders(request, config) {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-request-id": request?.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID(),
    ...corsHeaders(request, config),
  }
}

function corsHeaders(request, config = loadConfig()) {
  const requestedPrivateNetwork = request?.headers.get("access-control-request-private-network")
  const requestOrigin = request?.headers.get("origin")
  if (!requestOrigin) return {}
  const allowed = config.corsOrigins.includes("*") || config.corsOrigins.includes(requestOrigin)
  if (!allowed) return { vary: "origin, access-control-request-method, access-control-request-headers" }

  const headers = {
    vary: "origin, access-control-request-method, access-control-request-headers",
    "access-control-allow-origin": config.corsOrigins.includes("*") ? "*" : requestOrigin,
    "access-control-allow-headers": "authorization, content-type, x-opencode-provider, x-opencode-variant, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  }

  if (requestedPrivateNetwork === "true" && config.allowPrivateNetwork) {
    headers["access-control-allow-private-network"] = "true"
  }

  return headers
}

function json(data, status = 200, headers = {}, request, config) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...commonHeaders(request, config ?? loadConfig()),
      ...headers,
    },
  })
}

function text(message, status = 200, request, config) {
  return new Response(message, {
    status,
    headers: commonHeaders(request, config ?? loadConfig()),
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

function badRequest(message, status = 400, request, code) {
  return json(
    {
      error: {
        message,
        type: "invalid_request_error",
        ...(code ? { code } : {}),
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

function tokensEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isAuthorized(request, config = loadConfig()) {
  if (config.tokens.length === 0) return true
  const supplied = getBearerToken(request)
  return Boolean(supplied && config.tokens.some((token) => tokensEqual(supplied, token)))
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

async function readJsonBody(request, maxBytes, signal) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProxyError("Request body is too large.", 413, "request_too_large")
  }
  if (!request.body) throw new ProxyError("Request body must be valid JSON.", 400, "invalid_json")
  const reader = request.body.getReader()
  const onAbort = () => reader.cancel(signal.reason).catch(() => {})
  signal?.addEventListener("abort", onAbort, { once: true })
  const read = () => new Promise((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => signal?.removeEventListener("abort", abort)
    signal?.addEventListener("abort", abort, { once: true })
    reader.read().then((value) => {
      cleanup()
      resolve(value)
    }, (error) => {
      cleanup()
      reject(error)
    })
  })
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new ProxyError("Request body is too large.", 413, "request_too_large")
      }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"))
    if (!isPlainObject(body)) throw new ProxyError("Request body must be a JSON object.", 400, "invalid_json")
    return body
  } catch (error) {
    if (error instanceof ProxyError) throw error
    throw new ProxyError("Request body must be valid JSON.", 400, "invalid_json")
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

function createRequestSignal(request, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(new ProxyError("Request was cancelled.", 499, "cancelled"))
  request.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new ProxyError("Upstream request timed out.", 504, "timeout")), timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    finish() {
      clearTimeout(timer)
      request.signal?.removeEventListener("abort", onAbort)
    },
  }
}

function getRequestLimiter(config) {
  const state = getState()
  const key = `${config.maxConcurrentRequests}:${config.maxQueuedRequests}`
  if (!state.requestLimiter || state.requestLimiter.key !== key) {
    state.requestLimiter = { key, active: 0, waiters: [] }
  }
  return state.requestLimiter
}

async function acquireRequestSlot(config, signal) {
  const limiter = getRequestLimiter(config)
  const metrics = getMetrics()
  if (signal?.aborted) throw signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled")
  if (limiter.active < config.maxConcurrentRequests) {
    limiter.active++
    metrics.setActiveRequests(limiter.active)
    return () => releaseRequestSlot(limiter)
  }
  if (limiter.waiters.length >= config.maxQueuedRequests) {
    throw new ProxyError("The proxy is busy. Try again later.", 503, "overloaded")
  }
  return new Promise((resolve, reject) => {
    const waiter = { active: true }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (!waiter.active) return
      waiter.active = false
      limiter.waiters = limiter.waiters.filter((entry) => entry !== waiter)
      metrics.setQueuedRequests(limiter.waiters.length)
      cleanup()
      reject(signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled"))
    }
    waiter.resolve = () => {
      if (!waiter.active) return false
      waiter.active = false
      cleanup()
      limiter.active++
      metrics.setActiveRequests(limiter.active)
      metrics.setQueuedRequests(limiter.waiters.filter((entry) => entry.active).length)
      resolve(() => releaseRequestSlot(limiter))
      return true
    }
    limiter.waiters.push(waiter)
    metrics.setQueuedRequests(limiter.waiters.length)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function releaseRequestSlot(limiter) {
  limiter.active = Math.max(0, limiter.active - 1)
  getMetrics().setActiveRequests(limiter.active)
  while (limiter.waiters.length > 0) {
    const waiter = limiter.waiters.shift()
    if (waiter.resolve()) return
  }
}

function renderedSystem(canonicalSystem) {
  return [
    canonicalSystem,
    "You are answering through a proxy backed by OpenCode.",
    "Return only the assistant's reply content.",
  ].filter(Boolean).join("\n\n")
}

async function prepareCanonicalRequest(canonical, config, signal, candidates = []) {
  const rendered = renderOpenCodePrompt(canonical)
  for (const part of rendered.media) {
    const kind = part.mime === "application/pdf" ? "pdf" : part.mime.split("/", 1)[0]
    if (candidates.length > 0 && candidates.every((model) => model.capabilities?.input?.[kind] === false)) {
      throw new ProxyError(`The selected model does not support ${kind} input.`, 400, "unsupported_media")
    }
  }
  let finishRemoteMedia
  let remoteMediaBytes = 0
  let remoteMediaRedirects = 0
  let remoteMediaStarted = 0
  const finish = (outcome) => {
    finishRemoteMedia?.({
      outcome,
      bytes: remoteMediaBytes,
      redirects: remoteMediaRedirects,
      durationMs: Date.now() - remoteMediaStarted,
    })
    finishRemoteMedia = undefined
  }
  try {
    const media = await prepareMedia(rendered.media, config.remoteMedia, signal, {
      increment(name, value = 1) {
        if (name === "remoteMediaAttempts") {
          remoteMediaBytes = 0
          remoteMediaRedirects = 0
          remoteMediaStarted = Date.now()
          finishRemoteMedia = getMetrics().startRemoteMedia()
        } else if (name === "remoteMediaBytes") {
          remoteMediaBytes += value
        } else if (name === "remoteMediaRedirects") {
          remoteMediaRedirects += value
        } else if (name === "remoteMediaDownloads") {
          finish("success")
        }
      },
    })
    return { messages: [{ role: "user", content: rendered.text }], system: renderedSystem(rendered.system), media }
  } catch (error) {
    const outcome = error?.code === "media_timeout"
      ? "timeout"
      : error?.code === "media_aborted"
        ? "cancelled"
        : error?.status === 400 || error?.status === 413 || error?.status === 415
          ? "rejected"
          : "error"
    finish(outcome)
    if (error instanceof MediaError) throw new ProxyError(error.message, error.status, error.code)
    throw error
  }
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
  if (!Array.isArray(messages)) return []
  const toolNameByCallId = new Map()

  return messages
    .map((message) => {
      if (!isPlainObject(message) || typeof message.role !== "string") return null
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
    .filter((message) => message && message.content.length > 0)
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

export function buildSystemPrompt(messages, _request) {
  const systemMessages = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)

  const hints = [
    "You are answering through a proxy backed by OpenCode.",
    "Return only the assistant's reply content.",
  ]

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
    .map((message) => `${String(message.role).toUpperCase()}:\n${message.content}`)
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

function dataUrlSize(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return 0
  const comma = url.indexOf(",")
  if (comma === -1) return Number.POSITIVE_INFINITY
  const metadata = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  return metadata.endsWith(";base64") ? Math.ceil(payload.length * 0.75) : Buffer.byteLength(decodeURIComponent(payload))
}

function validateFilePart(part, model, maxBytes) {
  if (!part?.mime || !part?.url) throw new ProxyError("Invalid file or image content part.", 400, "invalid_media")
  if (!part.url.startsWith("data:")) {
    throw new ProxyError("Only embedded data URLs are supported for media.", 400, "invalid_media")
  }
  if (dataUrlSize(part.url) > maxBytes) throw new ProxyError("Embedded media is too large.", 413, "request_too_large")
  const kind = part.mime === "application/pdf" ? "pdf" : part.mime.split("/", 1)[0]
  const input = model.capabilities?.input
  if (input && kind in input && !input[kind]) {
    throw new ProxyError(`Model '${model.id}' does not support ${kind} input.`, 400, "unsupported_media")
  }
}

function promptParts(messages, media, model, maxBytes) {
  const parts = [{ type: "text", text: buildPrompt(messages) }]
  for (const part of media ?? []) {
    validateFilePart(part, model, maxBytes)
    parts.push({ type: "file", mime: part.mime, url: part.url, ...(part.filename ? { filename: part.filename } : {}) })
  }
  return parts
}

function structuredFormat(request) {
  const openAI = request.response_format?.json_schema?.schema ?? request.text?.format?.schema
  const gemini = request.generationConfig?.responseSchema
  const schema = openAI ?? gemini
  if (!schema) return undefined
  if (!isPlainObject(schema)) throw new ProxyError("Structured output schema must be a JSON object.", 400, "invalid_schema")
  return { type: "json_schema", schema }
}

function validateUnsupportedControls(request) {
  const unsupported = ["stop", "seed", "frequency_penalty", "presence_penalty", "logprobs", "n"]
    .filter((name) => request[name] !== undefined)
  if (unsupported.length > 0) {
    throw new ProxyError(`Unsupported generation controls: ${unsupported.join(", ")}.`, 400, "unsupported_parameter")
  }
}

async function deleteSession(client, sessionID, keepSessions) {
  if (keepSessions || !sessionID || typeof client.session.delete !== "function") return
  try {
    await client.session.delete({ path: { id: sessionID } })
  } catch {
    // Best-effort cleanup for compatibility with older OpenCode clients.
  }
}

// Safe teardown: sessions abandoned mid-turn (client abort, error, timeout) are
// intentionally leaked at abandon time and reaped by this sweep once they are
// long idle. Deleting them immediately races the server's final persist of the
// aborted turn: the delete commits while the turn's last message insert is still
// in flight, and the insert then fails with
// "FOREIGN KEY constraint failed: insert into message" against the deleted
// session row. Under bulk clients that cancel slow streams (RAG pipelines with
// aggressive timeouts, retry loops), this produced thousands of constraint
// errors per day. Deleting only settled sessions mirrors how long-lived SDK
// consumers (e.g. chat bots that keep one session per conversation) avoid the
// race entirely.
//
// NOTE: "Proxy: " is a reserved title prefix — this plugin titles its throwaway
// sessions `Proxy: <model-id>` at creation. Do not name real sessions with this
// prefix: idle ones get reaped here. Internal helper — exported for tests.
export async function sweepStaleProxySessions(client, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (typeof client.session.list !== "function") return
  let sessions
  try {
    const result = await client.session.list()
    sessions = result.data ?? []
  } catch (error) {
    await safeLog(client, "warn", "OpenAI proxy stale-session sweep could not list sessions", {
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const cutoff = Date.now() - maxAgeMs
  let reaped = 0
  for (const s of sessions) {
    if (!s?.title?.startsWith("Proxy:")) continue
    const updated = Number(s.time_updated ?? s.timeUpdated ?? 0)
    // Fail safe: only treat as a stale ms-epoch timestamp. Rejects seconds-epoch
    // values, NaN, and missing fields (those sessions are left for the next sweep
    // rather than risk mass-deleting fresh ones on a units mismatch).
    if (!(updated > 1e12) || updated >= cutoff) continue
    try {
      await client.session.delete({ path: { id: s.id } })
      reaped++
    } catch {
      // skip; a later sweep retries
    }
  }
  if (reaped > 0) {
    await safeLog(client, "info", "OpenAI proxy stale-session sweep", { reaped })
  }
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

// Run the sweep at startup and every SWEEP_INTERVAL_MS so long-lived processes
// still reap leaked sessions. The timer is unref'd: it never keeps the process
// alive on its own.
function scheduleSessionSweeps(client) {
  void sweepStaleProxySessions(client).catch(() => {})
  const timer = setInterval(() => {
    void sweepStaleProxySessions(client).catch(() => {})
  }, SWEEP_INTERVAL_MS)
  timer.unref?.()
  return timer
}

function setGenerationControls(sessionID, controls) {
  if (!sessionID || !controls || Object.keys(controls).length === 0) return
  const state = getState()
  state.generationControls ??= new Map()
  state.generationControls.set(sessionID, controls)
}

function clearGenerationControls(sessionID) {
  getState().generationControls?.delete(sessionID)
}

async function executePrompt(client, _request, model, messages, system, callerTools = [], options = {}) {
  if (Array.isArray(callerTools) && callerTools.length > 0) {
    // Tool-aware path: must watch the event stream (via runAgentTurn) rather than
    // block on session.prompt, so we can intercept a proposed tool call instead of
    // letting OpenCode's agent loop run to a final text answer.
    const result = await runAgentTurn(client, model, messages, system, callerTools, () => {}, options)
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      request: _request,
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
  let sessionID
  let settled = false // safe teardown: only delete sessions whose turn fully settled
  try {
    const session = await client.session.create({ body: { title: `Proxy: ${model.id}` }, signal: options.signal })
    sessionID = session.data.id
    setGenerationControls(sessionID, options.controls)
    const completion = await client.session.prompt({
      path: { id: sessionID },
      signal: options.signal,
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        system,
        tools,
        parts: promptParts(messages, options.media, model, options.maxRequestBytes ?? DEFAULTS.maxRequestBytes),
        ...(options.format ? { format: options.format } : {}),
        ...(options.variant ? { variant: options.variant } : {}),
      },
    })

    const structured = completion.data.info?.structured
    const content = structured === undefined ? extractAssistantText(completion.data.parts ?? []) : JSON.stringify(structured)

    if (!content && completion.data.info?.error) throw new Error(completion.data.info.error.message ?? "Model call failed.")

    settled = true
    return { content, structured, toolCalls: [], completion, request: _request, sessionID }
  } finally {
    clearGenerationControls(sessionID)
    // Deleting an aborted/errored session here races the server's final persist
    // of the aborted turn (FOREIGN KEY constraint failures under bulk cancels).
    // Leak it instead; sweepStaleProxySessions reaps it once long idle.
    if (settled) await deleteSession(client, sessionID, options.keepSessions)
  }
}

async function executePromptStreaming(client, model, messages, system, onChunk, callerTools = [], options = {}) {
  const result = await runAgentTurn(client, model, messages, system, callerTools, onChunk, options)
  return {
    sessionID: result.sessionID,
    tokens: result.tokens,
    finish: result.finish,
    toolCalls: result.toolCalls,
    content: result.structured === undefined ? result.content : JSON.stringify(result.structured),
    structured: result.structured,
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

async function acquireBridgeSlot(options = {}) {
  const bridgeState = getToolBridgeState()
  if (options.signal?.aborted) throw options.signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled")
  if (bridgeState.freeSlots.length > 0) {
    return bridgeState.freeSlots.shift()
  }
  if (bridgeState.waiters.filter((waiter) => waiter.active).length >= (options.maxQueue ?? DEFAULTS.bridgeMaxQueue)) {
    throw new ProxyError("Tool capacity is busy. Try again later.", 429, "tool_capacity_overloaded")
  }
  return new Promise((resolve, reject) => {
    const waiter = { active: true }
    const removeWaiter = () => {
      bridgeState.waiters = bridgeState.waiters.filter((entry) => entry !== waiter)
    }
    const timeout = setTimeout(() => {
      if (!waiter.active) return
      waiter.active = false
      removeWaiter()
      options.signal?.removeEventListener("abort", onAbort)
      reject(new ProxyError("Timed out waiting for tool capacity.", 503, "tool_capacity_timeout"))
    }, options.timeoutMs ?? DEFAULTS.bridgeAcquireTimeoutMs)
    timeout.unref?.()
    const onAbort = () => {
      if (!waiter.active) return
      waiter.active = false
      clearTimeout(timeout)
      removeWaiter()
      reject(options.signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled"))
    }
    waiter.resolve = (slot) => {
      if (!waiter.active) return false
      waiter.active = false
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(slot)
      return true
    }
    bridgeState.waiters.push(waiter)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function releaseBridgeSlot(slotName) {
  const bridgeState = getToolBridgeState()
  if (bridgeState.waiters.length > 0) {
    while (bridgeState.waiters.length > 0) {
      const waiter = bridgeState.waiters.shift()
      if (waiter.resolve(slotName)) return
    }
  }
  if (!bridgeState.freeSlots.includes(slotName)) bridgeState.freeSlots.push(slotName)
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

export async function registerToolBridge(client, tools, options = {}) {
  const slotName = await acquireBridgeSlot(options)
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
  if (bridge && !bridge.released) {
    bridge.released = true
    releaseBridgeSlot(bridge.slotName)
  }
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

async function runAgentTurn(client, model, messages, system, callerTools, onChunk, options = {}) {
  const baseTools = await getDisabledTools(client)
  let toolsMap = baseTools
  let bridge = null

  if (Array.isArray(callerTools) && callerTools.length > 0) {
    bridge = await registerToolBridge(client, callerTools, {
      signal: options.signal,
      timeoutMs: options.bridgeAcquireTimeoutMs,
      maxQueue: options.bridgeMaxQueue,
    })
    toolsMap = buildToolsMap(baseTools, bridge)
  }

  let sessionID
  let eventStream
  let removeAbortListener = () => {}
  const toolIDSet = bridge ? new Set(bridge.toolIDs) : null

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
    const session = await client.session.create({ body: { title: `Proxy: ${model.id}` }, signal: options.signal })
    sessionID = session.data.id
    setGenerationControls(sessionID, options.controls)
    const onAbort = () => client.session.abort?.({ path: { id: sessionID } }).catch(() => {})
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    // Subscribe before prompting so no events are missed.
    const { stream } = await client.event.subscribe({ signal: options.signal })
    eventStream = stream
    await client.session.promptAsync({
      path: { id: sessionID },
      signal: options.signal,
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        system,
        tools: toolsMap,
        parts: promptParts(messages, options.media, model, options.maxRequestBytes ?? DEFAULTS.maxRequestBytes),
        ...(options.format ? { format: options.format } : {}),
        ...(options.variant ? { variant: options.variant } : {}),
      },
    })
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
          await onChunk?.(props.delta)
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
        if (event.properties?.sessionID === sessionID) {
          errorMessage = event.properties?.error?.message ?? "Model call failed."
        }
        break
      } else if (event.type === "session.idle") {
        if (event.properties?.sessionID === sessionID) {
          break
        }
      }
    }
  } catch (error) {
    // Safe teardown: no delete on abort/error — it races the server's final
    // persist of the aborted turn (FOREIGN KEY failures under bulk cancels).
    // The session leaks inert; sweepStaleProxySessions reaps it once long idle.
    throw error
  } finally {
    removeAbortListener()
    try {
      await eventStream?.return?.()
    } catch {
      // Signal and session cleanup remain authoritative if iterator disposal fails.
    }
    clearGenerationControls(sessionID)
    releaseToolBridge(bridge)
  }

  const toolCalls = [...toolCallsByID.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments ?? {},
  }))

  if (errorMessage && toolCalls.length === 0) {
    // Safe teardown: leak-on-error (was: delete then throw).
    throw new Error(errorMessage)
  }

  // Each list item is { info: Message, parts: Part[] } - matching the shape
  // client.session.prompt() (the non-tool-calling path) already returns directly.
  let assistantEntry
  try {
    const messagesResult = await client.session.messages({ path: { id: sessionID }, signal: options.signal })
    assistantEntry = (messagesResult.data ?? []).filter((m) => m.info?.role === "assistant").at(-1)
  } catch (error) {
    // Safe teardown: leak-on-error (was: delete then throw).
    throw error
  }
  const assistantInfo = assistantEntry?.info

  // Fallback for turns where message.part.delta never fired (observed for some
  // multi-step turns, e.g. continuing a conversation with prior tool calls/results in
  // history): use the authoritative final text from the fetched message's parts
  // instead of leaving content empty.
  if (!content && toolCalls.length === 0) {
    content = extractAssistantText(assistantEntry?.parts ?? [])
  }
  if (!content && assistantInfo?.structured !== undefined) content = JSON.stringify(assistantInfo.structured)

  const result = {
    sessionID,
    content,
    toolCalls,
    tokens: assistantInfo?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: toolCalls.length > 0 ? "tool_calls" : assistantInfo?.finish,
    structured: assistantInfo?.structured,
  }
  // Safe teardown: only delete when the turn completed without a server-side
  // error (errorMessage with partial tool calls still lands here — the turn did
  // not settle cleanly, so leak it for the sweep instead).
  if (!errorMessage) await deleteSession(client, sessionID, options.keepSessions)
  return result
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
      capabilities: model.capabilities,
      limit: model.limit,
      cost: model.cost,
      status: model.status,
      variants: model.variants,
    }))
  })
}

export async function resolveModel(client, requestedModel, providerOverride) {
  const allModels = await listModels(client)
  if (providerOverride && requestedModel.includes("/")) {
    const [providerID] = requestedModel.split("/")
    if (providerID !== providerOverride) {
      throw new Error(`Model '${requestedModel}' does not match provider override '${providerOverride}'.`)
    }
  }
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

async function resolveModelCandidates(client, requestedModel, providerOverride, aliases = {}) {
  const configured = aliases[requestedModel]
  const targets = typeof configured === "string" ? [configured] : configured
  if (configured !== undefined && (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== "string"))) {
    throw new ProxyError(`Model alias '${requestedModel}' is invalid.`, 500, "invalid_config")
  }
  const ids = targets ?? [requestedModel]
  const models = []
  for (const id of ids) models.push(await resolveModel(client, id, providerOverride))
  return models
}

function isRetryableError(error) {
  if (error instanceof ProxyError && error.status < 500) return false
  return !error?.message?.toLowerCase().includes("invalid")
}

function upstreamOutcome(error) {
  if (error?.code === "timeout" || error?.status === 504) return "timeout"
  if (error?.code === "cancelled" || error?.status === 499) return "cancelled"
  return "error"
}

function recordExecutionMetrics(result) {
  const tokens = result?.tokens ?? result?.completion?.data?.info?.tokens
  getMetrics().recordUpstreamAttempt("success")
  if (tokens) getMetrics().recordTokens(tokens)
}

async function executeWithFallback(candidates, operation) {
  let lastError
  for (const candidate of candidates) {
    try {
      const result = await operation(candidate)
      recordExecutionMetrics(result)
      return { result, model: candidate }
    } catch (error) {
      getMetrics().recordUpstreamAttempt(upstreamOutcome(error))
      lastError = error
      if (!isRetryableError(error)) throw error
    }
  }
  throw lastError
}

async function executeStreamingWithFallback(candidates, operation, hasOutput) {
  let lastError
  for (const candidate of candidates) {
    try {
      const result = await operation(candidate)
      recordExecutionMetrics(result)
      return { result, model: candidate }
    } catch (error) {
      getMetrics().recordUpstreamAttempt(upstreamOutcome(error))
      lastError = error
      if (hasOutput() || !isRetryableError(error)) throw error
    }
  }
  throw lastError
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

function streamResponse(headers, generator, options = {}) {
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
        options.onDone?.()
      }
    },
    cancel(reason) {
      options.onCancel?.(reason)
      options.onDone?.()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...headers,
    },
  })
}

function sseResponse(headers, generator, options) {
  return streamResponse(headers, generator, options)
}

function once(callback) {
  let called = false
  return () => {
    if (called) return
    called = true
    callback?.()
  }
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
      x_opencode: {
        name: model.name,
        status: model.status,
        capabilities: model.capabilities,
        limits: model.limit,
        variants: model.variants,
        cost: model.cost,
      },
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

function generationControls(body) {
  const source = body.generationConfig ?? body
  const controls = {}
  if (source.temperature !== undefined) {
    if (typeof source.temperature !== "number" || source.temperature < 0 || source.temperature > 2) {
      throw new ProxyError("'temperature' must be a number between 0 and 2.", 400, "invalid_parameter")
    }
    controls.temperature = source.temperature
  }
  const topP = source.top_p ?? source.topP
  if (topP !== undefined) {
    if (typeof topP !== "number" || topP < 0 || topP > 1) throw new ProxyError("'top_p' must be between 0 and 1.", 400, "invalid_parameter")
    controls.topP = topP
  }
  const topK = source.topK
  if (topK !== undefined) {
    if (!Number.isInteger(topK) || topK < 1) throw new ProxyError("'topK' must be a positive integer.", 400, "invalid_parameter")
    controls.topK = topK
  }
  return controls
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
  const match = pathname.match(/^\/v1beta\/models\/(.+):(?:generateContent|streamGenerateContent)$/)
  return match ? decodeURIComponent(match[1]) : null
}

export function createProxyFetchHandler(client) {
  const config = loadConfig()
  const handleRequest = async (request) => {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")

    if (request.method === "OPTIONS") {
      const method = request.headers.get("access-control-request-method")
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
      const allowedHeaders = new Set(["authorization", "content-type", "x-opencode-provider", "x-opencode-variant", "x-request-id"])
      const allowedOrigin = origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin))
      if (!allowedOrigin || (method && !["GET", "POST", "OPTIONS"].includes(method)) || requestedHeaders.some((value) => !allowedHeaders.has(value))) {
        return text("CORS preflight rejected", 403, request, config)
      }
      return new Response(null, { status: 204, headers: commonHeaders(request, config) })
    }

    if (origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
      return text("Origin not allowed", 403, request, config)
    }

    if (!isAuthorized(request, config)) {
      return unauthorized(request)
    }

    const started = Date.now()
    const context = createRequestSignal(request, config.requestTimeoutMs)
    let releaseSlot = () => {}
    let deferredCleanup = false
    if (request.method === "POST") {
      try {
        releaseSlot = await acquireRequestSlot(config, context.signal)
      } catch (error) {
        context.finish()
        const status = error instanceof ProxyError ? error.status : 503
        return badRequest(status === 503 ? "The proxy is busy. Try again later." : "Request was cancelled.", status, request)
      }
    }

    const options = {
      signal: context.signal,
      maxRequestBytes: config.maxRequestBytes,
      bridgeAcquireTimeoutMs: config.bridgeAcquireTimeoutMs,
      bridgeMaxQueue: config.bridgeMaxQueue,
      keepSessions: config.keepSessions,
    }
    const streamCleanup = once(() => {
      releaseSlot()
      context.finish()
      safeLog(client, "info", "Proxy stream completed", {
        method: request.method,
        path: url.pathname,
        durationMs: Date.now() - started,
      })
    })

    try {

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ healthy: true, service: "opencode-openai-proxy" }, 200, {}, request)
    }

    if (request.method === "GET" && url.pathname === "/metrics" && config.metricsEnabled) {
      return new Response(getMetrics().metrics(), {
        status: 200,
        headers: {
          ...commonHeaders(request, config),
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
        },
      })
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
        body = await readJsonBody(request, config.maxRequestBytes, context.signal)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      if (!body.model) {
        return badRequest("The 'model' field is required.", 400, request)
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return badRequest("The 'messages' field must contain at least one message.", 400, request)
      }

      const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice)
      let format
      let controls
      try {
        validateUnsupportedControls(body)
        format = structuredFormat(body)
        if (format && callerTools.length > 0) throw new ProxyError("Structured output cannot be combined with tools.", 400, "invalid_request")
        controls = generationControls(body)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      let candidates
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy completion failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request)
      }

      let prepared
      try {
        prepared = await prepareCanonicalRequest(adaptOpenAIChat(body), config, context.signal, candidates)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request, error.code)
      }
      const { messages, system, media } = prepared
      if (!messages[0].content.trim() && media.length === 0) {
        return badRequest("No text content was found in the supplied messages.", 400, request)
      }
      const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? undefined }
      let model = candidates[0]

      if (body.stream) {
        const completionID = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`
        const now = Math.floor(Date.now() / 1000)

        const queue = createSseQueue()
        let emitted = false

        async function* generateSse() {
          const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
            client,
            candidate,
            messages,
            system,
            (delta) => {
              emitted = true
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
            requestOptions,
          ), () => emitted)
            .then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true
                const chunk = JSON.stringify({ id: completionID, object: "chat.completion.chunk", created: now, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: streamResult.content }, finish_reason: null }] })
                queue.enqueue(`data: ${chunk}\n\n`)
              }
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
                error: { message: "Upstream request failed.", type: "server_error" },
              })
              queue.enqueue(`data: ${errChunk}\n\ndata: [DONE]\n\n`)
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()

          await runPromise
        }

        deferredCleanup = true
        return sseResponse(commonHeaders(request, config), generateSse(), {
          onCancel: (reason) => context.abort(reason),
          onDone: streamCleanup,
        })
      }

      try {
        const executed = await executeWithFallback(candidates, (candidate) =>
          executePrompt(client, body, candidate, messages, system, callerTools, requestOptions))
        model = executed.model
        return json(createChatCompletionResponse(executed.result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy completion failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request)
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/responses") {
      let body
      try {
        body = await readJsonBody(request, config.maxRequestBytes, context.signal)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      if (!body.model) {
        return badRequest("The 'model' field is required.", 400, request)
      }

      const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice)
      let format
      let controls
      try {
        validateUnsupportedControls(body)
        format = structuredFormat(body)
        if (format && callerTools.length > 0) throw new ProxyError("Structured output cannot be combined with tools.", 400, "invalid_request")
        controls = generationControls(body)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      let candidates
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy responses call failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request)
      }

      let prepared
      try {
        prepared = await prepareCanonicalRequest(adaptOpenAIResponses(body), config, context.signal, candidates)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request, error.code)
      }
      const { messages, system, media } = prepared
      if (!messages[0].content.trim() && media.length === 0) {
        return badRequest("The 'input' field must contain at least one text message.", 400, request)
      }
      const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? body.reasoning?.effort ?? undefined }
      let model = candidates[0]

      if (body.stream) {
        const responseID = `resp_${crypto.randomUUID().replace(/-/g, "")}`
        const itemID = `msg_${crypto.randomUUID().replace(/-/g, "")}`
        const now = Math.floor(Date.now() / 1000)

        const queue = createSseQueue()
        let emitted = false

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
          let partIndex = 0
          // Accumulate delta tokens so we can populate `text` on output_text.done and content_part.done per the
          // OpenAI Responses API SSE spec (https://platform.openai.com/docs/api-reference/responses-streaming).
          let accumulatedText = ""
          const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
            client,
            candidate,
            messages,
            system,
            (delta) => {
              emitted = true
              if (partIndex === 0) {
                queue.enqueue(
                  sseEvent("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] },
                  }),
                )
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
            requestOptions,
          ), () => emitted)
            .then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                accumulatedText = streamResult.content
                emitted = true
                queue.enqueue(sseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] } }))
                queue.enqueue(sseEvent("response.content_part.added", { type: "response.content_part.added", item_id: itemID, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }))
                queue.enqueue(sseEvent("response.output_text.delta", { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: accumulatedText }))
                partIndex = 1
              }
              const toolCalls = streamResult.toolCalls ?? []
              if (toolCalls.length > 0) {
                // Each parallel tool call is its own output item with a distinct output_index.
                toolCalls.forEach((call, index) => {
                  const args = JSON.stringify(call.arguments ?? {})
                  const callItemID = `fc_${crypto.randomUUID().replace(/-/g, "")}`
                  const outputIndex = index
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
                    error: { message: "Upstream request failed.", code: "server_error" },
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

        deferredCleanup = true
        return sseResponse(commonHeaders(request, config), generateSse(), {
          onCancel: (reason) => context.abort(reason),
          onDone: streamCleanup,
        })
      }

      try {
        const executed = await executeWithFallback(candidates, (candidate) =>
          executePrompt(client, body, candidate, messages, system, callerTools, requestOptions))
        model = executed.model
        return json(createResponsesApiResponse(executed.result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Proxy responses call failed", {
          error: message,
          requestedModel: body.model,
        })
        return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request)
      }
    }

    // -----------------------------------------------------------------------
    // Anthropic Messages API  POST /v1/messages
    // -----------------------------------------------------------------------

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      let body
      try {
        body = await readJsonBody(request, config.maxRequestBytes, context.signal)
      } catch (error) {
        return anthropicBadRequest(error.message, error.status ?? 400, request)
      }

      if (!body.model) {
        return anthropicBadRequest("The 'model' field is required.", 400, request)
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return anthropicBadRequest("The 'messages' field must contain at least one message.", 400, request)
      }

      const callerTools = applyAnthropicToolChoice(parseAnthropicTools(body), body.tool_choice)
      let controls
      try {
        validateUnsupportedControls(body)
        controls = generationControls(body)
      } catch (error) {
        return anthropicBadRequest(error.message, error.status ?? 400, request)
      }

      let candidates
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Anthropic proxy call failed (model resolve)", { error: message, requestedModel: body.model })
        return anthropicBadRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request)
      }

      let prepared
      try {
        prepared = await prepareCanonicalRequest(adaptAnthropic(body), config, context.signal, candidates)
      } catch (error) {
        return anthropicBadRequest(error.message, error.status ?? 400, request)
      }
      const { messages, system, media } = prepared
      if (!messages[0].content.trim() && media.length === 0) {
        return anthropicBadRequest("No text content was found in the supplied messages.", 400, request)
      }
      const requestOptions = { ...options, media, controls, variant: request.headers.get("x-opencode-variant") ?? undefined }
      let model = candidates[0]

      if (body.stream) {
        const msgID = `msg_${crypto.randomUUID().replace(/-/g, "")}`
        const queue = createSseQueue()
        let emitted = false

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
          const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
            client,
            candidate,
            messages,
            system,
            (delta) => {
              emitted = true
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
            requestOptions,
          ), () => emitted)
            .then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true
                textBlockStarted = true
                queue.enqueue(sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))
                queue.enqueue(sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: streamResult.content } }))
              }
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
              queue.enqueue(sseEvent("error", { type: "error", error: { type: "api_error", message: "Upstream request failed." } }))
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()
          await runPromise
        }

        deferredCleanup = true
        return sseResponse(commonHeaders(request, config), generateSse(), {
          onCancel: (reason) => context.abort(reason),
          onDone: streamCleanup,
        })
      }

      try {
        const executed = await executeWithFallback(candidates, (candidate) =>
          executePrompt(client, body, candidate, messages, system, callerTools, requestOptions))
        model = executed.model
        return json(createAnthropicResponse(executed.result, model), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Anthropic proxy call failed", { error: message, requestedModel: body.model })
        return anthropicInternalError(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request)
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
        body = await readJsonBody(request, config.maxRequestBytes, context.signal)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      if (!Array.isArray(body.contents) || body.contents.length === 0) {
        return badRequest("The 'contents' field must contain at least one item.", 400, request)
      }

      const callerTools = applyGeminiToolChoice(parseGeminiTools(body), body.toolConfig)
      let format
      let controls
      try {
        format = structuredFormat(body)
        controls = generationControls(body)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request)
      }

      let candidates
      try {
        const providerOverride = request.headers.get("x-opencode-provider")
        candidates = await resolveModelCandidates(client, geminiModelName, providerOverride, config.aliases)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Gemini proxy call failed (model resolve)", { error: message, requestedModel: geminiModelName })
        return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request)
      }

      let prepared
      try {
        prepared = await prepareCanonicalRequest(adaptGemini(body), config, context.signal, candidates)
      } catch (error) {
        return badRequest(error.message, error.status ?? 400, request, error.code)
      }
      const { messages, system, media } = prepared
      if (!messages[0].content.trim() && media.length === 0) {
        return badRequest("No text content was found in the supplied contents.", 400, request)
      }
      const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? undefined }
      if (isGeminiStream) {
        const queue = createSseQueue()
        let emitted = false

        async function* generateNdJson() {
          const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
            client,
            candidate,
            messages,
            system,
            (delta) => {
              emitted = true
              const chunk = JSON.stringify(createGeminiResponse(delta, null, null))
              queue.enqueue(chunk + "\n")
            },
            callerTools,
            requestOptions,
          ), () => emitted)
            .then(({ result: streamResult }) => {
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true
                queue.enqueue(JSON.stringify(createGeminiResponse(streamResult.content, null, null)) + "\n")
              }
              const toolCalls = streamResult.toolCalls ?? []
              if (toolCalls.length > 0) {
                queue.enqueue(JSON.stringify(createGeminiResponse("", null, null, toolCalls)) + "\n")
              }
              const finalChunk = JSON.stringify(createGeminiResponse("", streamResult.finish, streamResult.tokens))
              queue.enqueue(finalChunk + "\n")
            })
            .catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err)
              await safeLog(client, "error", "Gemini proxy streaming call failed", { error: errMsg, requestedModel: geminiModelName })
              const errChunk = JSON.stringify({ error: { code: 502, message: "Upstream request failed.", status: "UNAVAILABLE" } })
              queue.enqueue(errChunk + "\n")
            })
            .finally(() => {
              queue.finish()
            })

          yield* queue.generateChunks()
          await runPromise
        }

        deferredCleanup = true
        return streamResponse({
          ...commonHeaders(request, config),
          "content-type": "application/x-ndjson; charset=utf-8",
        }, generateNdJson(), {
          onCancel: (reason) => context.abort(reason),
          onDone: streamCleanup,
        })
      }

      try {
        const executed = await executeWithFallback(candidates, (candidate) =>
          executePrompt(client, body, candidate, messages, system, callerTools, requestOptions))
        const result = executed.result
        const finish = result.completion.data.info?.finish
        const tokens = result.completion.data.info?.tokens
        return json(createGeminiResponse(result.content, finish, tokens, result.toolCalls), 200, {}, request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await safeLog(client, "error", "Gemini proxy call failed", { error: message, requestedModel: geminiModelName })
        return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request)
      }
    }

    return text("Not found", 404, request, config)
    } finally {
      if (!deferredCleanup) {
        releaseSlot()
        context.finish()
        safeLog(client, "info", "Proxy request completed", {
          method: request.method,
          path: url.pathname,
          durationMs: Date.now() - started,
        })
      }
    }
  }

  return async (request) => {
    const started = Date.now()
    const response = await handleRequest(request)
    const details = {
      method: request.method,
      pathname: new URL(request.url).pathname,
      status: response.status,
    }
    const contentType = response.headers.get("content-type") ?? ""
    const streaming = contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")
    if (streaming && response.body) {
      const reader = response.body.getReader()
      const finish = once(() => getMetrics().recordHttpCompletion({ ...details, durationMs: Date.now() - started }))
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              controller.close()
              finish()
            } else {
              controller.enqueue(value)
            }
          } catch (error) {
            controller.error(error)
            finish()
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            finish()
          }
        },
      })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    getMetrics().recordHttpCompletion({ ...details, durationMs: Date.now() - started })
    return response
  }
}

export const OpenAIProxyPlugin = async ({ client }) => {
  const state = getState()
  if (state.started) {
    return {}
  }

  const hostname = process.env.OPENCODE_LLM_PROXY_HOST ?? "127.0.0.1"
  const port = Number.parseInt(process.env.OPENCODE_LLM_PROXY_PORT ?? "4010", 10)
  let config
  try {
    config = loadConfig()
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyError("Proxy port must be between 1 and 65535.", 500, "invalid_config")
    const normalizedHost = hostname.replace(/^\[|\]$/g, "")
    const loopback = normalizedHost === "localhost" || normalizedHost === "::1" || normalizedHost.startsWith("127.") || normalizedHost.startsWith("::ffff:127.")
    if (!loopback && config.tokens.length === 0) {
      throw new ProxyError("A bearer token is required when binding beyond loopback.", 500, "invalid_config")
    }
  } catch (error) {
    await safeLog(client, "warn", "OpenAI proxy configuration is invalid", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }

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

  state.started = true
  state.server = server

  // Safe teardown: reap stale leaked "Proxy:" sessions now and periodically
  // (fire-and-forget; never blocks or fails startup).
  state.sweepTimer = scheduleSessionSweeps(client)

  await safeLog(client, "info", "OpenAI proxy server started", {
    hostname,
    port,
    protected: Boolean(process.env.OPENCODE_LLM_PROXY_TOKEN),
  })

  return {
    "chat.params": async (input, output) => {
      const controls = getState().generationControls?.get(input.sessionID)
      if (!controls) return
      if (controls.temperature !== undefined) output.temperature = controls.temperature
      if (controls.topP !== undefined) output.topP = controls.topP
      if (controls.topK !== undefined) output.topK = controls.topK
    },
  }
}

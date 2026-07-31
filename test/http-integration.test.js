import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import http from "node:http"
import test from "node:test"

import { createProxyFetchHandler } from "../index.js"

const TOKENS = { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function streamEvents(events) {
  return async function* ({ sessionID }) {
    for (const event of events) {
      yield typeof event === "function" ? event(sessionID) : event
    }
  }
}

function hangingEvents(firstDelta) {
  return async function* ({ sessionID, signal }) {
    if (firstDelta) {
      yield {
        type: "message.part.delta",
        properties: { sessionID, field: "text", delta: firstDelta },
      }
    }
    await new Promise((_, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
}

function createMockClient(onPrompt) {
  let sequence = 0
  const pendingSubscriptions = []
  const records = new Map()
  const state = { aborts: 0, iteratorReturns: 0, attempts: [], creates: 0 }

  return {
    state,
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{
            id: "openai",
            models: { first: { id: "first" }, second: { id: "second" } },
          }],
        },
      }),
    },
    session: {
      create: async () => {
        const sessionID = `session-${++sequence}`
        const ready = deferred()
        records.set(sessionID, { sessionID, ready, spec: null })
        pendingSubscriptions.push(sessionID)
        state.creates++
        return { data: { id: sessionID } }
      },
      promptAsync: async ({ path, body, signal }) => {
        const record = records.get(path.id)
        state.attempts.push(body.model.modelID)
        record.spec = onPrompt({ modelID: body.model.modelID, sessionID: path.id, signal })
        record.ready.resolve()
      },
      abort: async () => {
        state.aborts++
        return { data: true }
      },
      messages: async ({ path }) => {
        const spec = records.get(path.id).spec
        return {
          data: [{
            info: { role: "assistant", tokens: TOKENS, finish: "stop" },
            parts: [{ type: "text", text: spec?.finalText ?? "" }],
          }],
        }
      },
      delete: async () => ({ data: true }),
    },
    event: {
      subscribe: async ({ signal }) => {
        const sessionID = pendingSubscriptions.shift()
        const record = records.get(sessionID)
        let inner
        return {
          stream: {
            async next() {
              await record.ready.promise
              inner ??= record.spec.events({ sessionID, signal })[Symbol.asyncIterator]()
              return inner.next()
            },
            async return() {
              state.iteratorReturns++
              return inner?.return?.() ?? { done: true }
            },
            [Symbol.asyncIterator]() {
              return this
            },
          },
        }
      },
    },
  }
}

async function startServer(client, env = {}) {
  const previous = new Map()
  for (const [name, value] of Object.entries(env)) {
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  let handler
  try {
    handler = createProxyFetchHandler(client)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const server = http.createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("HTTP client disconnected"))
    incoming.once("aborted", abort)
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) abort()
    })

    try {
      const chunks = []
      for await (const chunk of incoming) chunks.push(chunk)
      const address = server.address()
      const request = new Request(`http://127.0.0.1:${address.port}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        signal: controller.signal,
      })
      const response = await handler(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return outgoing.end()

      const reader = response.body.getReader()
      const cancel = () => reader.cancel(new Error("HTTP client disconnected")).catch(() => {})
      outgoing.once("close", cancel)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!outgoing.write(value)) await new Promise((resolve) => outgoing.once("drain", resolve))
        }
        outgoing.end()
      } finally {
        outgoing.off("close", cancel)
        reader.releaseLock()
      }
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500)
      if (!outgoing.destroyed) outgoing.end(String(error))
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function post(url, body, onResponse) {
  const target = new URL(url)
  const payload = JSON.stringify(body)
  const request = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  }, onResponse)
  request.end(payload)
  return request
}

function collectResponse(url, body) {
  return new Promise((resolve, reject) => {
    const request = post(url, body, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }))
    })
    request.on("error", reject)
  })
}

function getResponse(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }))
    }).on("error", reject)
  })
}

const chatRequest = (model = "first") => ({
  model,
  stream: true,
  messages: [{ role: "user", content: "hello" }],
})

test("GET /health traverses a real HTTP socket", async (t) => {
  const client = createMockClient(() => { throw new Error("not used") })
  const server = await startServer(client)
  t.after(server.close)

  const response = await getResponse(`${server.url}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text), { healthy: true, service: "opencode-openai-proxy" })
})

test("SSE streams over a socket and disconnect cancels OpenCode work", async (t) => {
  const client = createMockClient(() => ({ events: hangingEvents("hello") }))
  const server = await startServer(client)
  t.after(server.close)

  await new Promise((resolve, reject) => {
    const request = post(`${server.url}/v1/chat/completions`, chatRequest(), (response) => {
      response.once("data", (chunk) => {
        assert.match(chunk.toString(), /hello/)
        response.destroy()
        resolve()
      })
    })
    request.on("error", reject)
  })

  await waitFor(() => client.state.aborts === 1 && client.state.iteratorReturns === 1, "disconnect cleanup did not run")
})

test("request timeout emits a protocol failure and terminates the stream", async (t) => {
  const client = createMockClient(() => ({ events: hangingEvents() }))
  const server = await startServer(client, { OPENCODE_LLM_PROXY_REQUEST_TIMEOUT_MS: "40" })
  t.after(server.close)

  const response = await collectResponse(`${server.url}/v1/chat/completions`, chatRequest())
  assert.equal(response.status, 200)
  assert.match(response.text, /"type":"server_error"/)
  assert.match(response.text, /data: \[DONE\]/)
  assert.equal(client.state.aborts, 1)
  assert.equal(client.state.iteratorReturns, 1)
})

test("one active and one queued request cause a third request to receive 503", async (t) => {
  const client = createMockClient(() => ({ events: hangingEvents("held") }))
  const server = await startServer(client, {
    OPENCODE_LLM_PROXY_MAX_CONCURRENT_REQUESTS: "1",
    OPENCODE_LLM_PROXY_MAX_QUEUED_REQUESTS: "1",
  })
  t.after(server.close)

  let firstResponse
  const firstReady = deferred()
  const first = post(`${server.url}/v1/chat/completions`, chatRequest(), (response) => {
    firstResponse = response
    response.once("data", firstReady.resolve)
  })
  t.after(() => first.destroy())
  await firstReady.promise

  let secondResponse
  const secondReady = deferred()
  const second = post(`${server.url}/v1/chat/completions`, chatRequest(), (response) => {
    secondResponse = response
    response.once("data", secondReady.resolve)
  })
  t.after(() => second.destroy())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.state.creates, 1, "queued request reached the OpenCode client")

  const third = await collectResponse(`${server.url}/v1/chat/completions`, chatRequest())
  assert.equal(third.status, 503)
  assert.match(third.text, /proxy is busy/i)

  firstResponse.destroy()
  await secondReady.promise
  assert.equal(client.state.creates, 2)
  secondResponse.destroy()
})

test("stream alias falls back before output", async (t) => {
  const client = createMockClient(({ modelID }) => modelID === "first"
    ? { events: streamEvents([(sessionID) => ({ type: "session.error", properties: { sessionID, error: { message: "retryable" } } })]) }
    : { events: streamEvents([
        (sessionID) => ({ type: "message.part.delta", properties: { sessionID, field: "text", delta: "fallback" } }),
        (sessionID) => ({ type: "session.idle", properties: { sessionID } }),
      ]), finalText: "fallback" })
  const server = await startServer(client, {
    OPENCODE_LLM_PROXY_MODEL_ALIASES: JSON.stringify({ smart: ["openai/first", "openai/second"] }),
  })
  t.after(server.close)

  const response = await collectResponse(`${server.url}/v1/chat/completions`, chatRequest("smart"))
  assert.equal(response.status, 200)
  assert.match(response.text, /fallback/)
  assert.deepEqual(client.state.attempts, ["first", "second"])
})

test("stream alias does not fall back after output", async (t) => {
  const client = createMockClient(() => ({ events: streamEvents([
    (sessionID) => ({ type: "message.part.delta", properties: { sessionID, field: "text", delta: "partial" } }),
    (sessionID) => ({ type: "session.error", properties: { sessionID, error: { message: "failed after output" } } }),
  ]) }))
  const server = await startServer(client, {
    OPENCODE_LLM_PROXY_MODEL_ALIASES: JSON.stringify({ smart: ["openai/first", "openai/second"] }),
  })
  t.after(server.close)

  const response = await collectResponse(`${server.url}/v1/chat/completions`, chatRequest("smart"))
  assert.equal(response.status, 200)
  assert.match(response.text, /partial/)
  assert.match(response.text, /"type":"server_error"/)
  assert.deepEqual(client.state.attempts, ["first"])
})

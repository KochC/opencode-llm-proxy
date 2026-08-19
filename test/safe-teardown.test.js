import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"

import { createProxyFetchHandler, sweepStaleProxySessions } from "../index.js"

const TOKENS = { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

function createMockClient({ promptMode = "hang", streamEvents = null } = {}) {
  const state = { created: [], deleted: [] }
  const records = new Map()
  let pendingSubscription = null
  return {
    state,
    app: { log: async () => {} },
    tool: { ids: async () => ({ data: [] }) },
    config: {
      providers: async () => ({
        data: {
          providers: [{ id: "openai", models: { first: { id: "first" } } }],
        },
      }),
    },
    session: {
      create: async () => {
        const id = `session-${state.created.length + 1}`
        state.created.push(id)
        records.set(id, { ready: null })
        return { data: { id } }
      },
      prompt: async ({ signal }) => {
        if (promptMode === "resolve") {
          return {
            data: {
              info: { finish: "stop", tokens: TOKENS },
              parts: [{ type: "text", text: "hello" }],
            },
          }
        }
        await new Promise((_, reject) => {
          if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })
        })
      },
      promptAsync: async ({ path }) => {
        pendingSubscription = path.id
        return { data: true }
      },
      messages: async ({ path }) => ({
        data: [{
          info: { role: "assistant", tokens: TOKENS, finish: "stop" },
          parts: [{ type: "text", text: "streamed answer" }],
        }],
      }),
      list: async () => ({ data: [] }),
      delete: async ({ path }) => {
        state.deleted.push(path.id)
        return { data: true }
      },
    },
    event: {
      subscribe: async ({ signal }) => {
        // The plugin subscribes BEFORE calling promptAsync, so the session ID is
        // resolved lazily at first next() — by then promptAsync has run.
        let events = null
        let index = 0
        return {
          stream: {
            async next() {
              if (events === null) {
                const sessionID = pendingSubscription
                events = streamEvents ? streamEvents(sessionID) : []
              }
              if (index < events.length) {
                return { value: events[index++], done: false }
              }
              // Exhausted: hang until aborted (mimics a stream that never idles).
              await new Promise((_, reject) => {
                if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
                signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })
              })
            },
            async return() {
              return { done: true }
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

const deltaThenIdle = (sessionID) => ([
  {
    type: "message.part.delta",
    properties: { sessionID, field: "text", delta: "streamed" },
  },
  { type: "session.idle", properties: { sessionID } },
])

async function withServer(client, run) {
  const handler = createProxyFetchHandler(client)
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
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!outgoing.write(value)) await new Promise((resolve) => outgoing.once("drain", resolve))
      }
      outgoing.end()
    } catch {
      if (!outgoing.writableEnded) outgoing.end()
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  try {
    await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function postCompletion(port, { stream = false, timeoutMs = 1000 } = {}) {
  const controller = new AbortController()
  const promise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/first",
      messages: [{ role: "user", content: "hello" }],
      stream,
    }),
    signal: controller.signal,
  }).catch((error) => error)
  setTimeout(() => controller.abort(new Error("client gave up")), timeoutMs)
  return promise
}

test("non-streaming success deletes the throwaway session", async () => {
  const client = createMockClient({ promptMode: "resolve" })
  await withServer(client, async (port) => {
    const response = await postCompletion(port, { timeoutMs: 5000 })
    assert.equal(response.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(client.state.created.length, 1)
    assert.deepEqual(client.state.deleted, client.state.created)
  })
})

test("non-streaming client abort does NOT delete the session (FOREIGN KEY race)", async () => {
  const client = createMockClient({ promptMode: "hang" })
  await withServer(client, async (port) => {
    await postCompletion(port, { timeoutMs: 150 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(client.state.created.length, 1)
    assert.deepEqual(client.state.deleted, [], "aborted session must leak, not delete")
  })
})

test("keepSessions=true never deletes, even on success", async () => {
  const client = createMockClient({ promptMode: "resolve" })
  process.env.OPENCODE_LLM_PROXY_KEEP_SESSIONS = "true"
  try {
    await withServer(client, async (port) => {
      const response = await postCompletion(port, { timeoutMs: 5000 })
      assert.equal(response.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(client.state.created.length, 1)
      assert.deepEqual(client.state.deleted, [])
    })
  } finally {
    delete process.env.OPENCODE_LLM_PROXY_KEEP_SESSIONS
  }
})

const DAY = 24 * 60 * 60 * 1000

test("sweep reaps only stale Proxy: sessions", async () => {
  const staleProxy = { id: "stale-proxy", title: "Proxy: openai/first", time_updated: Date.now() - 2 * DAY }
  const freshProxy = { id: "fresh-proxy", title: "Proxy: openai/first", time_updated: Date.now() - 1000 }
  const staleOther = { id: "stale-other", title: "My chat", time_updated: Date.now() - 2 * DAY }
  const unknownAge = { id: "unknown-age", title: "Proxy: openai/first" }
  const deleted = []
  const client = {
    app: { log: async () => {} },
    session: {
      list: async () => ({ data: [staleProxy, freshProxy, staleOther, unknownAge] }),
      delete: async ({ path }) => { deleted.push(path.id); return { data: true } },
    },
  }
  await sweepStaleProxySessions(client)
  assert.deepEqual(deleted, ["stale-proxy"], "only the stale Proxy: session is reaped")
})

test("sweep is a no-op when session.list is unavailable or fails", async () => {
  const noList = { app: { log: async () => {} }, session: {} }
  await sweepStaleProxySessions(noList) // must not throw
  let listed = false
  const failing = {
    app: { log: async () => {} },
    session: {
      list: async () => { listed = true; throw new Error("boom") },
      delete: async () => { throw new Error("must not be called") },
    },
  }
  await sweepStaleProxySessions(failing) // must not throw
  assert.ok(listed)
})

test("sweep keeps going when an individual delete fails", async () => {
  const DAY = 24 * 60 * 60 * 1000
  const deleted = []
  const client = {
    app: { log: async () => {} },
    session: {
      list: async () => ({
        data: [
          { id: "stale-1", title: "Proxy: openai/first", time_updated: Date.now() - 2 * DAY },
          { id: "stale-2", title: "Proxy: openai/first", time_updated: Date.now() - 2 * DAY },
        ],
      }),
      delete: async ({ path }) => {
        if (path.id === "stale-1") throw new Error("delete failed")
        deleted.push(path.id)
        return { data: true }
      },
    },
  }
  await sweepStaleProxySessions(client)
  assert.deepEqual(deleted, ["stale-2"], "one failing delete must not stop the sweep")
})

test("sweep ignores seconds-epoch timestamps (units mismatch fails safe)", async () => {
  const DAY = 24 * 60 * 60 * 1000
  const deleted = []
  const client = {
    app: { log: async () => {} },
    session: {
      list: async () => ({
        data: [
          // seconds-epoch "2 days ago" — magnitude says seconds, not ms: keep.
          { id: "seconds-epoch", title: "Proxy: openai/first", time_updated: Math.floor((Date.now() - 2 * DAY) / 1000) },
        ],
      }),
      delete: async ({ path }) => { deleted.push(path.id); return { data: true } },
    },
  }
  await sweepStaleProxySessions(client)
  assert.deepEqual(deleted, [], "seconds-epoch timestamps must not classify as stale ms-epoch")
})

test("streaming success still deletes the throwaway session", async () => {
  const client = createMockClient({ streamEvents: deltaThenIdle })
  await withServer(client, async (port) => {
    const response = await postCompletion(port, { stream: true, timeoutMs: 5000 })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(client.state.created.length, 1)
    assert.deepEqual(client.state.deleted, client.state.created)
  })
})

test("streaming client abort does NOT delete the session (FOREIGN KEY race)", async () => {
  const client = createMockClient({ streamEvents: () => [
    { type: "message.part.delta", properties: { sessionID: null, field: "text", delta: "partial" } },
  ] })
  await withServer(client, async (port) => {
    await postCompletion(port, { stream: true, timeoutMs: 150 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(client.state.created.length, 1)
    assert.deepEqual(client.state.deleted, [], "aborted stream session must leak, not delete")
  })
})

test("streaming session.error does NOT delete the session", async () => {
  const client = createMockClient({ streamEvents: (sessionID) => [
    { type: "session.error", properties: { sessionID, error: { message: "model exploded" } } },
  ] })
  await withServer(client, async (port) => {
    const response = await postCompletion(port, { stream: true, timeoutMs: 5000 }).catch((e) => e)
    // The proxy surfaces the error (HTTP 500 or a stream error event); either way
    // the session must NOT be deleted.
    assert.ok(response instanceof Error || response.status >= 400 || response.status === 200)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(client.state.created.length, 1)
    assert.deepEqual(client.state.deleted, [], "errored stream session must leak, not delete")
  })
})

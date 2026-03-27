import test from "node:test"
import assert from "node:assert/strict"

import { createProxyFetchHandler } from "./index.js"

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

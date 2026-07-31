import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import {
  MediaError,
  addressInPrefix,
  isPublicIPAddress,
  parseIPAddress,
  prepareMedia,
  resolvePublicHost,
  validateRemoteUrl,
} from "./remote-media.js"

const PUBLIC_V4 = "93.184.216.34"

function fakeRequest(responses, requests = []) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      requests.push({ url: url.href, options })
      const spec = responses.shift()
      if (spec?.error) {
        process.nextTick(() => request.emit("error", spec.error))
        return
      }
      if (spec?.hang) return
      const response = new PassThrough()
      response.statusCode = spec.status ?? 200
      response.headers = spec.headers ?? { "content-type": "image/png" }
      response.socket = { remoteAddress: spec.remoteAddress ?? PUBLIC_V4 }
      process.nextTick(() => {
        callback(response)
        if (spec.body !== undefined) response.end(spec.body)
      })
    }
    request.destroy = (error) => process.nextTick(() => request.emit("error", error))
    return request
  }
}

function config(responses, overrides = {}) {
  return {
    enabled: true,
    allowedSchemes: ["https", "http"],
    dependencies: {
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      httpRequest: fakeRequest(responses),
      httpsRequest: fakeRequest(responses),
    },
    ...overrides,
  }
}

test("parses addresses and checks arbitrary prefixes", () => {
  assert.equal(parseIPAddress("192.0.2.1").family, 4)
  assert.equal(parseIPAddress("2001:db8::1").bytes.length, 16)
  assert.equal(parseIPAddress("not-an-ip"), null)
  assert.equal(addressInPrefix("10.2.3.4", "10.0.0.0/8"), true)
  assert.equal(addressInPrefix("11.2.3.4", "10.0.0.0/8"), false)
  assert.equal(addressInPrefix("2001:db8:1::1", "2001:db8::/32"), true)
})

test("rejects non-public IPv4 ranges", () => {
  for (const address of [
    "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.31.0.1",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255",
  ]) assert.equal(isPublicIPAddress(address), false, address)
  assert.equal(isPublicIPAddress("8.8.8.8"), true)
})

test("rejects non-public, transition, and embedded IPv6 ranges", () => {
  for (const address of [
    "::", "::1", "::ffff:127.0.0.1", "64:ff9b::0808:0808", "64:ff9b:1::1", "100::1",
    "2001::1", "2001:2::1", "2001:db8::1", "2002:0808:0808::1", "3fff::1",
    "fc00::1", "fd12::1", "fe80::1", "ff02::1",
  ]) assert.equal(isPublicIPAddress(address), false, address)
  assert.equal(isPublicIPAddress("2606:4700:4700::1111"), true)
  assert.equal(isPublicIPAddress("::ffff:8.8.8.8"), true)
})

test("URL validation defaults to HTTPS and rejects credentials", () => {
  assert.equal(validateRemoteUrl("https://example.com/a").hostname, "example.com")
  assert.throws(() => validateRemoteUrl("http://example.com/a"), { code: "invalid_media_url" })
  assert.throws(() => validateRemoteUrl("https://user:secret@example.com/a"), { code: "invalid_media_url" })
  assert.equal(validateRemoteUrl("http://example.com", { allowedSchemes: ["http"] }).protocol, "http:")
  assert.throws(() => validateRemoteUrl("ftp://example.com", { allowedSchemes: ["ftp"] }), { code: "invalid_config" })
})

test("all DNS answers must be public", async () => {
  await assert.rejects(
    resolvePublicHost("example.test", async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    { code: "blocked_media_host" },
  )
  assert.deepEqual(await resolvePublicHost("8.8.8.8"), [{ address: "8.8.8.8", family: 4 }])
})

test("data URLs pass through without enabling remote access", async () => {
  const item = { type: "file", mime: "image/png", url: "data:image/png;base64,aGk=", filename: "x.png" }
  const result = await prepareMedia([item], {})
  assert.deepEqual(result, [item])
  assert.equal(result[0], item)
})

test("remote media is opt-in and item count is bounded", async () => {
  await assert.rejects(prepareMedia([{ url: "https://example.com/x" }], {}), { status: 400, code: "remote_media_disabled" })
  await assert.rejects(prepareMedia(
    [{ url: "https://one.example/x" }, { url: "https://two.example/x" }],
    { enabled: true, maxItems: 1 },
  ), { code: "too_many_media_items" })
  assert.equal((await prepareMedia([{ url: "data:,a" }, { url: "data:,b" }], { maxItems: 1 })).length, 2)
  await assert.rejects(
    prepareMedia([{ url: "data:,a" }, { url: "data:,b" }], { maxTotalItems: 1 }),
    { code: "too_many_media_items" },
  )
})

test("downloads sequentially, pins lookup, and converts to data URLs", async () => {
  let active = 0
  let maximum = 0
  const seenLookups = []
  const request = (url, options, callback) => {
    const req = new EventEmitter()
    req.end = () => {
      active += 1
      maximum = Math.max(maximum, active)
      options.lookup("example.test", {}, (error, address, family) => seenLookups.push({ error, address, family }))
      const response = new PassThrough()
      response.statusCode = 200
      response.headers = { "content-type": "image/png; charset=binary", "content-encoding": "identity" }
      response.socket = { remoteAddress: PUBLIC_V4 }
      setTimeout(() => {
        callback(response)
        response.end("hello", () => { active -= 1 })
      }, 5)
    }
    req.destroy = (error) => req.emit("error", error)
    return req
  }
  const metrics = {}
  const result = await prepareMedia(
    [{ url: "https://one.example/a", filename: "a" }, { url: "https://two.example/b" }],
    config([], { dependencies: { lookup: async () => [{ address: PUBLIC_V4, family: 4 }], httpsRequest: request } }),
    undefined,
    metrics,
  )
  assert.equal(maximum, 1)
  assert.deepEqual(seenLookups.map(({ address, family }) => [address, family]), [[PUBLIC_V4, 4], [PUBLIC_V4, 4]])
  assert.equal(result[0].url, "data:image/png;base64,aGVsbG8=")
  assert.equal(result[0].mime, "image/png")
  assert.equal(result[0].filename, "a")
  assert.equal(metrics.remoteMediaDownloads, 2)
  assert.equal(metrics.remoteMediaBytes, 10)
})

test("rejects a socket peer different from the DNS pin", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ remoteAddress: "8.8.8.8", body: "x" }])),
    { code: "blocked_media_host" },
  )
})

test("follows bounded redirects but rejects HTTPS downgrade", async () => {
  const requests = []
  const responses = [
    { status: 302, headers: { location: "/final" }, body: "" },
    { headers: { "content-type": "image/jpeg" }, body: "ok" },
  ]
  const cfg = config([], {
    dependencies: {
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      httpsRequest: fakeRequest(responses, requests),
    },
  })
  const result = await prepareMedia([{ url: "https://example.test/start" }], cfg)
  assert.equal(result[0].url, "data:image/jpeg;base64,b2s=")
  assert.deepEqual(requests.map((entry) => entry.url), ["https://example.test/start", "https://example.test/final"])

  await assert.rejects(
    prepareMedia([{ url: "https://example.test/start" }], config([
      { status: 302, headers: { location: "http://example.test/final" }, body: "" },
    ])),
    { code: "media_redirect_rejected" },
  )
})

test("enforces redirect limits", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([
      { status: 302, headers: { location: "/b" }, body: "" },
    ], { maxRedirects: 0 })),
    { code: "media_redirect_rejected" },
  )
})

test("rejects unsupported MIME and content encoding", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ headers: { "content-type": "text/html" }, body: "x" }])),
    { status: 415, code: "unsupported_media_type" },
  )
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ headers: { "content-type": "image/png", "content-encoding": "gzip" }, body: "x" }])),
    { code: "unsupported_media_encoding" },
  )
})

test("enforces declared and streamed size limits", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ headers: { "content-type": "image/png", "content-length": "9" }, body: "" }], { maxBytes: 4 })),
    { status: 413, code: "media_too_large" },
  )
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ headers: { "content-type": "image/png" }, body: "12345" }], { maxBytes: 4 })),
    { status: 413, code: "media_too_large" },
  )
})

test("applies one total timeout and propagates parent abort safely", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([{ hang: true }], { timeoutMs: 10 })),
    { status: 504, code: "media_timeout" },
  )

  const controller = new AbortController()
  controller.abort(new Error("private reason"))
  const error = await prepareMedia([{ url: "https://example.test/a" }], config([{ hang: true }]), controller.signal)
    .then(() => null, (caught) => caught)
  assert.ok(error instanceof MediaError)
  assert.equal(error.code, "media_aborted")
  assert.doesNotMatch(error.message, /private reason/)
})

test("total timeout includes DNS resolution", async () => {
  await assert.rejects(
    prepareMedia([{ url: "https://example.test/a" }], config([], {
      timeoutMs: 10,
      dependencies: { lookup: async () => new Promise(() => {}) },
    })),
    { status: 504, code: "media_timeout" },
  )
})

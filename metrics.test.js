import test, { beforeEach, describe } from "node:test"
import assert from "node:assert/strict"

import { ROUTES, createMetrics, createRegistry, getMetrics, normalizeRoute, resetMetrics } from "./metrics.js"

describe("route normalization", () => {
  test("keeps every fixed proxy endpoint", () => {
    for (const route of [ROUTES.health, ROUTES.models, ROUTES.chatCompletions, ROUTES.responses, ROUTES.messages]) {
      assert.equal(normalizeRoute(route), route)
    }
  })

  test("removes Gemini model cardinality and query strings", () => {
    assert.equal(normalizeRoute("/v1beta/models/gemini-2.5-pro:generateContent?key=secret"), ROUTES.geminiGenerate)
    assert.equal(normalizeRoute("https://localhost/v1beta/models/team%2Fmodel:streamGenerateContent"), ROUTES.geminiStreamGenerate)
    assert.equal(normalizeRoute("/v1beta/models/publisher/model:generateContent"), ROUTES.geminiGenerate)
  })

  test("maps arbitrary and malformed paths to unknown", () => {
    assert.equal(normalizeRoute("/users/customer-123"), ROUTES.unknown)
    assert.equal(normalizeRoute("http://[invalid"), ROUTES.unknown)
  })
})

describe("registry", () => {
  test("serializes counters, gauges, and cumulative histogram buckets deterministically", () => {
    const registry = createRegistry()
    const histogram = registry.histogram({ name: "z_duration_seconds", help: "A duration.", labelNames: ["kind"], buckets: [5, 1, 2, 2] })
    const counter = registry.counter("a_total", "A counter.", ["result"])
    const gauge = registry.gauge("m_active", "An active gauge.")

    histogram.observe({ kind: "read" }, 1.5)
    histogram.observe({ kind: "read" }, 5)
    counter.inc({ result: "ok" }, 2)
    gauge.set(3)

    assert.equal(registry.metrics(), `# HELP a_total A counter.
# TYPE a_total counter
a_total{result="ok"} 2
# HELP m_active An active gauge.
# TYPE m_active gauge
m_active 3
# HELP z_duration_seconds A duration.
# TYPE z_duration_seconds histogram
z_duration_seconds_bucket{kind="read",le="1"} 0
z_duration_seconds_bucket{kind="read",le="2"} 1
z_duration_seconds_bucket{kind="read",le="5"} 2
z_duration_seconds_bucket{kind="read",le="+Inf"} 2
z_duration_seconds_sum{kind="read"} 6.5
z_duration_seconds_count{kind="read"} 2
`)
  })

  test("escapes HELP and label text", () => {
    const registry = createRegistry()
    const counter = registry.counter({ name: "escaped_total", help: "line\\one\ntwo", labelNames: ["value"] })
    counter.inc({ value: 'quote" slash\\ newline\n' })
    assert.match(registry.metrics(), /# HELP escaped_total line\\\\one\\ntwo/)
    assert.match(registry.metrics(), /value="quote\\" slash\\\\ newline\\n"/)
    assert.ok(registry.metrics().endsWith("\n"))
  })

  test("sorts labeled samples independently of recording order", () => {
    const registry = createRegistry()
    const counter = registry.counter("ordered_total", "Ordered.", ["result"])
    counter.inc({ result: "z" })
    counter.inc({ result: "a" })
    const output = registry.metrics()
    assert.ok(output.indexOf('result="a"') < output.indexOf('result="z"'))
  })

  test("resets samples while preserving definitions and zero-value unlabeled metrics", () => {
    const registry = createRegistry()
    const counter = registry.counter("events_total", "Events.", ["kind"])
    registry.gauge("active", "Active.").set(4)
    counter.inc({ kind: "temporary" })
    registry.reset()
    assert.doesNotMatch(registry.metrics(), /temporary/)
    assert.match(registry.metrics(), /active 0\n/)
  })

  test("rejects invalid definitions and observations", () => {
    const registry = createRegistry()
    assert.throws(() => registry.counter("bad-name", "Bad."), /Invalid metric name/)
    assert.throws(() => registry.counter("valid", "Valid.", ["le"]), /Invalid metric label/)
    const counter = registry.counter("count_total", "Count.")
    assert.throws(() => counter.inc(-1), /non-negative/)
    const histogram = registry.histogram({ name: "duration", help: "Duration.", buckets: [1] })
    assert.throws(() => histogram.observe(Infinity), /finite/)
  })
})

describe("proxy metrics", () => {
  let metrics

  beforeEach(() => {
    metrics = createMetrics()
  })

  test("records HTTP status and duration using bounded labels", () => {
    metrics.recordHttpCompletion({ method: "post", pathname: "/v1/chat/completions?trace=user-id", status: 200, durationMs: 250 })
    metrics.recordHttpCompletion({ method: "TRACE", route: "/private/abc", status: 999, durationSeconds: 1 })
    const output = metrics.metrics()
    assert.match(output, /opencode_proxy_http_requests_total\{method="POST",route="\/v1\/chat\/completions",status="200"\} 1/)
    assert.match(output, /opencode_proxy_http_request_duration_seconds_sum\{method="POST",route="\/v1\/chat\/completions",status="200"\} 0\.25/)
    assert.match(output, /method="OTHER",route="unknown",status="unknown"/)
    assert.doesNotMatch(output, /trace|user-id|private|abc/)
  })

  test("tracks active and queued requests", () => {
    metrics.incActiveRequests(2)
    metrics.decActiveRequests()
    metrics.setQueuedRequests(3)
    metrics.decQueuedRequests(2)
    const output = metrics.serialize()
    assert.match(output, /opencode_proxy_active_requests 1\n/)
    assert.match(output, /opencode_proxy_queued_requests 1\n/)
  })

  test("records bounded upstream outcomes and token directions", () => {
    metrics.recordUpstreamAttempt("success")
    metrics.recordUpstreamAttempt("provider-user-123")
    metrics.recordTokens({ input: 12, output: 5 })
    const output = metrics.metrics()
    assert.match(output, /opencode_proxy_upstream_attempts_total\{outcome="success"\} 1/)
    assert.match(output, /opencode_proxy_upstream_attempts_total\{outcome="other"\} 1/)
    assert.match(output, /opencode_proxy_tokens_total\{direction="input"\} 12/)
    assert.match(output, /opencode_proxy_tokens_total\{direction="output"\} 5/)
    assert.doesNotMatch(output, /provider-user-123/)
  })

  test("records remote-media completion, bytes, redirects, duration, and in-flight state", () => {
    const finish = metrics.startRemoteMedia()
    assert.match(metrics.metrics(), /opencode_proxy_remote_media_in_flight 1\n/)
    finish({ outcome: "success", bytes: 2048, redirects: 2, durationMs: 125 })
    finish({ outcome: "error", bytes: 10, durationMs: 10 })
    const output = metrics.metrics()
    assert.match(output, /opencode_proxy_remote_media_in_flight 0\n/)
    assert.match(output, /opencode_proxy_remote_media_requests_total\{outcome="success"\} 1/)
    assert.match(output, /opencode_proxy_remote_media_bytes_total 2048/)
    assert.match(output, /opencode_proxy_remote_media_redirects_total 2/)
    assert.match(output, /opencode_proxy_remote_media_duration_seconds_sum\{outcome="success"\} 0\.125/)
  })

  test("rejects negative domain values", () => {
    assert.throws(() => metrics.setActiveRequests(-1), /non-negative/)
    assert.throws(() => metrics.recordTokens({ input: -1 }), /non-negative/)
    assert.throws(() => metrics.recordRemoteMedia({ outcome: "success", bytes: -1, durationMs: 1 }), /non-negative/)
  })

  test("create and reset APIs isolate state", () => {
    const first = resetMetrics()
    first.recordUpstreamAttempt("success")
    const second = resetMetrics()
    assert.notEqual(first, second)
    assert.equal(getMetrics(), second)
    assert.doesNotMatch(second.metrics(), /outcome="success"/)
    assert.match(first.metrics(), /outcome="success"/)
  })
})

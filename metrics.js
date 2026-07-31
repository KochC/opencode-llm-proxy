const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

export const ROUTES = Object.freeze({
  health: "/health",
  metrics: "/metrics",
  models: "/v1/models",
  chatCompletions: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  geminiGenerate: "/v1beta/models/:model:generateContent",
  geminiStreamGenerate: "/v1beta/models/:model:streamGenerateContent",
  unknown: "unknown",
})

const FIXED_ROUTES = new Set(Object.values(ROUTES))
const METHODS = new Set(["GET", "POST", "OPTIONS", "HEAD", "PUT", "PATCH", "DELETE"])
const UPSTREAM_OUTCOMES = new Set(["success", "error", "timeout", "cancelled"])
const MEDIA_OUTCOMES = new Set(["success", "error", "timeout", "cancelled", "rejected"])

function escapeHelp(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')
}

function number(value) {
  if (value === Infinity) return "+Inf"
  if (value === -Infinity) return "-Inf"
  if (Number.isNaN(value)) return "NaN"
  return String(value)
}

function assertMetricName(name) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new TypeError(`Invalid metric name: ${name}`)
}

function assertLabelNames(labelNames) {
  const unique = new Set(labelNames)
  if (unique.size !== labelNames.length) throw new TypeError("Metric label names must be unique")
  for (const name of labelNames) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name === "le") {
      throw new TypeError(`Invalid metric label name: ${name}`)
    }
  }
}

function normalizeDefinition(nameOrOptions, help, labelNames = [], extra = {}) {
  if (typeof nameOrOptions === "object" && nameOrOptions !== null) return nameOrOptions
  return { name: nameOrOptions, help, labelNames, ...extra }
}

function labelsKey(labelNames, labels) {
  const values = labelNames.map((name) => {
    if (!(name in labels)) throw new TypeError(`Missing metric label: ${name}`)
    return String(labels[name])
  })
  return JSON.stringify(values)
}

function formatLabels(labelNames, values, additional) {
  const pairs = labelNames.map((name, index) => `${name}="${escapeLabel(values[index])}"`)
  if (additional) pairs.push(`${additional.name}="${escapeLabel(additional.value)}"`)
  return pairs.length ? `{${pairs.join(",")}}` : ""
}

class Metric {
  constructor(registry, options, type) {
    const { name, help, labelNames = [] } = options
    assertMetricName(name)
    assertLabelNames(labelNames)
    if (!help) throw new TypeError(`Metric ${name} requires help text`)
    this.name = name
    this.help = String(help)
    this.labelNames = [...labelNames]
    this.type = type
    this.values = new Map()
    registry._register(this)
  }

  _entry(labels = {}, create) {
    const key = labelsKey(this.labelNames, labels)
    let entry = this.values.get(key)
    if (!entry && create) {
      entry = create(this.labelNames.map((name) => String(labels[name])))
      this.values.set(key, entry)
    }
    return entry
  }

  reset() {
    this.values.clear()
    if (this.labelNames.length === 0) this._initialize()
  }

  _entries() {
    return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
  }
}

class Counter extends Metric {
  constructor(registry, options) {
    super(registry, options, "counter")
    this._initialize()
  }

  _initialize() {
    if (this.labelNames.length === 0) this._entry({}, (labels) => ({ labels, value: 0 }))
  }

  inc(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}]
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError("Counter increments must be finite and non-negative")
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value += amount
  }

  _serialize() {
    return this._entries().map((entry) =>
      `${this.name}${formatLabels(this.labelNames, entry.labels)} ${number(entry.value)}`)
  }
}

class Gauge extends Metric {
  constructor(registry, options) {
    super(registry, options, "gauge")
    this._initialize()
  }

  _initialize() {
    if (this.labelNames.length === 0) this._entry({}, (labels) => ({ labels, value: 0 }))
  }

  set(labels = {}, value) {
    if (typeof labels === "number") [value, labels] = [labels, {}]
    if (!Number.isFinite(value)) throw new RangeError("Gauge values must be finite")
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value = value
  }

  inc(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}]
    if (!Number.isFinite(amount)) throw new RangeError("Gauge increments must be finite")
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value += amount
  }

  dec(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}]
    this.inc(labels, -amount)
  }

  _serialize() {
    return this._entries().map((entry) =>
      `${this.name}${formatLabels(this.labelNames, entry.labels)} ${number(entry.value)}`)
  }
}

class Histogram extends Metric {
  constructor(registry, options) {
    super(registry, options, "histogram")
    const buckets = options.buckets ?? DEFAULT_DURATION_BUCKETS
    if (!Array.isArray(buckets) || buckets.length === 0 || buckets.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Histogram buckets must be a non-empty array of finite numbers")
    }
    this.buckets = [...new Set(buckets)].sort((a, b) => a - b)
    this._initialize()
  }

  _initialize() {
    if (this.labelNames.length === 0) {
      this._entry({}, (labels) => ({ labels, count: 0, sum: 0, buckets: this.buckets.map(() => 0) }))
    }
  }

  observe(labels = {}, value) {
    if (typeof labels === "number") [value, labels] = [labels, {}]
    if (!Number.isFinite(value)) throw new RangeError("Histogram observations must be finite")
    const entry = this._entry(labels, (values) => ({
      labels: values,
      count: 0,
      sum: 0,
      buckets: this.buckets.map(() => 0),
    }))
    entry.count++
    entry.sum += value
    this.buckets.forEach((upperBound, index) => {
      if (value <= upperBound) entry.buckets[index]++
    })
  }

  _serialize() {
    const lines = []
    for (const entry of this._entries()) {
      this.buckets.forEach((upperBound, index) => {
        lines.push(`${this.name}_bucket${formatLabels(this.labelNames, entry.labels, { name: "le", value: number(upperBound) })} ${entry.buckets[index]}`)
      })
      lines.push(`${this.name}_bucket${formatLabels(this.labelNames, entry.labels, { name: "le", value: "+Inf" })} ${entry.count}`)
      lines.push(`${this.name}_sum${formatLabels(this.labelNames, entry.labels)} ${number(entry.sum)}`)
      lines.push(`${this.name}_count${formatLabels(this.labelNames, entry.labels)} ${entry.count}`)
    }
    return lines
  }
}

export function createRegistry() {
  const metrics = new Map()
  return {
    _register(metric) {
      if (metrics.has(metric.name)) throw new Error(`Metric already registered: ${metric.name}`)
      metrics.set(metric.name, metric)
    },
    counter(nameOrOptions, help, labelNames) {
      return new Counter(this, normalizeDefinition(nameOrOptions, help, labelNames))
    },
    gauge(nameOrOptions, help, labelNames) {
      return new Gauge(this, normalizeDefinition(nameOrOptions, help, labelNames))
    },
    histogram(nameOrOptions, help, labelNames, buckets) {
      return new Histogram(this, normalizeDefinition(nameOrOptions, help, labelNames, { buckets }))
    },
    reset() {
      for (const metric of metrics.values()) metric.reset()
    },
    metrics() {
      const lines = []
      for (const metric of [...metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`)
        lines.push(`# TYPE ${metric.name} ${metric.type}`)
        lines.push(...metric._serialize())
      }
      return `${lines.join("\n")}\n`
    },
  }
}

export function normalizeRoute(pathOrUrl) {
  let pathname = String(pathOrUrl ?? "")
  try {
    pathname = new URL(pathname, "http://metrics.invalid").pathname
  } catch {
    return ROUTES.unknown
  }
  if (FIXED_ROUTES.has(pathname) && pathname !== ROUTES.unknown) return pathname
  if (/^\/v1beta\/models\/.+:generateContent$/.test(pathname)) return ROUTES.geminiGenerate
  if (/^\/v1beta\/models\/.+:streamGenerateContent$/.test(pathname)) return ROUTES.geminiStreamGenerate
  return ROUTES.unknown
}

function bounded(value, allowed) {
  const normalized = String(value ?? "").toLowerCase()
  return allowed.has(normalized) ? normalized : "other"
}

function nonNegative(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and non-negative`)
  return value
}

export function createMetrics() {
  const registry = createRegistry()
  const httpRequests = registry.counter({ name: "opencode_proxy_http_requests_total", help: "Completed HTTP requests.", labelNames: ["method", "route", "status"] })
  const httpDuration = registry.histogram({ name: "opencode_proxy_http_request_duration_seconds", help: "HTTP request completion duration in seconds.", labelNames: ["method", "route", "status"] })
  const activeRequests = registry.gauge({ name: "opencode_proxy_active_requests", help: "Requests currently being processed." })
  const queuedRequests = registry.gauge({ name: "opencode_proxy_queued_requests", help: "Requests waiting for a processing slot." })
  const upstreamAttempts = registry.counter({ name: "opencode_proxy_upstream_attempts_total", help: "Upstream request attempts by outcome.", labelNames: ["outcome"] })
  const tokens = registry.counter({ name: "opencode_proxy_tokens_total", help: "Model tokens processed by direction.", labelNames: ["direction"] })
  const mediaRequests = registry.counter({ name: "opencode_proxy_remote_media_requests_total", help: "Remote media fetches by outcome.", labelNames: ["outcome"] })
  const mediaBytes = registry.counter({ name: "opencode_proxy_remote_media_bytes_total", help: "Bytes received from successful remote media fetches." })
  const mediaRedirects = registry.counter({ name: "opencode_proxy_remote_media_redirects_total", help: "Redirects followed while fetching remote media." })
  const mediaInFlight = registry.gauge({ name: "opencode_proxy_remote_media_in_flight", help: "Remote media fetches currently in flight." })
  const mediaDuration = registry.histogram({ name: "opencode_proxy_remote_media_duration_seconds", help: "Remote media fetch duration in seconds.", labelNames: ["outcome"] })

  function httpLabels({ method, route, pathname, status }) {
    const normalizedMethod = String(method ?? "").toUpperCase()
    const numericStatus = Number(status)
    return {
      method: METHODS.has(normalizedMethod) ? normalizedMethod : "OTHER",
      route: normalizeRoute(route ?? pathname),
      status: Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599 ? String(numericStatus) : "unknown",
    }
  }

  return {
    registry,
    metrics: () => registry.metrics(),
    serialize: () => registry.metrics(),
    reset: () => registry.reset(),
    recordHttpCompletion(details) {
      const labels = httpLabels(details)
      const duration = details.durationSeconds ?? (details.durationMs === undefined ? undefined : details.durationMs / 1000)
      nonNegative(duration, "duration")
      httpRequests.inc(labels)
      httpDuration.observe(labels, duration)
    },
    incActiveRequests(amount = 1) { activeRequests.inc(nonNegative(amount, "amount")) },
    decActiveRequests(amount = 1) { activeRequests.dec(nonNegative(amount, "amount")) },
    setActiveRequests(value) { activeRequests.set(nonNegative(value, "active requests")) },
    incQueuedRequests(amount = 1) { queuedRequests.inc(nonNegative(amount, "amount")) },
    decQueuedRequests(amount = 1) { queuedRequests.dec(nonNegative(amount, "amount")) },
    setQueuedRequests(value) { queuedRequests.set(nonNegative(value, "queued requests")) },
    recordUpstreamAttempt(outcome) { upstreamAttempts.inc({ outcome: bounded(outcome, UPSTREAM_OUTCOMES) }) },
    recordTokens({ input = 0, output = 0 }) {
      tokens.inc({ direction: "input" }, nonNegative(input, "input tokens"))
      tokens.inc({ direction: "output" }, nonNegative(output, "output tokens"))
    },
    startRemoteMedia() {
      mediaInFlight.inc()
      let finished = false
      return ({ outcome, bytes = 0, redirects = 0, durationSeconds, durationMs } = {}) => {
        if (finished) return
        finished = true
        mediaInFlight.dec()
        this.recordRemoteMedia({ outcome, bytes, redirects, durationSeconds, durationMs })
      }
    },
    recordRemoteMedia({ outcome, bytes = 0, redirects = 0, durationSeconds, durationMs }) {
      const normalizedOutcome = bounded(outcome, MEDIA_OUTCOMES)
      const duration = durationSeconds ?? (durationMs === undefined ? undefined : durationMs / 1000)
      nonNegative(bytes, "remote media bytes")
      nonNegative(redirects, "remote media redirects")
      nonNegative(duration, "duration")
      mediaRequests.inc({ outcome: normalizedOutcome })
      mediaBytes.inc(bytes)
      mediaRedirects.inc(redirects)
      mediaDuration.observe({ outcome: normalizedOutcome }, duration)
    },
  }
}

let defaultMetrics = createMetrics()

export function getMetrics() {
  return defaultMetrics
}

export function resetMetrics() {
  defaultMetrics = createMetrics()
  return defaultMetrics
}

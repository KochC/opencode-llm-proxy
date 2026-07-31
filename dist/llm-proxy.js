// index.js
import { fileURLToPath } from "node:url";
import { Buffer as Buffer2 } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

// canonical-messages.js
function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function jsonValue(value) {
  return { type: "json", value };
}
function argumentsValue(value) {
  if (typeof value !== "string") return jsonValue(value === void 0 ? {} : value);
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return { type: "raw", value };
  }
}
function textPart(value) {
  return typeof value === "string" ? { type: "text", text: value } : null;
}
function mimeFromDataUrl(url, fallback) {
  return typeof url === "string" ? /^data:([^;,]+)/.exec(url)?.[1] ?? fallback : fallback;
}
function openAIMediaPart(part) {
  if (part?.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (url) return { type: "media", mime: mimeFromDataUrl(url, "image/*"), url };
  }
  if (part?.type === "input_image") {
    const url = part.image_url ?? part.file_data;
    if (url) return { type: "media", mime: mimeFromDataUrl(url, "image/*"), url };
  }
  if (part?.type === "input_file") {
    const url = part.file_data ?? part.file_url;
    if (url) {
      return {
        type: "media",
        mime: part.mime_type ?? mimeFromDataUrl(url, "application/octet-stream"),
        url,
        ...part.filename ? { filename: part.filename } : {}
      };
    }
  }
  return null;
}
function openAIContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    const text2 = textPart(part?.text ?? part?.input_text ?? part?.output_text);
    const media = openAIMediaPart(part);
    return text2 ? [text2] : media ? [media] : [];
  });
}
function mediaFromAnthropic(block) {
  if (!block || !["image", "document"].includes(block.type)) return null;
  const source = block.source;
  if (source?.type === "base64" && source.media_type && source.data) {
    return {
      type: "media",
      mime: source.media_type,
      url: `data:${source.media_type};base64,${source.data}`,
      ...block.title ? { filename: block.title } : {}
    };
  }
  if (source?.type === "url" && source.url) {
    return {
      type: "media",
      mime: block.type === "image" ? "image/*" : "application/pdf",
      url: source.url,
      ...block.title ? { filename: block.title } : {}
    };
  }
  return null;
}
function anthropicResultContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content === void 0 ? [] : [jsonValue(content)];
  return content.flatMap((block) => {
    const text2 = block?.type === "text" ? textPart(block.text) : null;
    const media = mediaFromAnthropic(block);
    return text2 ? [text2] : media ? [media] : [];
  });
}
function geminiMediaPart(part) {
  const inline = part?.inlineData ?? part?.inline_data;
  const file = part?.fileData ?? part?.file_data;
  const inlineMime = inline?.mimeType ?? inline?.mime_type;
  const fileMime = file?.mimeType ?? file?.mime_type;
  const fileUri = file?.fileUri ?? file?.file_uri;
  if (inlineMime && inline?.data) {
    return { type: "media", mime: inlineMime, url: `data:${inlineMime};base64,${inline.data}` };
  }
  if (fileMime && fileUri) return { type: "media", mime: fileMime, url: fileUri };
  return null;
}
function canonical(messages) {
  return { messages };
}
function adaptOpenAIChat(input) {
  const messages = Array.isArray(input) ? input : input?.messages;
  if (!Array.isArray(messages)) return canonical([]);
  return canonical(messages.flatMap((message) => {
    if (!isObject(message) || typeof message.role !== "string") return [];
    const content = openAIContent(message.content);
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function ?? call;
        content.push({
          type: "tool_call",
          ...call?.id ? { id: call.id } : {},
          name: fn?.name ?? "",
          arguments: argumentsValue(fn?.arguments ?? "")
        });
      }
      if (message.function_call) {
        content.push({
          type: "tool_call",
          name: message.function_call.name ?? "",
          arguments: argumentsValue(message.function_call.arguments ?? "")
        });
      }
    }
    if (message.role === "tool" || message.role === "function") {
      return [{
        role: "tool",
        content: [{
          type: "tool_result",
          ...message.tool_call_id ? { id: message.tool_call_id } : {},
          ...message.name ? { name: message.name } : {},
          content
        }]
      }];
    }
    return [{ role: message.role, content }];
  }));
}
function adaptOpenAIResponses(input) {
  const body = isObject(input) && Object.hasOwn(input, "input") ? input : { input };
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  const messages = [];
  if (typeof body.instructions === "string") {
    messages.push({ role: "system", content: [{ type: "text", text: body.instructions }] });
  }
  if (!Array.isArray(items)) return canonical(messages);
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.type === "function_call") {
      messages.push({ role: "assistant", content: [{
        type: "tool_call",
        ...item.call_id ? { id: item.call_id } : item.id ? { id: item.id } : {},
        name: item.name ?? "",
        arguments: argumentsValue(item.arguments ?? "")
      }] });
    } else if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? [{ type: "text", text: item.output }] : [jsonValue(item.output)];
      messages.push({ role: "tool", content: [{
        type: "tool_result",
        ...item.call_id ? { id: item.call_id } : {},
        content: output
      }] });
    } else {
      messages.push({ role: item.role ?? (item.type === "message" ? "user" : item.type ?? "user"), content: openAIContent(item.content ?? item.input) });
    }
  }
  return canonical(messages);
}
function adaptAnthropic(input, system) {
  const body = Array.isArray(input) ? { messages: input, system } : input ?? {};
  const messages = [];
  const systemContent = typeof body.system === "string" ? [{ type: "text", text: body.system }] : Array.isArray(body.system) ? body.system.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : []) : [];
  if (systemContent.length) messages.push({ role: "system", content: systemContent });
  for (const message of body.messages ?? []) {
    if (!isObject(message) || typeof message.role !== "string") continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const content = [];
    for (const block of blocks ?? []) {
      if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
      const media = mediaFromAnthropic(block);
      if (media) content.push(media);
      if (block?.type === "tool_use") {
        content.push({
          type: "tool_call",
          ...block.id ? { id: block.id } : {},
          name: block.name ?? "",
          arguments: jsonValue(block.input)
        });
      }
      if (block?.type === "tool_result") {
        content.push({
          type: "tool_result",
          ...block.tool_use_id ? { id: block.tool_use_id } : {},
          ...block.is_error === true ? { error: true } : {},
          content: anthropicResultContent(block.content)
        });
      }
    }
    const role = content.length > 0 && content.every((part) => part.type === "tool_result") ? "tool" : message.role;
    messages.push({ role, content });
  }
  return canonical(messages);
}
function adaptGemini(input, systemInstruction) {
  const body = Array.isArray(input) ? { contents: input, systemInstruction } : input ?? {};
  const messages = [];
  const instruction = body.systemInstruction ?? body.system_instruction;
  if (typeof instruction === "string") {
    messages.push({ role: "system", content: [{ type: "text", text: instruction }] });
  } else if (Array.isArray(instruction?.parts)) {
    messages.push({
      role: "system",
      content: instruction.parts.flatMap((part) => typeof part?.text === "string" ? [{ type: "text", text: part.text }] : [])
    });
  }
  for (const item of body.contents ?? []) {
    if (!isObject(item)) continue;
    const content = [];
    for (const part of item.parts ?? []) {
      if (typeof part?.text === "string") content.push({ type: "text", text: part.text });
      const media = geminiMediaPart(part);
      if (media) content.push(media);
      const call = part?.functionCall ?? part?.function_call;
      if (call) {
        content.push({
          type: "tool_call",
          ...call.id ? { id: call.id } : {},
          name: call.name ?? "",
          arguments: jsonValue(call.args)
        });
      }
      const response = part?.functionResponse ?? part?.function_response;
      if (response) {
        content.push({
          type: "tool_result",
          ...response.id ? { id: response.id } : {},
          ...response.name ? { name: response.name } : {},
          content: typeof response.response === "string" ? [{ type: "text", text: response.response }] : [jsonValue(response.response)]
        });
      }
    }
    const role = content.length > 0 && content.every((part) => part.type === "tool_result") ? "tool" : item.role === "model" ? "assistant" : item.role ?? "user";
    messages.push({ role, content });
  }
  return canonical(messages);
}
function renderPart(part, media) {
  if (part.type === "media") {
    const fileIndex = media.length;
    media.push({
      fileIndex,
      mime: part.mime,
      url: part.url,
      ...part.filename ? { filename: part.filename } : {}
    });
    return { type: "file", fileIndex };
  }
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "json") return { type: "json", value: part.value };
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      ...part.id ? { id: part.id } : {},
      name: part.name,
      arguments: part.arguments
    };
  }
  if (part.type === "tool_result") {
    return {
      type: "tool_result",
      ...part.id ? { id: part.id } : {},
      ...part.name ? { name: part.name } : {},
      ...part.error ? { error: true } : {},
      content: part.content.map((inner) => renderPart(inner, media))
    };
  }
  return part;
}
function renderOpenCodePrompt(value) {
  const messages = Array.isArray(value) ? value : value?.messages ?? [];
  const systemMessages = messages.filter((message) => message.role === "system" || message.role === "developer");
  const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer");
  const system = systemMessages.flatMap((message) => message.content).filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
  const media = [];
  if (conversation.length === 1 && conversation[0].role === "user" && conversation[0].content.length === 1 && conversation[0].content[0].type === "text") {
    return { system, text: conversation[0].content[0].text, media };
  }
  const transcript = conversation.map((message) => JSON.stringify({
    role: message.role,
    content: message.content.map((part) => renderPart(part, media))
  })).join("\n");
  const text2 = [
    "Continue the canonical conversation below as the assistant. Treat each following line as JSON data, preserve role and tool semantics, and produce the next assistant response after the final item.",
    transcript
  ].join("\n\n");
  return { system, text: text2, media };
}

// metrics.js
var DEFAULT_DURATION_BUCKETS = [5e-3, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
var ROUTES = Object.freeze({
  health: "/health",
  metrics: "/metrics",
  models: "/v1/models",
  chatCompletions: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  geminiGenerate: "/v1beta/models/:model:generateContent",
  geminiStreamGenerate: "/v1beta/models/:model:streamGenerateContent",
  unknown: "unknown"
});
var FIXED_ROUTES = new Set(Object.values(ROUTES));
var METHODS = /* @__PURE__ */ new Set(["GET", "POST", "OPTIONS", "HEAD", "PUT", "PATCH", "DELETE"]);
var UPSTREAM_OUTCOMES = /* @__PURE__ */ new Set(["success", "error", "timeout", "cancelled"]);
var MEDIA_OUTCOMES = /* @__PURE__ */ new Set(["success", "error", "timeout", "cancelled", "rejected"]);
function escapeHelp(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}
function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}
function number(value) {
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  return String(value);
}
function assertMetricName(name) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new TypeError(`Invalid metric name: ${name}`);
}
function assertLabelNames(labelNames) {
  const unique = new Set(labelNames);
  if (unique.size !== labelNames.length) throw new TypeError("Metric label names must be unique");
  for (const name of labelNames) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name === "le") {
      throw new TypeError(`Invalid metric label name: ${name}`);
    }
  }
}
function normalizeDefinition(nameOrOptions, help, labelNames = [], extra = {}) {
  if (typeof nameOrOptions === "object" && nameOrOptions !== null) return nameOrOptions;
  return { name: nameOrOptions, help, labelNames, ...extra };
}
function labelsKey(labelNames, labels) {
  const values = labelNames.map((name) => {
    if (!(name in labels)) throw new TypeError(`Missing metric label: ${name}`);
    return String(labels[name]);
  });
  return JSON.stringify(values);
}
function formatLabels(labelNames, values, additional) {
  const pairs = labelNames.map((name, index) => `${name}="${escapeLabel(values[index])}"`);
  if (additional) pairs.push(`${additional.name}="${escapeLabel(additional.value)}"`);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}
var Metric = class {
  constructor(registry, options, type) {
    const { name, help, labelNames = [] } = options;
    assertMetricName(name);
    assertLabelNames(labelNames);
    if (!help) throw new TypeError(`Metric ${name} requires help text`);
    this.name = name;
    this.help = String(help);
    this.labelNames = [...labelNames];
    this.type = type;
    this.values = /* @__PURE__ */ new Map();
    registry._register(this);
  }
  _entry(labels = {}, create) {
    const key = labelsKey(this.labelNames, labels);
    let entry = this.values.get(key);
    if (!entry && create) {
      entry = create(this.labelNames.map((name) => String(labels[name])));
      this.values.set(key, entry);
    }
    return entry;
  }
  reset() {
    this.values.clear();
    if (this.labelNames.length === 0) this._initialize();
  }
  _entries() {
    return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
  }
};
var Counter = class extends Metric {
  constructor(registry, options) {
    super(registry, options, "counter");
    this._initialize();
  }
  _initialize() {
    if (this.labelNames.length === 0) this._entry({}, (labels) => ({ labels, value: 0 }));
  }
  inc(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}];
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError("Counter increments must be finite and non-negative");
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value += amount;
  }
  _serialize() {
    return this._entries().map((entry) => `${this.name}${formatLabels(this.labelNames, entry.labels)} ${number(entry.value)}`);
  }
};
var Gauge = class extends Metric {
  constructor(registry, options) {
    super(registry, options, "gauge");
    this._initialize();
  }
  _initialize() {
    if (this.labelNames.length === 0) this._entry({}, (labels) => ({ labels, value: 0 }));
  }
  set(labels = {}, value) {
    if (typeof labels === "number") [value, labels] = [labels, {}];
    if (!Number.isFinite(value)) throw new RangeError("Gauge values must be finite");
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value = value;
  }
  inc(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}];
    if (!Number.isFinite(amount)) throw new RangeError("Gauge increments must be finite");
    this._entry(labels, (values) => ({ labels: values, value: 0 })).value += amount;
  }
  dec(labels = {}, amount = 1) {
    if (typeof labels === "number") [amount, labels] = [labels, {}];
    this.inc(labels, -amount);
  }
  _serialize() {
    return this._entries().map((entry) => `${this.name}${formatLabels(this.labelNames, entry.labels)} ${number(entry.value)}`);
  }
};
var Histogram = class extends Metric {
  constructor(registry, options) {
    super(registry, options, "histogram");
    const buckets = options.buckets ?? DEFAULT_DURATION_BUCKETS;
    if (!Array.isArray(buckets) || buckets.length === 0 || buckets.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Histogram buckets must be a non-empty array of finite numbers");
    }
    this.buckets = [...new Set(buckets)].sort((a, b) => a - b);
    this._initialize();
  }
  _initialize() {
    if (this.labelNames.length === 0) {
      this._entry({}, (labels) => ({ labels, count: 0, sum: 0, buckets: this.buckets.map(() => 0) }));
    }
  }
  observe(labels = {}, value) {
    if (typeof labels === "number") [value, labels] = [labels, {}];
    if (!Number.isFinite(value)) throw new RangeError("Histogram observations must be finite");
    const entry = this._entry(labels, (values) => ({
      labels: values,
      count: 0,
      sum: 0,
      buckets: this.buckets.map(() => 0)
    }));
    entry.count++;
    entry.sum += value;
    this.buckets.forEach((upperBound, index) => {
      if (value <= upperBound) entry.buckets[index]++;
    });
  }
  _serialize() {
    const lines = [];
    for (const entry of this._entries()) {
      this.buckets.forEach((upperBound, index) => {
        lines.push(`${this.name}_bucket${formatLabels(this.labelNames, entry.labels, { name: "le", value: number(upperBound) })} ${entry.buckets[index]}`);
      });
      lines.push(`${this.name}_bucket${formatLabels(this.labelNames, entry.labels, { name: "le", value: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${formatLabels(this.labelNames, entry.labels)} ${number(entry.sum)}`);
      lines.push(`${this.name}_count${formatLabels(this.labelNames, entry.labels)} ${entry.count}`);
    }
    return lines;
  }
};
function createRegistry() {
  const metrics = /* @__PURE__ */ new Map();
  return {
    _register(metric2) {
      if (metrics.has(metric2.name)) throw new Error(`Metric already registered: ${metric2.name}`);
      metrics.set(metric2.name, metric2);
    },
    counter(nameOrOptions, help, labelNames) {
      return new Counter(this, normalizeDefinition(nameOrOptions, help, labelNames));
    },
    gauge(nameOrOptions, help, labelNames) {
      return new Gauge(this, normalizeDefinition(nameOrOptions, help, labelNames));
    },
    histogram(nameOrOptions, help, labelNames, buckets) {
      return new Histogram(this, normalizeDefinition(nameOrOptions, help, labelNames, { buckets }));
    },
    reset() {
      for (const metric2 of metrics.values()) metric2.reset();
    },
    metrics() {
      const lines = [];
      for (const metric2 of [...metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`# HELP ${metric2.name} ${escapeHelp(metric2.help)}`);
        lines.push(`# TYPE ${metric2.name} ${metric2.type}`);
        lines.push(...metric2._serialize());
      }
      return `${lines.join("\n")}
`;
    }
  };
}
function normalizeRoute(pathOrUrl) {
  let pathname = String(pathOrUrl ?? "");
  try {
    pathname = new URL(pathname, "http://metrics.invalid").pathname;
  } catch {
    return ROUTES.unknown;
  }
  if (FIXED_ROUTES.has(pathname) && pathname !== ROUTES.unknown) return pathname;
  if (/^\/v1beta\/models\/.+:generateContent$/.test(pathname)) return ROUTES.geminiGenerate;
  if (/^\/v1beta\/models\/.+:streamGenerateContent$/.test(pathname)) return ROUTES.geminiStreamGenerate;
  return ROUTES.unknown;
}
function bounded(value, allowed) {
  const normalized = String(value ?? "").toLowerCase();
  return allowed.has(normalized) ? normalized : "other";
}
function nonNegative(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and non-negative`);
  return value;
}
function createMetrics() {
  const registry = createRegistry();
  const httpRequests = registry.counter({ name: "opencode_proxy_http_requests_total", help: "Completed HTTP requests.", labelNames: ["method", "route", "status"] });
  const httpDuration = registry.histogram({ name: "opencode_proxy_http_request_duration_seconds", help: "HTTP request completion duration in seconds.", labelNames: ["method", "route", "status"] });
  const activeRequests = registry.gauge({ name: "opencode_proxy_active_requests", help: "Requests currently being processed." });
  const queuedRequests = registry.gauge({ name: "opencode_proxy_queued_requests", help: "Requests waiting for a processing slot." });
  const upstreamAttempts = registry.counter({ name: "opencode_proxy_upstream_attempts_total", help: "Upstream request attempts by outcome.", labelNames: ["outcome"] });
  const tokens = registry.counter({ name: "opencode_proxy_tokens_total", help: "Model tokens processed by direction.", labelNames: ["direction"] });
  const mediaRequests = registry.counter({ name: "opencode_proxy_remote_media_requests_total", help: "Remote media fetches by outcome.", labelNames: ["outcome"] });
  const mediaBytes = registry.counter({ name: "opencode_proxy_remote_media_bytes_total", help: "Bytes received from successful remote media fetches." });
  const mediaRedirects = registry.counter({ name: "opencode_proxy_remote_media_redirects_total", help: "Redirects followed while fetching remote media." });
  const mediaInFlight = registry.gauge({ name: "opencode_proxy_remote_media_in_flight", help: "Remote media fetches currently in flight." });
  const mediaDuration = registry.histogram({ name: "opencode_proxy_remote_media_duration_seconds", help: "Remote media fetch duration in seconds.", labelNames: ["outcome"] });
  function httpLabels({ method, route, pathname, status }) {
    const normalizedMethod = String(method ?? "").toUpperCase();
    const numericStatus = Number(status);
    return {
      method: METHODS.has(normalizedMethod) ? normalizedMethod : "OTHER",
      route: normalizeRoute(route ?? pathname),
      status: Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599 ? String(numericStatus) : "unknown"
    };
  }
  return {
    registry,
    metrics: () => registry.metrics(),
    serialize: () => registry.metrics(),
    reset: () => registry.reset(),
    recordHttpCompletion(details) {
      const labels = httpLabels(details);
      const duration = details.durationSeconds ?? (details.durationMs === void 0 ? void 0 : details.durationMs / 1e3);
      nonNegative(duration, "duration");
      httpRequests.inc(labels);
      httpDuration.observe(labels, duration);
    },
    incActiveRequests(amount = 1) {
      activeRequests.inc(nonNegative(amount, "amount"));
    },
    decActiveRequests(amount = 1) {
      activeRequests.dec(nonNegative(amount, "amount"));
    },
    setActiveRequests(value) {
      activeRequests.set(nonNegative(value, "active requests"));
    },
    incQueuedRequests(amount = 1) {
      queuedRequests.inc(nonNegative(amount, "amount"));
    },
    decQueuedRequests(amount = 1) {
      queuedRequests.dec(nonNegative(amount, "amount"));
    },
    setQueuedRequests(value) {
      queuedRequests.set(nonNegative(value, "queued requests"));
    },
    recordUpstreamAttempt(outcome) {
      upstreamAttempts.inc({ outcome: bounded(outcome, UPSTREAM_OUTCOMES) });
    },
    recordTokens({ input = 0, output = 0 }) {
      tokens.inc({ direction: "input" }, nonNegative(input, "input tokens"));
      tokens.inc({ direction: "output" }, nonNegative(output, "output tokens"));
    },
    startRemoteMedia() {
      mediaInFlight.inc();
      let finished = false;
      return ({ outcome, bytes = 0, redirects = 0, durationSeconds, durationMs } = {}) => {
        if (finished) return;
        finished = true;
        mediaInFlight.dec();
        this.recordRemoteMedia({ outcome, bytes, redirects, durationSeconds, durationMs });
      };
    },
    recordRemoteMedia({ outcome, bytes = 0, redirects = 0, durationSeconds, durationMs }) {
      const normalizedOutcome = bounded(outcome, MEDIA_OUTCOMES);
      const duration = durationSeconds ?? (durationMs === void 0 ? void 0 : durationMs / 1e3);
      nonNegative(bytes, "remote media bytes");
      nonNegative(redirects, "remote media redirects");
      nonNegative(duration, "duration");
      mediaRequests.inc({ outcome: normalizedOutcome });
      mediaBytes.inc(bytes);
      mediaRedirects.inc(redirects);
      mediaDuration.observe({ outcome: normalizedOutcome }, duration);
    }
  };
}
var defaultMetrics = createMetrics();
function getMetrics() {
  return defaultMetrics;
}

// remote-media.js
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { Buffer } from "node:buffer";
var DEFAULT_ACCEPTED_MIME_TYPES = Object.freeze([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "application/pdf"
]);
var REMOTE_MEDIA_DEFAULTS = Object.freeze({
  enabled: false,
  allowedSchemes: Object.freeze(["https"]),
  acceptedMimeTypes: DEFAULT_ACCEPTED_MIME_TYPES,
  maxBytes: 10 * 1024 * 1024,
  maxItems: 4,
  maxTotalItems: 64,
  maxRedirects: 3,
  timeoutMs: 15e3
});
var MediaError = class extends Error {
  constructor(message, status = 400, code = "invalid_media") {
    super(message);
    this.name = "MediaError";
    this.status = status;
    this.code = code;
  }
};
function fail(message, status, code) {
  return new MediaError(message, status, code);
}
function parseIPv4(address) {
  if (net.isIP(address) !== 4) return null;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? Uint8Array.from(bytes) : null;
}
function parseIPv6(address) {
  if (typeof address !== "string" || address.includes("%") || net.isIP(address) !== 6) return null;
  let input = address.toLowerCase();
  const embeddedAt = input.lastIndexOf(":");
  if (input.includes(".")) {
    const ipv4 = parseIPv4(input.slice(embeddedAt + 1));
    if (!ipv4) return null;
    input = `${input.slice(0, embeddedAt)}:${(ipv4[0] << 8 | ipv4[1]).toString(16)}:${(ipv4[2] << 8 | ipv4[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    const value = Number.parseInt(word, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 255;
  });
  return bytes;
}
function parseIPAddress(address) {
  const ipv4 = parseIPv4(address);
  if (ipv4) return { family: 4, bytes: ipv4 };
  const ipv6 = parseIPv6(address);
  return ipv6 ? { family: 6, bytes: ipv6 } : null;
}
function matchesPrefix(bytes, prefix, bits) {
  const whole = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  if (!remainder) return true;
  const mask = 255 << 8 - remainder & 255;
  return (bytes[whole] & mask) === (prefix[whole] & mask);
}
function addressInPrefix(address, cidr) {
  const [prefixAddress, rawBits] = String(cidr).split("/");
  const addressValue = parseIPAddress(address);
  const prefixValue = parseIPAddress(prefixAddress);
  const bits = Number(rawBits);
  return Boolean(addressValue && prefixValue && addressValue.family === prefixValue.family && Number.isInteger(bits) && bits >= 0 && bits <= addressValue.bytes.length * 8 && matchesPrefix(addressValue.bytes, prefixValue.bytes, bits));
}
var BLOCKED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4"
];
var BLOCKED_IPV6 = [
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:2::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8"
];
function mappedIPv4(parsed) {
  if (parsed.family !== 6) return null;
  const bytes = parsed.bytes;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
  return mapped ? `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}` : null;
}
function isPublicIPAddress(address) {
  const parsed = parseIPAddress(address);
  if (!parsed) return false;
  const mapped = mappedIPv4(parsed);
  if (mapped) return isPublicIPAddress(mapped);
  const ranges = parsed.family === 4 ? BLOCKED_IPV4 : BLOCKED_IPV6;
  return !ranges.some((cidr) => addressInPrefix(address, cidr));
}
function configuredSchemes(config) {
  const schemes = config.allowedSchemes ?? REMOTE_MEDIA_DEFAULTS.allowedSchemes;
  if (!Array.isArray(schemes) || schemes.length === 0) throw fail("Remote media configuration is invalid.", 500, "invalid_config");
  const normalized = schemes.map((scheme) => `${String(scheme).toLowerCase().replace(/:$/, "")}:`);
  if (normalized.some((scheme) => scheme !== "http:" && scheme !== "https:")) {
    throw fail("Remote media configuration is invalid.", 500, "invalid_config");
  }
  return normalized;
}
function validateRemoteUrl(value, config = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("Remote media URL is invalid.", 400, "invalid_media_url");
  }
  if (!configuredSchemes(config).includes(url.protocol)) throw fail("Remote media URL scheme is not allowed.", 400, "invalid_media_url");
  if (url.username || url.password) throw fail("Remote media URL credentials are not allowed.", 400, "invalid_media_url");
  if (!url.hostname) throw fail("Remote media URL is invalid.", 400, "invalid_media_url");
  return url;
}
function hostnameOf(url) {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}
async function resolvePublicHost(hostname, lookup = dns.lookup) {
  const literal = parseIPAddress(hostname);
  const answers = literal ? [{ address: hostname, family: literal.family }] : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw fail("Remote media host could not be resolved.", 502, "media_fetch_failed");
  const normalized = answers.map((answer) => ({ address: answer.address, family: Number(answer.family) || net.isIP(answer.address) }));
  if (normalized.some((answer) => !parseIPAddress(answer.address) || !isPublicIPAddress(answer.address))) {
    throw fail("Remote media host is not public.", 400, "blocked_media_host");
  }
  return normalized;
}
function sameAddress(left, right) {
  const a = parseIPAddress(left);
  const b = parseIPAddress(right);
  if (!a || !b) return false;
  const aMapped = mappedIPv4(a);
  const bMapped = mappedIPv4(b);
  if (aMapped || bMapped) return sameAddress(aMapped ?? left, bMapped ?? right);
  return a.family === b.family && a.bytes.every((byte, index) => byte === b.bytes[index]);
}
function metric(metrics, name, value = 1) {
  if (!metrics) return;
  if (typeof metrics.increment === "function") metrics.increment(name, value);
  else if (typeof metrics === "function") metrics(name, value);
  else metrics[name] = (Number(metrics[name]) || 0) + value;
}
function integerOption(config, name, fallback, minimum = 0) {
  const value = config[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw fail("Remote media configuration is invalid.", 500, "invalid_config");
  return value;
}
function acceptedMime(contentType, configured) {
  const mime = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  const accepted = configured ?? REMOTE_MEDIA_DEFAULTS.acceptedMimeTypes;
  if (!Array.isArray(accepted) || !accepted.every((entry) => typeof entry === "string")) {
    throw fail("Remote media configuration is invalid.", 500, "invalid_config");
  }
  const allowed = accepted.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern;
  });
  if (!mime || !allowed) throw fail("Remote media type is not supported.", 415, "unsupported_media_type");
  return mime;
}
function header(response, name) {
  const value = response.headers?.[name];
  return Array.isArray(value) ? value.join(",") : value;
}
function abortError(state) {
  return state.timedOut ? fail("Remote media download timed out.", 504, "media_timeout") : fail("Remote media download was aborted.", 499, "media_aborted");
}
function abortable(promise, signal, state) {
  if (signal.aborted) return Promise.reject(abortError(state));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(state));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
async function readBody(response, maxBytes, metrics, signal, state) {
  const rawLength = header(response, "content-length");
  if (rawLength !== void 0) {
    if (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > maxBytes) {
      response.destroy?.();
      throw fail("Remote media is too large.", 413, "media_too_large");
    }
  }
  const chunks = [];
  let total = 0;
  const onAbort = () => response.destroy?.(abortError(state));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        response.destroy?.();
        throw fail("Remote media is too large.", 413, "media_too_large");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw fail("Remote media could not be downloaded.", 502, "media_fetch_failed");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  metric(metrics, "remoteMediaBytes", total);
  return Buffer.concat(chunks, total);
}
function responseFor(url, pin, signal, config, state) {
  const dependencies = config.dependencies ?? {};
  const request = url.protocol === "https:" ? dependencies.httpsRequest ?? https.request : dependencies.httpRequest ?? http.request;
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const pinnedLookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, [pin]);
      else callback(null, pin.address, pin.family);
    };
    let req;
    try {
      req = request(url, {
        method: "GET",
        agent: false,
        signal,
        lookup: pinnedLookup,
        headers: { accept: "*/*", "accept-encoding": "identity" }
      }, (response) => {
        const remoteAddress = response.socket?.remoteAddress;
        if (!remoteAddress || !sameAddress(remoteAddress, pin.address) || !isPublicIPAddress(remoteAddress)) {
          response.destroy?.();
          finish(reject, fail("Remote media connection was rejected.", 400, "blocked_media_host"));
          return;
        }
        finish(resolve, response);
      });
    } catch {
      finish(reject, fail("Remote media could not be downloaded.", 502, "media_fetch_failed"));
      return;
    }
    req.on("error", (error) => {
      if (error instanceof MediaError) finish(reject, error);
      else if (state.timedOut) finish(reject, fail("Remote media download timed out.", 504, "media_timeout"));
      else if (signal.aborted) finish(reject, fail("Remote media download was aborted.", 499, "media_aborted"));
      else finish(reject, fail("Remote media could not be downloaded.", 502, "media_fetch_failed"));
    });
    onAbort = () => {
      req.destroy?.();
      finish(reject, abortError(state));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        if (!sameAddress(socket.remoteAddress, pin.address) || !isPublicIPAddress(socket.remoteAddress)) {
          req.destroy(fail("Remote media connection was rejected.", 400, "blocked_media_host"));
        }
      });
    });
    req.end();
  });
}
async function download(initialUrl, signal, config, metrics, state) {
  const maxRedirects = integerOption(config, "maxRedirects", REMOTE_MEDIA_DEFAULTS.maxRedirects);
  const maxBytes = integerOption(config, "maxBytes", REMOTE_MEDIA_DEFAULTS.maxBytes, 1);
  const lookup = config.dependencies?.lookup ?? dns.lookup;
  let url = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    const answers = await abortable(resolvePublicHost(hostnameOf(url), lookup), signal, state).catch((error) => {
      if (error instanceof MediaError) throw error;
      throw fail("Remote media host could not be resolved.", 502, "media_fetch_failed");
    });
    const response = await responseFor(url, answers[0], signal, config, state);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy?.();
      if (redirects >= maxRedirects || !header(response, "location")) {
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected");
      }
      let next;
      try {
        next = validateRemoteUrl(new URL(header(response, "location"), url).href, config);
      } catch (error) {
        if (error instanceof MediaError) throw error;
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected");
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected");
      }
      metric(metrics, "remoteMediaRedirects");
      url = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy?.();
      throw fail("Remote media server returned an invalid response.", 502, "media_fetch_failed");
    }
    const encoding = String(header(response, "content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding !== "identity") {
      response.destroy?.();
      throw fail("Encoded remote media is not supported.", 415, "unsupported_media_encoding");
    }
    let mime;
    try {
      mime = acceptedMime(header(response, "content-type"), config.acceptedMimeTypes);
    } catch (error) {
      response.destroy?.();
      throw error;
    }
    const body = await readBody(response, maxBytes, metrics, signal, state);
    return { mime, url: `data:${mime};base64,${body.toString("base64")}` };
  }
}
async function prepareMedia(media, config = {}, signal, metrics) {
  if (media == null) return [];
  if (!Array.isArray(media)) throw fail("Media must be an array.", 400, "invalid_media");
  const maxTotalItems = integerOption(config, "maxTotalItems", REMOTE_MEDIA_DEFAULTS.maxTotalItems);
  if (media.length > maxTotalItems) throw fail("Too many media items.", 413, "too_many_media_items");
  const remote = media.filter((item) => typeof item?.url === "string" && !item.url.startsWith("data:"));
  const maxItems = integerOption(config, "maxItems", REMOTE_MEDIA_DEFAULTS.maxItems);
  if (remote.length > maxItems) throw fail("Too many remote media items.", 413, "too_many_media_items");
  if (media.some((item) => !item || typeof item.url !== "string")) throw fail("Media item is invalid.", 400, "invalid_media");
  if (remote.length && config.enabled !== true) throw fail("Remote media is disabled.", 400, "remote_media_disabled");
  if (!remote.length) return [...media];
  const timeoutMs = integerOption(config, "timeoutMs", REMOTE_MEDIA_DEFAULTS.timeoutMs, 1);
  const dependencies = config.dependencies ?? {};
  const controller = new AbortController();
  const state = { timedOut: false };
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = (dependencies.setTimeout ?? setTimeout)(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const result = [];
  try {
    for (const item of media) {
      if (item.url.startsWith("data:")) {
        result.push(item);
        continue;
      }
      metric(metrics, "remoteMediaAttempts");
      const prepared = await download(validateRemoteUrl(item.url, config), controller.signal, config, metrics, state);
      result.push({ ...item, ...prepared });
      metric(metrics, "remoteMediaDownloads");
    }
    return result;
  } catch (error) {
    metric(metrics, "remoteMediaFailures");
    if (error instanceof MediaError) throw error;
    if (state.timedOut) throw fail("Remote media download timed out.", 504, "media_timeout");
    if (controller.signal.aborted) throw fail("Remote media download was aborted.", 499, "media_aborted");
    throw fail("Remote media could not be downloaded.", 502, "media_fetch_failed");
  } finally {
    (dependencies.clearTimeout ?? clearTimeout)(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

// index.js
var STATE_KEY = "__opencodeOpenAIProxyState";
var BRIDGE_SCRIPT_PATH = fileURLToPath(new URL("./mcp-tool-bridge.js", import.meta.url));
function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = { started: false };
  }
  return globalThis[STATE_KEY];
}
var DEFAULTS = Object.freeze({
  requestTimeoutMs: 12e4,
  maxRequestBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
  maxQueuedRequests: 32,
  bridgeAcquireTimeoutMs: 1e4,
  bridgeMaxQueue: 32
});
var ProxyError = class extends Error {
  constructor(message, status = 500, code = "server_error") {
    super(message);
    this.name = "ProxyError";
    this.status = status;
    this.code = code;
  }
};
function integerEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === void 0 || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProxyError(`${name} must be an integer between ${min} and ${max}.`, 500, "invalid_config");
  }
  return value;
}
function jsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw?.trim()) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error();
    return value.map((entry) => entry.trim());
  } catch {
    throw new ProxyError(`${name} must be a JSON array of non-empty strings.`, 500, "invalid_config");
  }
}
function objectEnv(name) {
  const raw = process.env[name];
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ProxyError(`${name} must be a JSON object.`, 500, "invalid_config");
  }
}
function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === void 0 || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ProxyError(`${name} must be 'true' or 'false'.`, 500, "invalid_config");
}
function jsonArrayEnvDefault(name, fallback) {
  return process.env[name]?.trim() ? jsonArrayEnv(name) : [...fallback];
}
function loadConfig() {
  const legacyToken = process.env.OPENCODE_LLM_PROXY_TOKEN?.trim();
  const configuredOrigin = process.env.OPENCODE_LLM_PROXY_CORS_ORIGIN?.trim();
  const origins = jsonArrayEnv("OPENCODE_LLM_PROXY_CORS_ORIGINS");
  if (configuredOrigin) origins.push(configuredOrigin);
  const maxRequestBytes = integerEnv("OPENCODE_LLM_PROXY_MAX_REQUEST_BYTES", DEFAULTS.maxRequestBytes, { min: 1, max: 100 * 1024 * 1024 });
  return {
    tokens: [...new Set([legacyToken, ...jsonArrayEnv("OPENCODE_LLM_PROXY_TOKENS")].filter(Boolean))],
    corsOrigins: [...new Set(origins)],
    allowPrivateNetwork: process.env.OPENCODE_LLM_PROXY_ALLOW_PRIVATE_NETWORK === "true",
    requestTimeoutMs: integerEnv("OPENCODE_LLM_PROXY_REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs, { min: 1, max: 36e5 }),
    maxRequestBytes,
    maxConcurrentRequests: integerEnv("OPENCODE_LLM_PROXY_MAX_CONCURRENT_REQUESTS", DEFAULTS.maxConcurrentRequests, { min: 1, max: 1e3 }),
    maxQueuedRequests: integerEnv("OPENCODE_LLM_PROXY_MAX_QUEUED_REQUESTS", DEFAULTS.maxQueuedRequests, { min: 0, max: 1e4 }),
    bridgeAcquireTimeoutMs: integerEnv("OPENCODE_LLM_PROXY_TOOL_BRIDGE_ACQUIRE_TIMEOUT_MS", DEFAULTS.bridgeAcquireTimeoutMs, { min: 1, max: 36e5 }),
    bridgeMaxQueue: integerEnv("OPENCODE_LLM_PROXY_TOOL_BRIDGE_MAX_QUEUE", DEFAULTS.bridgeMaxQueue, { min: 0, max: 1e4 }),
    keepSessions: process.env.OPENCODE_LLM_PROXY_KEEP_SESSIONS === "true",
    aliases: objectEnv("OPENCODE_LLM_PROXY_MODEL_ALIASES"),
    metricsEnabled: booleanEnv("OPENCODE_LLM_PROXY_METRICS_ENABLED"),
    remoteMedia: {
      enabled: booleanEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_ENABLED"),
      allowedSchemes: jsonArrayEnvDefault("OPENCODE_LLM_PROXY_REMOTE_MEDIA_ALLOWED_SCHEMES", ["https"]),
      maxBytes: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_BYTES", maxRequestBytes || 1024 * 1024, { min: 1, max: 100 * 1024 * 1024 }),
      maxItems: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_ITEMS", 4, { min: 0, max: 1e4 }),
      maxTotalItems: integerEnv("OPENCODE_LLM_PROXY_MAX_MEDIA_ITEMS", 64, { min: 1, max: 1e4 }),
      maxRedirects: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_MAX_REDIRECTS", 3, { min: 0, max: 100 }),
      timeoutMs: integerEnv("OPENCODE_LLM_PROXY_REMOTE_MEDIA_TIMEOUT_MS", 1e4, { min: 1, max: 36e5 })
    }
  };
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
    ...corsHeaders(request, config)
  };
}
function corsHeaders(request, config = loadConfig()) {
  const requestedPrivateNetwork = request?.headers.get("access-control-request-private-network");
  const requestOrigin = request?.headers.get("origin");
  if (!requestOrigin) return {};
  const allowed = config.corsOrigins.includes("*") || config.corsOrigins.includes(requestOrigin);
  if (!allowed) return { vary: "origin, access-control-request-method, access-control-request-headers" };
  const headers = {
    vary: "origin, access-control-request-method, access-control-request-headers",
    "access-control-allow-origin": config.corsOrigins.includes("*") ? "*" : requestOrigin,
    "access-control-allow-headers": "authorization, content-type, x-opencode-provider, x-opencode-variant, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400"
  };
  if (requestedPrivateNetwork === "true" && config.allowPrivateNetwork) {
    headers["access-control-allow-private-network"] = "true";
  }
  return headers;
}
function json(data, status = 200, headers = {}, request, config) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...commonHeaders(request, config ?? loadConfig()),
      ...headers
    }
  });
}
function text(message, status = 200, request, config) {
  return new Response(message, {
    status,
    headers: commonHeaders(request, config ?? loadConfig())
  });
}
function unauthorized(request) {
  return json(
    {
      error: {
        message: "Unauthorized",
        type: "invalid_request_error"
      }
    },
    401,
    { "www-authenticate": 'Bearer realm="OpenCode LLM Proxy"' },
    request
  );
}
function badRequest(message, status = 400, request, code) {
  return json(
    {
      error: {
        message,
        type: "invalid_request_error",
        ...code ? { code } : {}
      }
    },
    status,
    {},
    request
  );
}
function internalError(message, status = 500, request) {
  return json(
    {
      error: {
        message,
        type: "server_error"
      }
    },
    status,
    {},
    request
  );
}
function getBearerToken(request) {
  const header2 = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header2.startsWith(prefix)) return void 0;
  return header2.slice(prefix.length).trim();
}
function tokensEqual(left, right) {
  const a = Buffer2.from(left);
  const b = Buffer2.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isAuthorized(request, config = loadConfig()) {
  if (config.tokens.length === 0) return true;
  const supplied = getBearerToken(request);
  return Boolean(supplied && config.tokens.some((token) => tokensEqual(supplied, token)));
}
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function readJsonBody(request, maxBytes, signal) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProxyError("Request body is too large.", 413, "request_too_large");
  }
  if (!request.body) throw new ProxyError("Request body must be valid JSON.", 400, "invalid_json");
  const reader = request.body.getReader();
  const onAbort = () => reader.cancel(signal.reason).catch(() => {
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  const read = () => new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    reader.read().then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ProxyError("Request body is too large.", 413, "request_too_large");
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer2.concat(chunks.map((chunk) => Buffer2.from(chunk))).toString("utf8"));
    if (!isPlainObject(body)) throw new ProxyError("Request body must be a JSON object.", 400, "invalid_json");
    return body;
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw new ProxyError("Request body must be valid JSON.", 400, "invalid_json");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
function createRequestSignal(request, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ProxyError("Request was cancelled.", 499, "cancelled"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ProxyError("Upstream request timed out.", 504, "timeout")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    finish() {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  };
}
function getRequestLimiter(config) {
  const state = getState();
  const key = `${config.maxConcurrentRequests}:${config.maxQueuedRequests}`;
  if (!state.requestLimiter || state.requestLimiter.key !== key) {
    state.requestLimiter = { key, active: 0, waiters: [] };
  }
  return state.requestLimiter;
}
async function acquireRequestSlot(config, signal) {
  const limiter = getRequestLimiter(config);
  const metrics = getMetrics();
  if (signal?.aborted) throw signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled");
  if (limiter.active < config.maxConcurrentRequests) {
    limiter.active++;
    metrics.setActiveRequests(limiter.active);
    return () => releaseRequestSlot(limiter);
  }
  if (limiter.waiters.length >= config.maxQueuedRequests) {
    throw new ProxyError("The proxy is busy. Try again later.", 503, "overloaded");
  }
  return new Promise((resolve, reject) => {
    const waiter = { active: true };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (!waiter.active) return;
      waiter.active = false;
      limiter.waiters = limiter.waiters.filter((entry) => entry !== waiter);
      metrics.setQueuedRequests(limiter.waiters.length);
      cleanup();
      reject(signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled"));
    };
    waiter.resolve = () => {
      if (!waiter.active) return false;
      waiter.active = false;
      cleanup();
      limiter.active++;
      metrics.setActiveRequests(limiter.active);
      metrics.setQueuedRequests(limiter.waiters.filter((entry) => entry.active).length);
      resolve(() => releaseRequestSlot(limiter));
      return true;
    };
    limiter.waiters.push(waiter);
    metrics.setQueuedRequests(limiter.waiters.length);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function releaseRequestSlot(limiter) {
  limiter.active = Math.max(0, limiter.active - 1);
  getMetrics().setActiveRequests(limiter.active);
  while (limiter.waiters.length > 0) {
    const waiter = limiter.waiters.shift();
    if (waiter.resolve()) return;
  }
}
function renderedSystem(canonicalSystem) {
  return [
    canonicalSystem,
    "You are answering through a proxy backed by OpenCode.",
    "Return only the assistant's reply content."
  ].filter(Boolean).join("\n\n");
}
async function prepareCanonicalRequest(canonical2, config, signal, candidates = []) {
  const rendered = renderOpenCodePrompt(canonical2);
  for (const part of rendered.media) {
    const kind = part.mime === "application/pdf" ? "pdf" : part.mime.split("/", 1)[0];
    if (candidates.length > 0 && candidates.every((model) => model.capabilities?.input?.[kind] === false)) {
      throw new ProxyError(`The selected model does not support ${kind} input.`, 400, "unsupported_media");
    }
  }
  let finishRemoteMedia;
  let remoteMediaBytes = 0;
  let remoteMediaRedirects = 0;
  let remoteMediaStarted = 0;
  const finish = (outcome) => {
    finishRemoteMedia?.({
      outcome,
      bytes: remoteMediaBytes,
      redirects: remoteMediaRedirects,
      durationMs: Date.now() - remoteMediaStarted
    });
    finishRemoteMedia = void 0;
  };
  try {
    const media = await prepareMedia(rendered.media, config.remoteMedia, signal, {
      increment(name, value = 1) {
        if (name === "remoteMediaAttempts") {
          remoteMediaBytes = 0;
          remoteMediaRedirects = 0;
          remoteMediaStarted = Date.now();
          finishRemoteMedia = getMetrics().startRemoteMedia();
        } else if (name === "remoteMediaBytes") {
          remoteMediaBytes += value;
        } else if (name === "remoteMediaRedirects") {
          remoteMediaRedirects += value;
        } else if (name === "remoteMediaDownloads") {
          finish("success");
        }
      }
    });
    return { messages: [{ role: "user", content: rendered.text }], system: renderedSystem(rendered.system), media };
  } catch (error) {
    const outcome = error?.code === "media_timeout" ? "timeout" : error?.code === "media_aborted" ? "cancelled" : error?.status === 400 || error?.status === 413 || error?.status === 415 ? "rejected" : "error";
    finish(outcome);
    if (error instanceof MediaError) throw new ProxyError(error.message, error.status, error.code);
    throw error;
  }
}
function toTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text?.trim() ?? "").filter(Boolean).join("\n\n");
}
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const toolNameByCallId = /* @__PURE__ */ new Map();
  return messages.map((message) => {
    if (!isPlainObject(message) || typeof message.role !== "string") return null;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const baseText = toTextContent(message.content).trim();
      const callsText = message.tool_calls.map((call) => {
        const name = call.function?.name ?? call.name ?? "unknown_tool";
        const args = call.function?.arguments ?? "";
        if (call.id) toolNameByCallId.set(call.id, name);
        return `[Called tool ${name} with arguments ${args}]`;
      }).join("\n");
      return { role: message.role, content: [baseText, callsText].filter(Boolean).join("\n\n") };
    }
    if (message.role === "tool") {
      const name = toolNameByCallId.get(message.tool_call_id) ?? "tool";
      const resultText = toTextContent(message.content).trim();
      return { role: "tool", content: `[Result from tool ${name}]: ${resultText}` };
    }
    return {
      role: message.role,
      content: toTextContent(message.content).trim()
    };
  }).filter((message) => message && message.content.length > 0);
}
function normalizeResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input.trim() }].filter((message) => message.content);
  }
  if (!Array.isArray(input)) return [];
  const toolNameByCallId = /* @__PURE__ */ new Map();
  return input.map((item) => {
    if (item?.type === "function_call") {
      const name = item.name ?? "unknown_tool";
      if (item.call_id) toolNameByCallId.set(item.call_id, name);
      return { role: "assistant", content: `[Called tool ${name} with arguments ${item.arguments ?? ""}]` };
    }
    if (item?.type === "function_call_output") {
      const name = toolNameByCallId.get(item.call_id) ?? "tool";
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      return { role: "tool", content: `[Result from tool ${name}]: ${output}` };
    }
    const role = item.role ?? item.type ?? "user";
    if (typeof item.content === "string") {
      return { role, content: item.content.trim() };
    }
    if (Array.isArray(item.content)) {
      const content = item.content.map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        if (typeof part.output_text === "string") return part.output_text;
        return "";
      }).filter(Boolean).join("\n\n").trim();
      return { role, content };
    }
    if (Array.isArray(item.input)) {
      const content = item.input.map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        return "";
      }).filter(Boolean).join("\n\n").trim();
      return { role, content };
    }
    return { role, content: "" };
  }).filter((message) => message.content.length > 0);
}
function buildSystemPrompt(messages, _request) {
  const systemMessages = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => message.content);
  const hints = [
    "You are answering through a proxy backed by OpenCode.",
    "Return only the assistant's reply content."
  ];
  return [...systemMessages, ...hints].join("\n\n").trim();
}
function buildPrompt(messages) {
  const chatMessages = messages.filter(
    (message) => message.role !== "system" && message.role !== "developer"
  );
  if (chatMessages.length === 0) {
    return "Say hello.";
  }
  if (chatMessages.length === 1 && chatMessages[0].role === "user") {
    return chatMessages[0].content;
  }
  const transcript = chatMessages.map((message) => `${String(message.role).toUpperCase()}:
${message.content}`).join("\n\n");
  return [
    "Continue the conversation below and provide the next assistant reply.",
    "Respond as the assistant to the latest user message.",
    "Conversation:",
    transcript
  ].join("\n\n");
}
function extractAssistantText(parts) {
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim();
}
function dataUrlSize(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return 0;
  const comma = url.indexOf(",");
  if (comma === -1) return Number.POSITIVE_INFINITY;
  const metadata = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  return metadata.endsWith(";base64") ? Math.ceil(payload.length * 0.75) : Buffer2.byteLength(decodeURIComponent(payload));
}
function validateFilePart(part, model, maxBytes) {
  if (!part?.mime || !part?.url) throw new ProxyError("Invalid file or image content part.", 400, "invalid_media");
  if (!part.url.startsWith("data:")) {
    throw new ProxyError("Only embedded data URLs are supported for media.", 400, "invalid_media");
  }
  if (dataUrlSize(part.url) > maxBytes) throw new ProxyError("Embedded media is too large.", 413, "request_too_large");
  const kind = part.mime === "application/pdf" ? "pdf" : part.mime.split("/", 1)[0];
  const input = model.capabilities?.input;
  if (input && kind in input && !input[kind]) {
    throw new ProxyError(`Model '${model.id}' does not support ${kind} input.`, 400, "unsupported_media");
  }
}
function promptParts(messages, media, model, maxBytes) {
  const parts = [{ type: "text", text: buildPrompt(messages) }];
  for (const part of media ?? []) {
    validateFilePart(part, model, maxBytes);
    parts.push({ type: "file", mime: part.mime, url: part.url, ...part.filename ? { filename: part.filename } : {} });
  }
  return parts;
}
function structuredFormat(request) {
  const openAI = request.response_format?.json_schema?.schema ?? request.text?.format?.schema;
  const gemini = request.generationConfig?.responseSchema;
  const schema = openAI ?? gemini;
  if (!schema) return void 0;
  if (!isPlainObject(schema)) throw new ProxyError("Structured output schema must be a JSON object.", 400, "invalid_schema");
  return { type: "json_schema", schema };
}
function validateUnsupportedControls(request) {
  const unsupported = ["stop", "seed", "frequency_penalty", "presence_penalty", "logprobs", "n"].filter((name) => request[name] !== void 0);
  if (unsupported.length > 0) {
    throw new ProxyError(`Unsupported generation controls: ${unsupported.join(", ")}.`, 400, "unsupported_parameter");
  }
}
async function deleteSession(client, sessionID, keepSessions) {
  if (keepSessions || !sessionID || typeof client.session.delete !== "function") return;
  try {
    await client.session.delete({ path: { id: sessionID } });
  } catch {
  }
}
function setGenerationControls(sessionID, controls) {
  if (!sessionID || !controls || Object.keys(controls).length === 0) return;
  const state = getState();
  state.generationControls ??= /* @__PURE__ */ new Map();
  state.generationControls.set(sessionID, controls);
}
function clearGenerationControls(sessionID) {
  getState().generationControls?.delete(sessionID);
}
async function executePrompt(client, _request, model, messages, system, callerTools = [], options = {}) {
  if (Array.isArray(callerTools) && callerTools.length > 0) {
    const result = await runAgentTurn(client, model, messages, system, callerTools, () => {
    }, options);
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      request: _request,
      sessionID: result.sessionID,
      completion: {
        data: {
          info: {
            finish: result.finish,
            tokens: result.tokens
          }
        }
      }
    };
  }
  const tools = await getDisabledTools(client);
  let sessionID;
  try {
    const session = await client.session.create({ body: { title: `Proxy: ${model.id}` }, signal: options.signal });
    sessionID = session.data.id;
    setGenerationControls(sessionID, options.controls);
    const completion = await client.session.prompt({
      path: { id: sessionID },
      signal: options.signal,
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        system,
        tools,
        parts: promptParts(messages, options.media, model, options.maxRequestBytes ?? DEFAULTS.maxRequestBytes),
        ...options.format ? { format: options.format } : {},
        ...options.variant ? { variant: options.variant } : {}
      }
    });
    const structured = completion.data.info?.structured;
    const content = structured === void 0 ? extractAssistantText(completion.data.parts ?? []) : JSON.stringify(structured);
    if (!content && completion.data.info?.error) throw new Error(completion.data.info.error.message ?? "Model call failed.");
    return { content, structured, toolCalls: [], completion, request: _request, sessionID };
  } finally {
    clearGenerationControls(sessionID);
    await deleteSession(client, sessionID, options.keepSessions);
  }
}
async function executePromptStreaming(client, model, messages, system, onChunk, callerTools = [], options = {}) {
  const result = await runAgentTurn(client, model, messages, system, callerTools, onChunk, options);
  return {
    sessionID: result.sessionID,
    tokens: result.tokens,
    finish: result.finish,
    toolCalls: result.toolCalls,
    content: result.structured === void 0 ? result.content : JSON.stringify(result.structured),
    structured: result.structured
  };
}
function createChatCompletionResponse(result, model) {
  const now = Math.floor(Date.now() / 1e3);
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0;
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0;
  const toolCalls = result.toolCalls ?? [];
  const message = toolCalls.length > 0 ? {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {})
      }
    }))
  } : {
    role: "assistant",
    content: result.content
  };
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: now,
    model: model.id,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(result.completion.data.info?.finish),
        message
      }
    ],
    usage: {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut
    }
  };
}
function createResponsesApiResponse(result, model) {
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0;
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0;
  const toolCalls = result.toolCalls ?? [];
  const output = toolCalls.length > 0 ? toolCalls.map((call) => ({
    id: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments ?? {}),
    status: "completed"
  })) : [
    {
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: result.content,
          annotations: []
        }
      ]
    }
  ];
  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1e3),
    status: "completed",
    model: model.id,
    output,
    output_text: toolCalls.length > 0 ? "" : result.content,
    parallel_tool_calls: true,
    reasoning: {
      effort: result.request.reasoning?.effort ?? null,
      summary: null
    },
    text: {
      format: {
        type: "text"
      }
    },
    usage: {
      input_tokens: tokensIn,
      output_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
      input_tokens_details: {
        cached_tokens: result.completion.data.info?.tokens?.cache?.read ?? 0
      },
      output_tokens_details: {
        reasoning_tokens: result.completion.data.info?.tokens?.reasoning ?? 0
      }
    }
  };
}
function mapFinishReason(finish) {
  if (!finish) return "stop";
  if (finish.includes("length")) return "length";
  if (finish.includes("tool")) return "tool_calls";
  return "stop";
}
async function safeLog(client, level, message, extra) {
  try {
    await client.app.log({
      body: {
        service: "openai-proxy-plugin",
        level,
        message,
        extra
      }
    });
  } catch {
  }
}
async function getDisabledTools(client) {
  const state = getState();
  if (state.toolOffSwitch) return state.toolOffSwitch;
  const result = await client.tool.ids();
  const ids = Array.isArray(result.data) ? result.data : [];
  state.toolOffSwitch = Object.fromEntries(ids.map((id) => [id, false]));
  return state.toolOffSwitch;
}
function getToolBridgeState() {
  const state = getState();
  if (!state.toolBridge) {
    const configured = Number.parseInt(process.env.OPENCODE_LLM_PROXY_TOOL_BRIDGE_POOL_SIZE ?? "", 10);
    const poolSize = Number.isFinite(configured) && configured > 0 ? configured : 8;
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
      slotToolIDs: /* @__PURE__ */ new Map()
    };
  }
  return state.toolBridge;
}
async function acquireBridgeSlot(options = {}) {
  const bridgeState = getToolBridgeState();
  if (options.signal?.aborted) throw options.signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled");
  if (bridgeState.freeSlots.length > 0) {
    return bridgeState.freeSlots.shift();
  }
  if (bridgeState.waiters.filter((waiter) => waiter.active).length >= (options.maxQueue ?? DEFAULTS.bridgeMaxQueue)) {
    throw new ProxyError("Tool capacity is busy. Try again later.", 429, "tool_capacity_overloaded");
  }
  return new Promise((resolve, reject) => {
    const waiter = { active: true };
    const removeWaiter = () => {
      bridgeState.waiters = bridgeState.waiters.filter((entry) => entry !== waiter);
    };
    const timeout = setTimeout(() => {
      if (!waiter.active) return;
      waiter.active = false;
      removeWaiter();
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ProxyError("Timed out waiting for tool capacity.", 503, "tool_capacity_timeout"));
    }, options.timeoutMs ?? DEFAULTS.bridgeAcquireTimeoutMs);
    timeout.unref?.();
    const onAbort = () => {
      if (!waiter.active) return;
      waiter.active = false;
      clearTimeout(timeout);
      removeWaiter();
      reject(options.signal.reason ?? new ProxyError("Request was cancelled.", 499, "cancelled"));
    };
    waiter.resolve = (slot) => {
      if (!waiter.active) return false;
      waiter.active = false;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(slot);
      return true;
    };
    bridgeState.waiters.push(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function releaseBridgeSlot(slotName) {
  const bridgeState = getToolBridgeState();
  if (bridgeState.waiters.length > 0) {
    while (bridgeState.waiters.length > 0) {
      const waiter = bridgeState.waiters.shift();
      if (waiter.resolve(slotName)) return;
    }
  }
  if (!bridgeState.freeSlots.includes(slotName)) bridgeState.freeSlots.push(slotName);
}
function sanitizeToolName(name, seen = /* @__PURE__ */ new Set()) {
  let sanitized = String(name ?? "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
  if (!sanitized) sanitized = "tool";
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `t_${sanitized}`;
  let candidate = sanitized;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${sanitized}_${suffix}`;
    suffix++;
  }
  seen.add(candidate);
  return candidate;
}
function normalizeParameters(parameters) {
  if (parameters && typeof parameters === "object") return parameters;
  return { type: "object", properties: {} };
}
function parseOpenAITools(body) {
  const list = [];
  if (Array.isArray(body?.tools)) {
    for (const entry of body.tools) {
      if (!entry || entry.type !== "function") continue;
      const fn = entry.function ?? entry;
      if (typeof fn.name === "string" && fn.name) {
        list.push({
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: normalizeParameters(fn.parameters)
        });
      }
    }
  } else if (Array.isArray(body?.functions)) {
    for (const fn of body.functions) {
      if (fn && typeof fn.name === "string" && fn.name) {
        list.push({
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: normalizeParameters(fn.parameters)
        });
      }
    }
  }
  return list;
}
function applyOpenAIToolChoice(tools, toolChoice) {
  if (toolChoice === "none") return [];
  if (toolChoice && typeof toolChoice === "object") {
    const name = toolChoice.function?.name ?? toolChoice.name;
    if (toolChoice.type === "function" && name) {
      return tools.filter((tool) => tool.name === name);
    }
  }
  return tools;
}
function parseAnthropicTools(body) {
  const list = [];
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (tool && typeof tool.name === "string" && tool.name) {
        list.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: normalizeParameters(tool.input_schema)
        });
      }
    }
  }
  return list;
}
function applyAnthropicToolChoice(tools, toolChoice) {
  if (toolChoice?.type === "none") return [];
  if (toolChoice?.type === "tool" && toolChoice.name) {
    return tools.filter((tool) => tool.name === toolChoice.name);
  }
  return tools;
}
function parseGeminiTools(body) {
  const list = [];
  if (Array.isArray(body?.tools)) {
    for (const toolGroup of body.tools) {
      const declarations = Array.isArray(toolGroup?.functionDeclarations) ? toolGroup.functionDeclarations : [];
      for (const decl of declarations) {
        if (decl && typeof decl.name === "string" && decl.name) {
          list.push({
            name: decl.name,
            description: typeof decl.description === "string" ? decl.description : "",
            parameters: normalizeParameters(decl.parameters)
          });
        }
      }
    }
  }
  return list;
}
function applyGeminiToolChoice(tools, toolConfig) {
  const mode = toolConfig?.functionCallingConfig?.mode;
  if (mode === "NONE") return [];
  const allowed = toolConfig?.functionCallingConfig?.allowedFunctionNames;
  if (Array.isArray(allowed) && allowed.length > 0) {
    return tools.filter((tool) => allowed.includes(tool.name));
  }
  return tools;
}
async function registerToolBridge(client, tools, options = {}) {
  const slotName = await acquireBridgeSlot(options);
  try {
    const seen = /* @__PURE__ */ new Set();
    const nameMap = /* @__PURE__ */ new Map();
    const bridgeTools = tools.map((tool) => {
      const sanitized = sanitizeToolName(tool.name, seen);
      nameMap.set(`${slotName}_${sanitized}`, tool.name);
      return { name: sanitized, description: tool.description, parameters: tool.parameters };
    });
    try {
      await client.mcp.disconnect({ path: { name: slotName } });
    } catch {
    }
    await client.mcp.add({
      body: {
        name: slotName,
        config: {
          type: "local",
          command: ["node", BRIDGE_SCRIPT_PATH],
          environment: {
            OPENCODE_LLM_PROXY_BRIDGE_TOOLS: JSON.stringify(bridgeTools)
          },
          timeout: 1e4
        }
      }
    });
    const toolIDs = bridgeTools.map((tool) => `${slotName}_${tool.name}`);
    const bridgeState = getToolBridgeState();
    bridgeState.slotToolIDs.set(slotName, toolIDs);
    return { slotName, toolIDs, nameMap };
  } catch (error) {
    releaseBridgeSlot(slotName);
    throw error;
  }
}
function releaseToolBridge(bridge) {
  if (bridge && !bridge.released) {
    bridge.released = true;
    releaseBridgeSlot(bridge.slotName);
  }
}
function buildToolsMap(baseTools, bridge) {
  const toolsMap = { ...baseTools };
  if (!bridge) return toolsMap;
  const bridgeState = getToolBridgeState();
  for (const ids of bridgeState.slotToolIDs.values()) {
    for (const id of ids) toolsMap[id] = false;
  }
  for (const id of bridge.toolIDs) toolsMap[id] = true;
  return toolsMap;
}
async function runAgentTurn(client, model, messages, system, callerTools, onChunk, options = {}) {
  const baseTools = await getDisabledTools(client);
  let toolsMap = baseTools;
  let bridge = null;
  if (Array.isArray(callerTools) && callerTools.length > 0) {
    bridge = await registerToolBridge(client, callerTools, {
      signal: options.signal,
      timeoutMs: options.bridgeAcquireTimeoutMs,
      maxQueue: options.bridgeMaxQueue
    });
    toolsMap = buildToolsMap(baseTools, bridge);
  }
  let sessionID;
  let eventStream;
  let removeAbortListener = () => {
  };
  const toolIDSet = bridge ? new Set(bridge.toolIDs) : null;
  let errorMessage = null;
  let content = "";
  const toolCallsByID = /* @__PURE__ */ new Map();
  let toolMessageID = null;
  const recordToolPart = (part) => {
    const callID = part.callID;
    if (!callID) return;
    const input = part.state?.input;
    const hasInput = input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0;
    const existing = toolCallsByID.get(callID);
    if (!existing) {
      toolCallsByID.set(callID, {
        id: callID,
        name: bridge.nameMap.get(part.tool) ?? part.tool,
        arguments: hasInput ? input : {},
        hasInput: Boolean(hasInput)
      });
    } else if (hasInput && !existing.hasInput) {
      existing.arguments = input;
      existing.hasInput = true;
    }
  };
  try {
    const session = await client.session.create({ body: { title: `Proxy: ${model.id}` }, signal: options.signal });
    sessionID = session.data.id;
    setGenerationControls(sessionID, options.controls);
    const onAbort = () => client.session.abort?.({ path: { id: sessionID } }).catch(() => {
    });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const { stream } = await client.event.subscribe({ signal: options.signal });
    eventStream = stream;
    await client.session.promptAsync({
      path: { id: sessionID },
      signal: options.signal,
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        system,
        tools: toolsMap,
        parts: promptParts(messages, options.media, model, options.maxRequestBytes ?? DEFAULTS.maxRequestBytes),
        ...options.format ? { format: options.format } : {},
        ...options.variant ? { variant: options.variant } : {}
      }
    });
    for await (const event of stream) {
      if (event.type === "message.part.delta") {
        const props = event.properties;
        if (props?.sessionID === sessionID && props?.field === "text" && typeof props.delta === "string" && props.delta.length > 0) {
          content += props.delta;
          await onChunk?.(props.delta);
        }
      } else if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (!part || part.sessionID !== sessionID) continue;
        if (toolIDSet && part.type === "tool" && toolIDSet.has(part.tool) && (!toolMessageID || part.messageID === toolMessageID)) {
          if (part.messageID) toolMessageID = part.messageID;
          recordToolPart(part);
        } else if (part.type === "step-finish" && toolCallsByID.size > 0 && (!toolMessageID || part.messageID === toolMessageID)) {
          try {
            await client.session.abort({ path: { id: sessionID } });
          } catch {
          }
          break;
        }
      } else if (event.type === "session.error") {
        if (event.properties?.sessionID === sessionID) {
          errorMessage = event.properties?.error?.message ?? "Model call failed.";
        }
        break;
      } else if (event.type === "session.idle") {
        if (event.properties?.sessionID === sessionID) {
          break;
        }
      }
    }
  } catch (error) {
    await deleteSession(client, sessionID, options.keepSessions);
    throw error;
  } finally {
    removeAbortListener();
    try {
      await eventStream?.return?.();
    } catch {
    }
    clearGenerationControls(sessionID);
    releaseToolBridge(bridge);
  }
  const toolCalls = [...toolCallsByID.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments ?? {}
  }));
  if (errorMessage && toolCalls.length === 0) {
    await deleteSession(client, sessionID, options.keepSessions);
    throw new Error(errorMessage);
  }
  let assistantEntry;
  try {
    const messagesResult = await client.session.messages({ path: { id: sessionID }, signal: options.signal });
    assistantEntry = (messagesResult.data ?? []).filter((m) => m.info?.role === "assistant").at(-1);
  } catch (error) {
    await deleteSession(client, sessionID, options.keepSessions);
    throw error;
  }
  const assistantInfo = assistantEntry?.info;
  if (!content && toolCalls.length === 0) {
    content = extractAssistantText(assistantEntry?.parts ?? []);
  }
  if (!content && assistantInfo?.structured !== void 0) content = JSON.stringify(assistantInfo.structured);
  const result = {
    sessionID,
    content,
    toolCalls,
    tokens: assistantInfo?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: toolCalls.length > 0 ? "tool_calls" : assistantInfo?.finish,
    structured: assistantInfo?.structured
  };
  await deleteSession(client, sessionID, options.keepSessions);
  return result;
}
async function listModels(client) {
  const result = await client.config.providers();
  const payload = result.data;
  const all = Array.isArray(payload?.providers) ? payload.providers : [];
  return all.flatMap((provider) => {
    const models = provider.models ?? {};
    return Object.values(models).map((model) => ({
      id: `${provider.id}/${model.id}`,
      providerID: provider.id,
      modelID: model.id,
      name: model.name ?? model.id,
      capabilities: model.capabilities,
      limit: model.limit,
      cost: model.cost,
      status: model.status,
      variants: model.variants
    }));
  });
}
async function resolveModel(client, requestedModel, providerOverride) {
  const allModels = await listModels(client);
  if (providerOverride && requestedModel.includes("/")) {
    const [providerID] = requestedModel.split("/");
    if (providerID !== providerOverride) {
      throw new Error(`Model '${requestedModel}' does not match provider override '${providerOverride}'.`);
    }
  }
  if (providerOverride) {
    const match = allModels.find(
      (model) => model.providerID === providerOverride && model.modelID === requestedModel
    );
    if (match) return match;
  }
  if (requestedModel.includes("/")) {
    const [providerID, ...rest] = requestedModel.split("/");
    const modelID = rest.join("/");
    const fullMatch = allModels.find(
      (model) => model.providerID === providerID && model.modelID === modelID
    );
    if (fullMatch) return fullMatch;
  }
  const bareMatches = allModels.filter((model) => model.modelID === requestedModel);
  if (providerOverride) {
    const providerMatch = bareMatches.find((model) => model.providerID === providerOverride);
    if (providerMatch) return providerMatch;
  }
  if (bareMatches.length === 1) return bareMatches[0];
  if (bareMatches.length > 1) {
    throw new Error(
      `Model '${requestedModel}' is ambiguous. Use provider/model, for example '${bareMatches[0].id}'.`
    );
  }
  throw new Error(`Unknown model '${requestedModel}'. Call GET /v1/models to inspect available IDs.`);
}
async function resolveModelCandidates(client, requestedModel, providerOverride, aliases = {}) {
  const configured = aliases[requestedModel];
  const targets = typeof configured === "string" ? [configured] : configured;
  if (configured !== void 0 && (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== "string"))) {
    throw new ProxyError(`Model alias '${requestedModel}' is invalid.`, 500, "invalid_config");
  }
  const ids = targets ?? [requestedModel];
  const models = [];
  for (const id of ids) models.push(await resolveModel(client, id, providerOverride));
  return models;
}
function isRetryableError(error) {
  if (error instanceof ProxyError && error.status < 500) return false;
  return !error?.message?.toLowerCase().includes("invalid");
}
function upstreamOutcome(error) {
  if (error?.code === "timeout" || error?.status === 504) return "timeout";
  if (error?.code === "cancelled" || error?.status === 499) return "cancelled";
  return "error";
}
function recordExecutionMetrics(result) {
  const tokens = result?.tokens ?? result?.completion?.data?.info?.tokens;
  getMetrics().recordUpstreamAttempt("success");
  if (tokens) getMetrics().recordTokens(tokens);
}
async function executeWithFallback(candidates, operation) {
  let lastError;
  for (const candidate of candidates) {
    try {
      const result = await operation(candidate);
      recordExecutionMetrics(result);
      return { result, model: candidate };
    } catch (error) {
      getMetrics().recordUpstreamAttempt(upstreamOutcome(error));
      lastError = error;
      if (!isRetryableError(error)) throw error;
    }
  }
  throw lastError;
}
async function executeStreamingWithFallback(candidates, operation, hasOutput) {
  let lastError;
  for (const candidate of candidates) {
    try {
      const result = await operation(candidate);
      recordExecutionMetrics(result);
      return { result, model: candidate };
    } catch (error) {
      getMetrics().recordUpstreamAttempt(upstreamOutcome(error));
      lastError = error;
      if (hasOutput() || !isRetryableError(error)) throw error;
    }
  }
  throw lastError;
}
function createSseQueue() {
  const chunks = [];
  let resolve = null;
  let done = false;
  function enqueue(value) {
    chunks.push(value);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }
  function finish() {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }
  async function* generateChunks() {
    while (true) {
      while (chunks.length > 0) {
        yield chunks.shift();
      }
      if (done) break;
      await new Promise((r) => {
        resolve = r;
      });
    }
    while (chunks.length > 0) {
      yield chunks.shift();
    }
  }
  return { enqueue, finish, generateChunks };
}
function streamResponse(headers, generator, options = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch {
      } finally {
        controller.close();
        options.onDone?.();
      }
    },
    cancel(reason) {
      options.onCancel?.(reason);
      options.onDone?.();
    }
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...headers
    }
  });
}
function sseResponse(headers, generator, options) {
  return streamResponse(headers, generator, options);
}
function once(callback) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback?.();
  };
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
        cost: model.cost
      }
    }))
  };
}
function normalizeAnthropicMessages(messages) {
  const toolNameByUseId = /* @__PURE__ */ new Map();
  return messages.map((message) => {
    let content = "";
    if (typeof message.content === "string") {
      content = message.content.trim();
    } else if (Array.isArray(message.content)) {
      content = message.content.map((block) => {
        if (!block) return "";
        if (block.type === "text" && typeof block.text === "string") {
          return block.text.trim();
        }
        if (block.type === "tool_use") {
          if (block.id) toolNameByUseId.set(block.id, block.name);
          return `[Called tool ${block.name} with arguments ${JSON.stringify(block.input ?? {})}]`;
        }
        if (block.type === "tool_result") {
          const name = toolNameByUseId.get(block.tool_use_id) ?? "tool";
          let resultText = "";
          if (typeof block.content === "string") {
            resultText = block.content;
          } else if (Array.isArray(block.content)) {
            resultText = block.content.filter((inner) => inner && inner.type === "text" && typeof inner.text === "string").map((inner) => inner.text).join("\n\n");
          }
          return `[Result from tool ${name}]: ${resultText}`;
        }
        return "";
      }).filter(Boolean).join("\n\n");
    }
    return { role: message.role, content };
  }).filter((message) => message.content.length > 0);
}
function normalizeAnthropicSystem(system) {
  if (typeof system === "string") {
    const trimmed = system.trim();
    return trimmed || null;
  }
  if (Array.isArray(system)) {
    const text2 = system.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    return text2 || null;
  }
  return null;
}
function mapFinishReasonToAnthropic(finish) {
  if (!finish) return "end_turn";
  if (finish.includes("length")) return "max_tokens";
  if (finish.includes("tool")) return "tool_use";
  return "end_turn";
}
function createAnthropicResponse(result, model) {
  const tokensIn = result.completion.data.info?.tokens?.input ?? 0;
  const tokensOut = result.completion.data.info?.tokens?.output ?? 0;
  const toolCalls = result.toolCalls ?? [];
  const content = toolCalls.length > 0 ? toolCalls.map((call) => ({
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.arguments ?? {}
  })) : [{ type: "text", text: result.content }];
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    model: model.id,
    stop_reason: toolCalls.length > 0 ? "tool_use" : mapFinishReasonToAnthropic(result.completion.data.info?.finish),
    stop_sequence: null,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut }
  };
}
function anthropicBadRequest(message, status = 400, request) {
  return json(
    { type: "error", error: { type: "invalid_request_error", message } },
    status,
    {},
    request
  );
}
function anthropicInternalError(message, status = 500, request) {
  return json(
    { type: "error", error: { type: "api_error", message } },
    status,
    {},
    request
  );
}
function normalizeGeminiContents(contents) {
  if (!Array.isArray(contents)) return [];
  return contents.map((item) => {
    const role = item.role === "model" ? "assistant" : item.role ?? "user";
    const content = Array.isArray(item.parts) ? item.parts.map((part) => {
      if (!part) return "";
      if (typeof part.text === "string") return part.text.trim();
      if (part.functionCall) {
        return `[Called tool ${part.functionCall.name} with arguments ${JSON.stringify(part.functionCall.args ?? {})}]`;
      }
      if (part.functionResponse) {
        return `[Result from tool ${part.functionResponse.name}]: ${JSON.stringify(part.functionResponse.response ?? {})}`;
      }
      return "";
    }).filter(Boolean).join("\n\n") : "";
    return { role, content };
  }).filter((m) => m.content.length > 0);
}
function generationControls(body) {
  const source = body.generationConfig ?? body;
  const controls = {};
  if (source.temperature !== void 0) {
    if (typeof source.temperature !== "number" || source.temperature < 0 || source.temperature > 2) {
      throw new ProxyError("'temperature' must be a number between 0 and 2.", 400, "invalid_parameter");
    }
    controls.temperature = source.temperature;
  }
  const topP = source.top_p ?? source.topP;
  if (topP !== void 0) {
    if (typeof topP !== "number" || topP < 0 || topP > 1) throw new ProxyError("'top_p' must be between 0 and 1.", 400, "invalid_parameter");
    controls.topP = topP;
  }
  const topK = source.topK;
  if (topK !== void 0) {
    if (!Number.isInteger(topK) || topK < 1) throw new ProxyError("'topK' must be a positive integer.", 400, "invalid_parameter");
    controls.topK = topK;
  }
  return controls;
}
function extractGeminiSystemInstruction(systemInstruction) {
  if (!systemInstruction) return null;
  if (typeof systemInstruction === "string") return systemInstruction.trim();
  if (Array.isArray(systemInstruction.parts)) {
    return systemInstruction.parts.map((part) => typeof part?.text === "string" ? part.text.trim() : "").filter(Boolean).join("\n\n");
  }
  return null;
}
function mapFinishReasonToGemini(finish) {
  if (!finish) return "STOP";
  if (finish.includes("length")) return "MAX_TOKENS";
  if (finish.includes("tool")) return "STOP";
  return "STOP";
}
function createGeminiResponse(content, finish, tokens, toolCalls) {
  const calls = toolCalls ?? [];
  const parts = calls.length > 0 ? calls.map((call) => ({ functionCall: { name: call.name, args: call.arguments ?? {} } })) : [{ text: content }];
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReasonToGemini(finish),
        index: 0
      }
    ],
    usageMetadata: {
      promptTokenCount: tokens?.input ?? 0,
      candidatesTokenCount: tokens?.output ?? 0,
      totalTokenCount: (tokens?.input ?? 0) + (tokens?.output ?? 0)
    }
  };
}
function geminiModelFromPath(pathname) {
  const match = pathname.match(/^\/v1beta\/models\/(.+):(?:generateContent|streamGenerateContent)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
function createProxyFetchHandler(client) {
  const config = loadConfig();
  const handleRequest = async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      const method = request.headers.get("access-control-request-method");
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
      const allowedHeaders = /* @__PURE__ */ new Set(["authorization", "content-type", "x-opencode-provider", "x-opencode-variant", "x-request-id"]);
      const allowedOrigin = origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin));
      if (!allowedOrigin || method && !["GET", "POST", "OPTIONS"].includes(method) || requestedHeaders.some((value) => !allowedHeaders.has(value))) {
        return text("CORS preflight rejected", 403, request, config);
      }
      return new Response(null, { status: 204, headers: commonHeaders(request, config) });
    }
    if (origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
      return text("Origin not allowed", 403, request, config);
    }
    if (!isAuthorized(request, config)) {
      return unauthorized(request);
    }
    const started = Date.now();
    const context = createRequestSignal(request, config.requestTimeoutMs);
    let releaseSlot = () => {
    };
    let deferredCleanup = false;
    if (request.method === "POST") {
      try {
        releaseSlot = await acquireRequestSlot(config, context.signal);
      } catch (error) {
        context.finish();
        const status = error instanceof ProxyError ? error.status : 503;
        return badRequest(status === 503 ? "The proxy is busy. Try again later." : "Request was cancelled.", status, request);
      }
    }
    const options = {
      signal: context.signal,
      maxRequestBytes: config.maxRequestBytes,
      bridgeAcquireTimeoutMs: config.bridgeAcquireTimeoutMs,
      bridgeMaxQueue: config.bridgeMaxQueue,
      keepSessions: config.keepSessions
    };
    const streamCleanup = once(() => {
      releaseSlot();
      context.finish();
      safeLog(client, "info", "Proxy stream completed", {
        method: request.method,
        path: url.pathname,
        durationMs: Date.now() - started
      });
    });
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ healthy: true, service: "opencode-openai-proxy" }, 200, {}, request);
      }
      if (request.method === "GET" && url.pathname === "/metrics" && config.metricsEnabled) {
        return new Response(getMetrics().metrics(), {
          status: 200,
          headers: {
            ...commonHeaders(request, config),
            "content-type": "text/plain; version=0.0.4; charset=utf-8"
          }
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        try {
          const models = await listModels(client);
          return json(createModelResponse(models), 200, {}, request);
        } catch (error) {
          await safeLog(client, "error", "Failed to list proxy models", {
            error: error instanceof Error ? error.message : String(error)
          });
          return internalError("Failed to load models from OpenCode.", 500, request);
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body;
        try {
          body = await readJsonBody(request, config.maxRequestBytes, context.signal);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        if (!body.model) {
          return badRequest("The 'model' field is required.", 400, request);
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return badRequest("The 'messages' field must contain at least one message.", 400, request);
        }
        const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice);
        let format;
        let controls;
        try {
          validateUnsupportedControls(body);
          format = structuredFormat(body);
          if (format && callerTools.length > 0) throw new ProxyError("Structured output cannot be combined with tools.", 400, "invalid_request");
          controls = generationControls(body);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        let candidates;
        try {
          const providerOverride = request.headers.get("x-opencode-provider");
          candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Proxy completion failed", {
            error: message,
            requestedModel: body.model
          });
          return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request);
        }
        let prepared;
        try {
          prepared = await prepareCanonicalRequest(adaptOpenAIChat(body), config, context.signal, candidates);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request, error.code);
        }
        const { messages, system, media } = prepared;
        if (!messages[0].content.trim() && media.length === 0) {
          return badRequest("No text content was found in the supplied messages.", 400, request);
        }
        const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? void 0 };
        let model = candidates[0];
        if (body.stream) {
          const completionID = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
          const now = Math.floor(Date.now() / 1e3);
          const queue = createSseQueue();
          let emitted = false;
          async function* generateSse() {
            const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
              client,
              candidate,
              messages,
              system,
              (delta) => {
                emitted = true;
                const chunk = JSON.stringify({
                  id: completionID,
                  object: "chat.completion.chunk",
                  created: now,
                  model: model.id,
                  choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }]
                });
                queue.enqueue(`data: ${chunk}

`);
              },
              callerTools,
              requestOptions
            ), () => emitted).then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel;
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true;
                const chunk = JSON.stringify({ id: completionID, object: "chat.completion.chunk", created: now, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: streamResult.content }, finish_reason: null }] });
                queue.enqueue(`data: ${chunk}

`);
              }
              const toolCalls = streamResult.toolCalls ?? [];
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
                            arguments: JSON.stringify(call.arguments ?? {})
                          }
                        }))
                      },
                      finish_reason: null
                    }
                  ]
                });
                queue.enqueue(`data: ${toolCallChunk}

`);
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
                    finish_reason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(streamResult.finish)
                  }
                ],
                usage: {
                  prompt_tokens: streamResult.tokens.input,
                  completion_tokens: streamResult.tokens.output,
                  total_tokens: streamResult.tokens.input + streamResult.tokens.output
                }
              });
              queue.enqueue(`data: ${finalChunk}

data: [DONE]

`);
            }).catch(async (err) => {
              const streamError = err instanceof Error ? err.message : String(err);
              await safeLog(client, "error", "Proxy streaming completion failed", {
                error: streamError,
                requestedModel: body.model
              });
              const errChunk = JSON.stringify({
                error: { message: "Upstream request failed.", type: "server_error" }
              });
              queue.enqueue(`data: ${errChunk}

data: [DONE]

`);
            }).finally(() => {
              queue.finish();
            });
            yield* queue.generateChunks();
            await runPromise;
          }
          deferredCleanup = true;
          return sseResponse(commonHeaders(request, config), generateSse(), {
            onCancel: (reason) => context.abort(reason),
            onDone: streamCleanup
          });
        }
        try {
          const executed = await executeWithFallback(candidates, (candidate) => executePrompt(client, body, candidate, messages, system, callerTools, requestOptions));
          model = executed.model;
          return json(createChatCompletionResponse(executed.result, model), 200, {}, request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Proxy completion failed", {
            error: message,
            requestedModel: body.model
          });
          return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request);
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        let body;
        try {
          body = await readJsonBody(request, config.maxRequestBytes, context.signal);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        if (!body.model) {
          return badRequest("The 'model' field is required.", 400, request);
        }
        const callerTools = applyOpenAIToolChoice(parseOpenAITools(body), body.tool_choice);
        let format;
        let controls;
        try {
          validateUnsupportedControls(body);
          format = structuredFormat(body);
          if (format && callerTools.length > 0) throw new ProxyError("Structured output cannot be combined with tools.", 400, "invalid_request");
          controls = generationControls(body);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        let candidates;
        try {
          const providerOverride = request.headers.get("x-opencode-provider");
          candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Proxy responses call failed", {
            error: message,
            requestedModel: body.model
          });
          return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request);
        }
        let prepared;
        try {
          prepared = await prepareCanonicalRequest(adaptOpenAIResponses(body), config, context.signal, candidates);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request, error.code);
        }
        const { messages, system, media } = prepared;
        if (!messages[0].content.trim() && media.length === 0) {
          return badRequest("The 'input' field must contain at least one text message.", 400, request);
        }
        const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? body.reasoning?.effort ?? void 0 };
        let model = candidates[0];
        if (body.stream) {
          let sseEvent = function(eventType, data) {
            return `event: ${eventType}
data: ${JSON.stringify(data)}

`;
          };
          const responseID = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
          const itemID = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
          const now = Math.floor(Date.now() / 1e3);
          const queue = createSseQueue();
          let emitted = false;
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
                  output: []
                }
              })
            );
            let partIndex = 0;
            let accumulatedText = "";
            const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
              client,
              candidate,
              messages,
              system,
              (delta) => {
                emitted = true;
                if (partIndex === 0) {
                  queue.enqueue(
                    sseEvent("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: 0,
                      item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] }
                    })
                  );
                  queue.enqueue(
                    sseEvent("response.content_part.added", {
                      type: "response.content_part.added",
                      item_id: itemID,
                      output_index: 0,
                      content_index: 0,
                      part: { type: "output_text", text: "", annotations: [] }
                    })
                  );
                  partIndex++;
                }
                accumulatedText += delta;
                queue.enqueue(
                  sseEvent("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: itemID,
                    output_index: 0,
                    content_index: 0,
                    delta
                  })
                );
              },
              callerTools,
              requestOptions
            ), () => emitted).then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel;
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                accumulatedText = streamResult.content;
                emitted = true;
                queue.enqueue(sseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemID, type: "message", status: "in_progress", role: "assistant", content: [] } }));
                queue.enqueue(sseEvent("response.content_part.added", { type: "response.content_part.added", item_id: itemID, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
                queue.enqueue(sseEvent("response.output_text.delta", { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: accumulatedText }));
                partIndex = 1;
              }
              const toolCalls = streamResult.toolCalls ?? [];
              if (toolCalls.length > 0) {
                toolCalls.forEach((call, index) => {
                  const args = JSON.stringify(call.arguments ?? {});
                  const callItemID = `fc_${crypto.randomUUID().replace(/-/g, "")}`;
                  const outputIndex = index;
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
                        arguments: ""
                      }
                    })
                  );
                  queue.enqueue(
                    sseEvent("response.function_call_arguments.delta", {
                      type: "response.function_call_arguments.delta",
                      item_id: callItemID,
                      output_index: outputIndex,
                      delta: args
                    })
                  );
                  queue.enqueue(
                    sseEvent("response.function_call_arguments.done", {
                      type: "response.function_call_arguments.done",
                      item_id: callItemID,
                      output_index: outputIndex,
                      arguments: args
                    })
                  );
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
                        arguments: args
                      }
                    })
                  );
                });
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
                        total_tokens: streamResult.tokens.input + streamResult.tokens.output
                      }
                    }
                  })
                );
                return;
              }
              queue.enqueue(
                sseEvent("response.output_text.done", {
                  type: "response.output_text.done",
                  item_id: itemID,
                  output_index: 0,
                  content_index: 0,
                  text: accumulatedText
                })
              );
              if (partIndex > 0) {
                queue.enqueue(
                  sseEvent("response.content_part.done", {
                    type: "response.content_part.done",
                    item_id: itemID,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: accumulatedText, annotations: [] }
                  })
                );
              }
              queue.enqueue(
                sseEvent("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { id: itemID, type: "message", status: "completed", role: "assistant" }
                })
              );
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
                      total_tokens: streamResult.tokens.input + streamResult.tokens.output
                    }
                  }
                })
              );
            }).catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              await safeLog(client, "error", "Proxy streaming responses call failed", {
                error: errMsg,
                requestedModel: body.model
              });
              queue.enqueue(
                sseEvent("response.failed", {
                  type: "response.failed",
                  response: {
                    id: responseID,
                    object: "response",
                    created_at: now,
                    status: "failed",
                    error: { message: "Upstream request failed.", code: "server_error" }
                  }
                })
              );
            }).finally(() => {
              queue.finish();
            });
            yield* queue.generateChunks();
            await runPromise;
          }
          deferredCleanup = true;
          return sseResponse(commonHeaders(request, config), generateSse(), {
            onCancel: (reason) => context.abort(reason),
            onDone: streamCleanup
          });
        }
        try {
          const executed = await executeWithFallback(candidates, (candidate) => executePrompt(client, body, candidate, messages, system, callerTools, requestOptions));
          model = executed.model;
          return json(createResponsesApiResponse(executed.result, model), 200, {}, request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Proxy responses call failed", {
            error: message,
            requestedModel: body.model
          });
          return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request);
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        let body;
        try {
          body = await readJsonBody(request, config.maxRequestBytes, context.signal);
        } catch (error) {
          return anthropicBadRequest(error.message, error.status ?? 400, request);
        }
        if (!body.model) {
          return anthropicBadRequest("The 'model' field is required.", 400, request);
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return anthropicBadRequest("The 'messages' field must contain at least one message.", 400, request);
        }
        const callerTools = applyAnthropicToolChoice(parseAnthropicTools(body), body.tool_choice);
        let controls;
        try {
          validateUnsupportedControls(body);
          controls = generationControls(body);
        } catch (error) {
          return anthropicBadRequest(error.message, error.status ?? 400, request);
        }
        let candidates;
        try {
          const providerOverride = request.headers.get("x-opencode-provider");
          candidates = await resolveModelCandidates(client, body.model, providerOverride, config.aliases);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Anthropic proxy call failed (model resolve)", { error: message, requestedModel: body.model });
          return anthropicBadRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request);
        }
        let prepared;
        try {
          prepared = await prepareCanonicalRequest(adaptAnthropic(body), config, context.signal, candidates);
        } catch (error) {
          return anthropicBadRequest(error.message, error.status ?? 400, request);
        }
        const { messages, system, media } = prepared;
        if (!messages[0].content.trim() && media.length === 0) {
          return anthropicBadRequest("No text content was found in the supplied messages.", 400, request);
        }
        const requestOptions = { ...options, media, controls, variant: request.headers.get("x-opencode-variant") ?? void 0 };
        let model = candidates[0];
        if (body.stream) {
          let sseEvent = function(eventType, data) {
            return `event: ${eventType}
data: ${JSON.stringify(data)}

`;
          };
          const msgID = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
          const queue = createSseQueue();
          let emitted = false;
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
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            }));
            let textBlockStarted = false;
            const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
              client,
              candidate,
              messages,
              system,
              (delta) => {
                emitted = true;
                if (!textBlockStarted) {
                  queue.enqueue(sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" }
                  }));
                  textBlockStarted = true;
                }
                queue.enqueue(sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: delta }
                }));
              },
              callerTools,
              requestOptions
            ), () => emitted).then(({ result: streamResult, model: selectedModel }) => {
              model = selectedModel;
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true;
                textBlockStarted = true;
                queue.enqueue(sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
                queue.enqueue(sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: streamResult.content } }));
              }
              const toolCalls = streamResult.toolCalls ?? [];
              if (toolCalls.length > 0) {
                if (textBlockStarted) {
                  queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
                }
                const baseIndex = textBlockStarted ? 1 : 0;
                toolCalls.forEach((call, i) => {
                  const blockIndex = baseIndex + i;
                  const argsJson = JSON.stringify(call.arguments ?? {});
                  queue.enqueue(sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "tool_use", id: call.id, name: call.name, input: {} }
                  }));
                  queue.enqueue(sseEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "input_json_delta", partial_json: argsJson }
                  }));
                  queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                });
                queue.enqueue(sseEvent("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "tool_use", stop_sequence: null },
                  usage: { output_tokens: streamResult.tokens.output }
                }));
                queue.enqueue(sseEvent("message_stop", { type: "message_stop" }));
                return;
              }
              if (!textBlockStarted) {
                queue.enqueue(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" }
                }));
              }
              queue.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
              queue.enqueue(sseEvent("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: mapFinishReasonToAnthropic(streamResult.finish),
                  stop_sequence: null
                },
                usage: { output_tokens: streamResult.tokens.output }
              }));
              queue.enqueue(sseEvent("message_stop", { type: "message_stop" }));
            }).catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              await safeLog(client, "error", "Anthropic proxy streaming call failed", { error: errMsg, requestedModel: body.model });
              queue.enqueue(sseEvent("error", { type: "error", error: { type: "api_error", message: "Upstream request failed." } }));
            }).finally(() => {
              queue.finish();
            });
            yield* queue.generateChunks();
            await runPromise;
          }
          deferredCleanup = true;
          return sseResponse(commonHeaders(request, config), generateSse(), {
            onCancel: (reason) => context.abort(reason),
            onDone: streamCleanup
          });
        }
        try {
          const executed = await executeWithFallback(candidates, (candidate) => executePrompt(client, body, candidate, messages, system, callerTools, requestOptions));
          model = executed.model;
          return json(createAnthropicResponse(executed.result, model), 200, {}, request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Anthropic proxy call failed", { error: message, requestedModel: body.model });
          return anthropicInternalError(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request);
        }
      }
      const isGeminiNonStream = request.method === "POST" && url.pathname.endsWith(":generateContent");
      const isGeminiStream = request.method === "POST" && url.pathname.endsWith(":streamGenerateContent");
      if (isGeminiNonStream || isGeminiStream) {
        const geminiModelName = geminiModelFromPath(url.pathname);
        if (!geminiModelName) {
          return badRequest("Could not extract model name from URL.", 400, request);
        }
        let body;
        try {
          body = await readJsonBody(request, config.maxRequestBytes, context.signal);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        if (!Array.isArray(body.contents) || body.contents.length === 0) {
          return badRequest("The 'contents' field must contain at least one item.", 400, request);
        }
        const callerTools = applyGeminiToolChoice(parseGeminiTools(body), body.toolConfig);
        let format;
        let controls;
        try {
          format = structuredFormat(body);
          controls = generationControls(body);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request);
        }
        let candidates;
        try {
          const providerOverride = request.headers.get("x-opencode-provider");
          candidates = await resolveModelCandidates(client, geminiModelName, providerOverride, config.aliases);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Gemini proxy call failed (model resolve)", { error: message, requestedModel: geminiModelName });
          return badRequest(error instanceof ProxyError ? message : "The requested model is unavailable.", error.status ?? 400, request);
        }
        let prepared;
        try {
          prepared = await prepareCanonicalRequest(adaptGemini(body), config, context.signal, candidates);
        } catch (error) {
          return badRequest(error.message, error.status ?? 400, request, error.code);
        }
        const { messages, system, media } = prepared;
        if (!messages[0].content.trim() && media.length === 0) {
          return badRequest("No text content was found in the supplied contents.", 400, request);
        }
        const requestOptions = { ...options, media, format, controls, variant: request.headers.get("x-opencode-variant") ?? void 0 };
        if (isGeminiStream) {
          const queue = createSseQueue();
          let emitted = false;
          async function* generateNdJson() {
            const runPromise = executeStreamingWithFallback(candidates, (candidate) => executePromptStreaming(
              client,
              candidate,
              messages,
              system,
              (delta) => {
                emitted = true;
                const chunk = JSON.stringify(createGeminiResponse(delta, null, null));
                queue.enqueue(chunk + "\n");
              },
              callerTools,
              requestOptions
            ), () => emitted).then(({ result: streamResult }) => {
              if (!emitted && streamResult.content && !(streamResult.toolCalls?.length > 0)) {
                emitted = true;
                queue.enqueue(JSON.stringify(createGeminiResponse(streamResult.content, null, null)) + "\n");
              }
              const toolCalls = streamResult.toolCalls ?? [];
              if (toolCalls.length > 0) {
                queue.enqueue(JSON.stringify(createGeminiResponse("", null, null, toolCalls)) + "\n");
              }
              const finalChunk = JSON.stringify(createGeminiResponse("", streamResult.finish, streamResult.tokens));
              queue.enqueue(finalChunk + "\n");
            }).catch(async (err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              await safeLog(client, "error", "Gemini proxy streaming call failed", { error: errMsg, requestedModel: geminiModelName });
              const errChunk = JSON.stringify({ error: { code: 502, message: "Upstream request failed.", status: "UNAVAILABLE" } });
              queue.enqueue(errChunk + "\n");
            }).finally(() => {
              queue.finish();
            });
            yield* queue.generateChunks();
            await runPromise;
          }
          deferredCleanup = true;
          return streamResponse({
            ...commonHeaders(request, config),
            "content-type": "application/x-ndjson; charset=utf-8"
          }, generateNdJson(), {
            onCancel: (reason) => context.abort(reason),
            onDone: streamCleanup
          });
        }
        try {
          const executed = await executeWithFallback(candidates, (candidate) => executePrompt(client, body, candidate, messages, system, callerTools, requestOptions));
          const result = executed.result;
          const finish = result.completion.data.info?.finish;
          const tokens = result.completion.data.info?.tokens;
          return json(createGeminiResponse(result.content, finish, tokens, result.toolCalls), 200, {}, request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await safeLog(client, "error", "Gemini proxy call failed", { error: message, requestedModel: geminiModelName });
          return badRequest(error instanceof ProxyError ? message : "Upstream request failed.", error.status ?? 502, request);
        }
      }
      return text("Not found", 404, request, config);
    } finally {
      if (!deferredCleanup) {
        releaseSlot();
        context.finish();
        safeLog(client, "info", "Proxy request completed", {
          method: request.method,
          path: url.pathname,
          durationMs: Date.now() - started
        });
      }
    }
  };
  return async (request) => {
    const started = Date.now();
    const response = await handleRequest(request);
    const details = {
      method: request.method,
      pathname: new URL(request.url).pathname,
      status: response.status
    };
    const contentType = response.headers.get("content-type") ?? "";
    const streaming = contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");
    if (streaming && response.body) {
      const reader = response.body.getReader();
      const finish = once(() => getMetrics().recordHttpCompletion({ ...details, durationMs: Date.now() - started }));
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              finish();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            controller.error(error);
            finish();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        }
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    getMetrics().recordHttpCompletion({ ...details, durationMs: Date.now() - started });
    return response;
  };
}
var OpenAIProxyPlugin = async ({ client }) => {
  const state = getState();
  if (state.started) {
    return {};
  }
  const hostname = process.env.OPENCODE_LLM_PROXY_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.OPENCODE_LLM_PROXY_PORT ?? "4010", 10);
  let config;
  try {
    config = loadConfig();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyError("Proxy port must be between 1 and 65535.", 500, "invalid_config");
    const normalizedHost = hostname.replace(/^\[|\]$/g, "");
    const loopback = normalizedHost === "localhost" || normalizedHost === "::1" || normalizedHost.startsWith("127.") || normalizedHost.startsWith("::ffff:127.");
    if (!loopback && config.tokens.length === 0) {
      throw new ProxyError("A bearer token is required when binding beyond loopback.", 500, "invalid_config");
    }
  } catch (error) {
    await safeLog(client, "warn", "OpenAI proxy configuration is invalid", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
  let server;
  try {
    server = Bun.serve({
      hostname,
      port,
      fetch: createProxyFetchHandler(client)
    });
  } catch (error) {
    await safeLog(client, "warn", "OpenAI proxy server failed to start", {
      hostname,
      port,
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
  state.started = true;
  state.server = server;
  await safeLog(client, "info", "OpenAI proxy server started", {
    hostname,
    port,
    protected: Boolean(process.env.OPENCODE_LLM_PROXY_TOKEN)
  });
  return {
    "chat.params": async (input, output) => {
      const controls = getState().generationControls?.get(input.sessionID);
      if (!controls) return;
      if (controls.temperature !== void 0) output.temperature = controls.temperature;
      if (controls.topP !== void 0) output.topP = controls.topP;
      if (controls.topK !== void 0) output.topK = controls.topK;
    }
  };
};
export {
  OpenAIProxyPlugin,
  applyAnthropicToolChoice,
  applyGeminiToolChoice,
  applyOpenAIToolChoice,
  buildPrompt,
  buildSystemPrompt,
  buildToolsMap,
  createProxyFetchHandler,
  createSseQueue,
  extractAssistantText,
  extractGeminiSystemInstruction,
  mapFinishReason,
  mapFinishReasonToAnthropic,
  mapFinishReasonToGemini,
  normalizeAnthropicMessages,
  normalizeAnthropicSystem,
  normalizeGeminiContents,
  normalizeMessages,
  normalizeResponseInput,
  parseAnthropicTools,
  parseGeminiTools,
  parseOpenAITools,
  registerToolBridge,
  releaseToolBridge,
  resolveModel,
  sanitizeToolName,
  toTextContent
};

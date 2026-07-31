import http from "node:http"
import https from "node:https"
import dns from "node:dns/promises"
import net from "node:net"
import { Buffer } from "node:buffer"

export const DEFAULT_ACCEPTED_MIME_TYPES = Object.freeze([
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
  "application/pdf",
])

export const REMOTE_MEDIA_DEFAULTS = Object.freeze({
  enabled: false,
  allowedSchemes: Object.freeze(["https"]),
  acceptedMimeTypes: DEFAULT_ACCEPTED_MIME_TYPES,
  maxBytes: 10 * 1024 * 1024,
  maxItems: 4,
  maxTotalItems: 64,
  maxRedirects: 3,
  timeoutMs: 15_000,
})

export class MediaError extends Error {
  constructor(message, status = 400, code = "invalid_media") {
    super(message)
    this.name = "MediaError"
    this.status = status
    this.code = code
  }
}

function fail(message, status, code) {
  return new MediaError(message, status, code)
}

function parseIPv4(address) {
  if (net.isIP(address) !== 4) return null
  const bytes = address.split(".").map(Number)
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? Uint8Array.from(bytes)
    : null
}

function parseIPv6(address) {
  if (typeof address !== "string" || address.includes("%") || net.isIP(address) !== 6) return null
  let input = address.toLowerCase()
  const embeddedAt = input.lastIndexOf(":")
  if (input.includes(".")) {
    const ipv4 = parseIPv4(input.slice(embeddedAt + 1))
    if (!ipv4) return null
    input = `${input.slice(0, embeddedAt)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
  }

  const halves = input.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const words = [...left, ...Array(missing).fill("0"), ...right]
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null
  const bytes = new Uint8Array(16)
  words.forEach((word, index) => {
    const value = Number.parseInt(word, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 255
  })
  return bytes
}

export function parseIPAddress(address) {
  const ipv4 = parseIPv4(address)
  if (ipv4) return { family: 4, bytes: ipv4 }
  const ipv6 = parseIPv6(address)
  return ipv6 ? { family: 6, bytes: ipv6 } : null
}

function matchesPrefix(bytes, prefix, bits) {
  const whole = Math.floor(bits / 8)
  const remainder = bits % 8
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  if (!remainder) return true
  const mask = (255 << (8 - remainder)) & 255
  return (bytes[whole] & mask) === (prefix[whole] & mask)
}

export function addressInPrefix(address, cidr) {
  const [prefixAddress, rawBits] = String(cidr).split("/")
  const addressValue = parseIPAddress(address)
  const prefixValue = parseIPAddress(prefixAddress)
  const bits = Number(rawBits)
  return Boolean(addressValue && prefixValue && addressValue.family === prefixValue.family
    && Number.isInteger(bits) && bits >= 0 && bits <= addressValue.bytes.length * 8
    && matchesPrefix(addressValue.bytes, prefixValue.bytes, bits))
}

const BLOCKED_IPV4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
]

const BLOCKED_IPV6 = [
  "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:2::/48",
  "2001:10::/28", "2001:20::/28", "2001:db8::/32", "2002::/16", "3fff::/20", "5f00::/16",
  "fc00::/7", "fe80::/10", "ff00::/8",
]

function mappedIPv4(parsed) {
  if (parsed.family !== 6) return null
  const bytes = parsed.bytes
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255
  return mapped ? `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}` : null
}

export function isPublicIPAddress(address) {
  const parsed = parseIPAddress(address)
  if (!parsed) return false
  const mapped = mappedIPv4(parsed)
  if (mapped) return isPublicIPAddress(mapped)
  const ranges = parsed.family === 4 ? BLOCKED_IPV4 : BLOCKED_IPV6
  return !ranges.some((cidr) => addressInPrefix(address, cidr))
}

function configuredSchemes(config) {
  const schemes = config.allowedSchemes ?? REMOTE_MEDIA_DEFAULTS.allowedSchemes
  if (!Array.isArray(schemes) || schemes.length === 0) throw fail("Remote media configuration is invalid.", 500, "invalid_config")
  const normalized = schemes.map((scheme) => `${String(scheme).toLowerCase().replace(/:$/, "")}:`)
  if (normalized.some((scheme) => scheme !== "http:" && scheme !== "https:")) {
    throw fail("Remote media configuration is invalid.", 500, "invalid_config")
  }
  return normalized
}

export function validateRemoteUrl(value, config = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw fail("Remote media URL is invalid.", 400, "invalid_media_url")
  }
  if (!configuredSchemes(config).includes(url.protocol)) throw fail("Remote media URL scheme is not allowed.", 400, "invalid_media_url")
  if (url.username || url.password) throw fail("Remote media URL credentials are not allowed.", 400, "invalid_media_url")
  if (!url.hostname) throw fail("Remote media URL is invalid.", 400, "invalid_media_url")
  return url
}

function hostnameOf(url) {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
}

export async function resolvePublicHost(hostname, lookup = dns.lookup) {
  const literal = parseIPAddress(hostname)
  const answers = literal
    ? [{ address: hostname, family: literal.family }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!Array.isArray(answers) || answers.length === 0) throw fail("Remote media host could not be resolved.", 502, "media_fetch_failed")
  const normalized = answers.map((answer) => ({ address: answer.address, family: Number(answer.family) || net.isIP(answer.address) }))
  if (normalized.some((answer) => !parseIPAddress(answer.address) || !isPublicIPAddress(answer.address))) {
    throw fail("Remote media host is not public.", 400, "blocked_media_host")
  }
  return normalized
}

function sameAddress(left, right) {
  const a = parseIPAddress(left)
  const b = parseIPAddress(right)
  if (!a || !b) return false
  const aMapped = mappedIPv4(a)
  const bMapped = mappedIPv4(b)
  if (aMapped || bMapped) return sameAddress(aMapped ?? left, bMapped ?? right)
  return a.family === b.family && a.bytes.every((byte, index) => byte === b.bytes[index])
}

function metric(metrics, name, value = 1) {
  if (!metrics) return
  if (typeof metrics.increment === "function") metrics.increment(name, value)
  else if (typeof metrics === "function") metrics(name, value)
  else metrics[name] = (Number(metrics[name]) || 0) + value
}

function integerOption(config, name, fallback, minimum = 0) {
  const value = config[name] ?? fallback
  if (!Number.isSafeInteger(value) || value < minimum) throw fail("Remote media configuration is invalid.", 500, "invalid_config")
  return value
}

function acceptedMime(contentType, configured) {
  const mime = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase()
  const accepted = configured ?? REMOTE_MEDIA_DEFAULTS.acceptedMimeTypes
  if (!Array.isArray(accepted) || !accepted.every((entry) => typeof entry === "string")) {
    throw fail("Remote media configuration is invalid.", 500, "invalid_config")
  }
  const allowed = accepted.some((entry) => {
    const pattern = entry.toLowerCase()
    return pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern
  })
  if (!mime || !allowed) throw fail("Remote media type is not supported.", 415, "unsupported_media_type")
  return mime
}

function header(response, name) {
  const value = response.headers?.[name]
  return Array.isArray(value) ? value.join(",") : value
}

function abortError(state) {
  return state.timedOut
    ? fail("Remote media download timed out.", 504, "media_timeout")
    : fail("Remote media download was aborted.", 499, "media_aborted")
}

function abortable(promise, signal, state) {
  if (signal.aborted) return Promise.reject(abortError(state))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(state))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

async function readBody(response, maxBytes, metrics, signal, state) {
  const rawLength = header(response, "content-length")
  if (rawLength !== undefined) {
    if (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > maxBytes) {
      response.destroy?.()
      throw fail("Remote media is too large.", 413, "media_too_large")
    }
  }
  const chunks = []
  let total = 0
  const onAbort = () => response.destroy?.(abortError(state))
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > maxBytes) {
        response.destroy?.()
        throw fail("Remote media is too large.", 413, "media_too_large")
      }
      chunks.push(bytes)
    }
  } catch (error) {
    if (error instanceof MediaError) throw error
    throw fail("Remote media could not be downloaded.", 502, "media_fetch_failed")
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  metric(metrics, "remoteMediaBytes", total)
  return Buffer.concat(chunks, total)
}

function responseFor(url, pin, signal, config, state) {
  const dependencies = config.dependencies ?? {}
  const request = url.protocol === "https:"
    ? dependencies.httpsRequest ?? https.request
    : dependencies.httpRequest ?? http.request
  return new Promise((resolve, reject) => {
    let settled = false
    let onAbort
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback(value)
    }
    const pinnedLookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, [pin])
      else callback(null, pin.address, pin.family)
    }
    let req
    try {
      req = request(url, {
        method: "GET",
        agent: false,
        signal,
        lookup: pinnedLookup,
        headers: { accept: "*/*", "accept-encoding": "identity" },
      }, (response) => {
        const remoteAddress = response.socket?.remoteAddress
        if (!remoteAddress || !sameAddress(remoteAddress, pin.address) || !isPublicIPAddress(remoteAddress)) {
          response.destroy?.()
          finish(reject, fail("Remote media connection was rejected.", 400, "blocked_media_host"))
          return
        }
        finish(resolve, response)
      })
    } catch {
      finish(reject, fail("Remote media could not be downloaded.", 502, "media_fetch_failed"))
      return
    }
    req.on("error", (error) => {
      if (error instanceof MediaError) finish(reject, error)
      else if (state.timedOut) finish(reject, fail("Remote media download timed out.", 504, "media_timeout"))
      else if (signal.aborted) finish(reject, fail("Remote media download was aborted.", 499, "media_aborted"))
      else finish(reject, fail("Remote media could not be downloaded.", 502, "media_fetch_failed"))
    })
    onAbort = () => {
      req.destroy?.()
      finish(reject, abortError(state))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        if (!sameAddress(socket.remoteAddress, pin.address) || !isPublicIPAddress(socket.remoteAddress)) {
          req.destroy(fail("Remote media connection was rejected.", 400, "blocked_media_host"))
        }
      })
    })
    req.end()
  })
}

async function download(initialUrl, signal, config, metrics, state) {
  const maxRedirects = integerOption(config, "maxRedirects", REMOTE_MEDIA_DEFAULTS.maxRedirects)
  const maxBytes = integerOption(config, "maxBytes", REMOTE_MEDIA_DEFAULTS.maxBytes, 1)
  const lookup = config.dependencies?.lookup ?? dns.lookup
  let url = initialUrl
  for (let redirects = 0; ; redirects += 1) {
    const answers = await abortable(resolvePublicHost(hostnameOf(url), lookup), signal, state).catch((error) => {
      if (error instanceof MediaError) throw error
      throw fail("Remote media host could not be resolved.", 502, "media_fetch_failed")
    })
    const response = await responseFor(url, answers[0], signal, config, state)
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy?.()
      if (redirects >= maxRedirects || !header(response, "location")) {
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected")
      }
      let next
      try {
        next = validateRemoteUrl(new URL(header(response, "location"), url).href, config)
      } catch (error) {
        if (error instanceof MediaError) throw error
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected")
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw fail("Remote media redirect was rejected.", 502, "media_redirect_rejected")
      }
      metric(metrics, "remoteMediaRedirects")
      url = next
      continue
    }
    if (status < 200 || status >= 300) {
      response.destroy?.()
      throw fail("Remote media server returned an invalid response.", 502, "media_fetch_failed")
    }
    const encoding = String(header(response, "content-encoding") ?? "identity").trim().toLowerCase()
    if (encoding !== "identity") {
      response.destroy?.()
      throw fail("Encoded remote media is not supported.", 415, "unsupported_media_encoding")
    }
    let mime
    try {
      mime = acceptedMime(header(response, "content-type"), config.acceptedMimeTypes)
    } catch (error) {
      response.destroy?.()
      throw error
    }
    const body = await readBody(response, maxBytes, metrics, signal, state)
    return { mime, url: `data:${mime};base64,${body.toString("base64")}` }
  }
}

export async function prepareMedia(media, config = {}, signal, metrics) {
  if (media == null) return []
  if (!Array.isArray(media)) throw fail("Media must be an array.", 400, "invalid_media")
  const maxTotalItems = integerOption(config, "maxTotalItems", REMOTE_MEDIA_DEFAULTS.maxTotalItems)
  if (media.length > maxTotalItems) throw fail("Too many media items.", 413, "too_many_media_items")
  const remote = media.filter((item) => typeof item?.url === "string" && !item.url.startsWith("data:"))
  const maxItems = integerOption(config, "maxItems", REMOTE_MEDIA_DEFAULTS.maxItems)
  if (remote.length > maxItems) throw fail("Too many remote media items.", 413, "too_many_media_items")
  if (media.some((item) => !item || typeof item.url !== "string")) throw fail("Media item is invalid.", 400, "invalid_media")
  if (remote.length && config.enabled !== true) throw fail("Remote media is disabled.", 400, "remote_media_disabled")
  if (!remote.length) return [...media]

  const timeoutMs = integerOption(config, "timeoutMs", REMOTE_MEDIA_DEFAULTS.timeoutMs, 1)
  const dependencies = config.dependencies ?? {}
  const controller = new AbortController()
  const state = { timedOut: false }
  const abortFromParent = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromParent()
  else signal?.addEventListener("abort", abortFromParent, { once: true })
  const timer = (dependencies.setTimeout ?? setTimeout)(() => {
    state.timedOut = true
    controller.abort()
  }, timeoutMs)

  const result = []
  try {
    for (const item of media) {
      if (item.url.startsWith("data:")) {
        result.push(item)
        continue
      }
      metric(metrics, "remoteMediaAttempts")
      const prepared = await download(validateRemoteUrl(item.url, config), controller.signal, config, metrics, state)
      result.push({ ...item, ...prepared })
      metric(metrics, "remoteMediaDownloads")
    }
    return result
  } catch (error) {
    metric(metrics, "remoteMediaFailures")
    if (error instanceof MediaError) throw error
    if (state.timedOut) throw fail("Remote media download timed out.", 504, "media_timeout")
    if (controller.signal.aborted) throw fail("Remote media download was aborted.", 499, "media_aborted")
    throw fail("Remote media could not be downloaded.", 502, "media_fetch_failed")
  } finally {
    (dependencies.clearTimeout ?? clearTimeout)(timer)
    signal?.removeEventListener("abort", abortFromParent)
  }
}

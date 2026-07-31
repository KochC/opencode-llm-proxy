function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function jsonValue(value) {
  return { type: "json", value }
}

function argumentsValue(value) {
  if (typeof value !== "string") return jsonValue(value === undefined ? {} : value)
  try {
    return jsonValue(JSON.parse(value))
  } catch {
    return { type: "raw", value }
  }
}

function textPart(value) {
  return typeof value === "string" ? { type: "text", text: value } : null
}

function mimeFromDataUrl(url, fallback) {
  return typeof url === "string" ? /^data:([^;,]+)/.exec(url)?.[1] ?? fallback : fallback
}

function openAIMediaPart(part) {
  if (part?.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    if (url) return { type: "media", mime: mimeFromDataUrl(url, "image/*"), url }
  }
  if (part?.type === "input_image") {
    const url = part.image_url ?? part.file_data
    if (url) return { type: "media", mime: mimeFromDataUrl(url, "image/*"), url }
  }
  if (part?.type === "input_file") {
    const url = part.file_data ?? part.file_url
    if (url) {
      return {
        type: "media",
        mime: part.mime_type ?? mimeFromDataUrl(url, "application/octet-stream"),
        url,
        ...(part.filename ? { filename: part.filename } : {}),
      }
    }
  }
  return null
}

function openAIContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }]
    const text = textPart(part?.text ?? part?.input_text ?? part?.output_text)
    const media = openAIMediaPart(part)
    return text ? [text] : media ? [media] : []
  })
}

function mediaFromAnthropic(block) {
  if (!block || !["image", "document"].includes(block.type)) return null
  const source = block.source
  if (source?.type === "base64" && source.media_type && source.data) {
    return {
      type: "media",
      mime: source.media_type,
      url: `data:${source.media_type};base64,${source.data}`,
      ...(block.title ? { filename: block.title } : {}),
    }
  }
  if (source?.type === "url" && source.url) {
    return {
      type: "media",
      mime: block.type === "image" ? "image/*" : "application/pdf",
      url: source.url,
      ...(block.title ? { filename: block.title } : {}),
    }
  }
  return null
}

function anthropicResultContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [jsonValue(content)]
  return content.flatMap((block) => {
    const text = block?.type === "text" ? textPart(block.text) : null
    const media = mediaFromAnthropic(block)
    return text ? [text] : media ? [media] : []
  })
}

function geminiMediaPart(part) {
  const inline = part?.inlineData ?? part?.inline_data
  const file = part?.fileData ?? part?.file_data
  const inlineMime = inline?.mimeType ?? inline?.mime_type
  const fileMime = file?.mimeType ?? file?.mime_type
  const fileUri = file?.fileUri ?? file?.file_uri
  if (inlineMime && inline?.data) {
    return { type: "media", mime: inlineMime, url: `data:${inlineMime};base64,${inline.data}` }
  }
  if (fileMime && fileUri) return { type: "media", mime: fileMime, url: fileUri }
  return null
}

function canonical(messages) {
  return { messages }
}

export function adaptOpenAIChat(input) {
  const messages = Array.isArray(input) ? input : input?.messages
  if (!Array.isArray(messages)) return canonical([])
  return canonical(messages.flatMap((message) => {
    if (!isObject(message) || typeof message.role !== "string") return []
    const content = openAIContent(message.content)
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function ?? call
        content.push({
          type: "tool_call",
          ...(call?.id ? { id: call.id } : {}),
          name: fn?.name ?? "",
          arguments: argumentsValue(fn?.arguments ?? ""),
        })
      }
      if (message.function_call) {
        content.push({
          type: "tool_call",
          name: message.function_call.name ?? "",
          arguments: argumentsValue(message.function_call.arguments ?? ""),
        })
      }
    }
    if (message.role === "tool" || message.role === "function") {
      return [{
        role: "tool",
        content: [{
          type: "tool_result",
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
          ...(message.name ? { name: message.name } : {}),
          content,
        }],
      }]
    }
    return [{ role: message.role, content }]
  }))
}

export function adaptOpenAIResponses(input) {
  const body = isObject(input) && Object.hasOwn(input, "input") ? input : { input }
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input
  const messages = []
  if (typeof body.instructions === "string") {
    messages.push({ role: "system", content: [{ type: "text", text: body.instructions }] })
  }
  if (!Array.isArray(items)) return canonical(messages)
  for (const item of items) {
    if (!isObject(item)) continue
    if (item.type === "function_call") {
      messages.push({ role: "assistant", content: [{
        type: "tool_call",
        ...(item.call_id ? { id: item.call_id } : item.id ? { id: item.id } : {}),
        name: item.name ?? "",
        arguments: argumentsValue(item.arguments ?? ""),
      }] })
    } else if (item.type === "function_call_output") {
      const output = typeof item.output === "string"
        ? [{ type: "text", text: item.output }]
        : [jsonValue(item.output)]
      messages.push({ role: "tool", content: [{
        type: "tool_result",
        ...(item.call_id ? { id: item.call_id } : {}),
        content: output,
      }] })
    } else {
      messages.push({ role: item.role ?? (item.type === "message" ? "user" : item.type ?? "user"), content: openAIContent(item.content ?? item.input) })
    }
  }
  return canonical(messages)
}

export function adaptAnthropic(input, system) {
  const body = Array.isArray(input) ? { messages: input, system } : input ?? {}
  const messages = []
  const systemContent = typeof body.system === "string"
    ? [{ type: "text", text: body.system }]
    : Array.isArray(body.system)
      ? body.system.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : [])
      : []
  if (systemContent.length) messages.push({ role: "system", content: systemContent })
  for (const message of body.messages ?? []) {
    if (!isObject(message) || typeof message.role !== "string") continue
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    const content = []
    for (const block of blocks ?? []) {
      if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text })
      const media = mediaFromAnthropic(block)
      if (media) content.push(media)
      if (block?.type === "tool_use") {
        content.push({
          type: "tool_call",
          ...(block.id ? { id: block.id } : {}),
          name: block.name ?? "",
          arguments: jsonValue(block.input),
        })
      }
      if (block?.type === "tool_result") {
        content.push({
          type: "tool_result",
          ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
          ...(block.is_error === true ? { error: true } : {}),
          content: anthropicResultContent(block.content),
        })
      }
    }
    const role = content.length > 0 && content.every((part) => part.type === "tool_result")
      ? "tool"
      : message.role
    messages.push({ role, content })
  }
  return canonical(messages)
}

export function adaptGemini(input, systemInstruction) {
  const body = Array.isArray(input) ? { contents: input, systemInstruction } : input ?? {}
  const messages = []
  const instruction = body.systemInstruction ?? body.system_instruction
  if (typeof instruction === "string") {
    messages.push({ role: "system", content: [{ type: "text", text: instruction }] })
  } else if (Array.isArray(instruction?.parts)) {
    messages.push({
      role: "system",
      content: instruction.parts.flatMap((part) => typeof part?.text === "string" ? [{ type: "text", text: part.text }] : []),
    })
  }
  for (const item of body.contents ?? []) {
    if (!isObject(item)) continue
    const content = []
    for (const part of item.parts ?? []) {
      if (typeof part?.text === "string") content.push({ type: "text", text: part.text })
      const media = geminiMediaPart(part)
      if (media) content.push(media)
      const call = part?.functionCall ?? part?.function_call
      if (call) {
        content.push({
          type: "tool_call",
          ...(call.id ? { id: call.id } : {}),
          name: call.name ?? "",
          arguments: jsonValue(call.args),
        })
      }
      const response = part?.functionResponse ?? part?.function_response
      if (response) {
        content.push({
          type: "tool_result",
          ...(response.id ? { id: response.id } : {}),
          ...(response.name ? { name: response.name } : {}),
          content: typeof response.response === "string"
            ? [{ type: "text", text: response.response }]
            : [jsonValue(response.response)],
        })
      }
    }
    const role = content.length > 0 && content.every((part) => part.type === "tool_result")
      ? "tool"
      : item.role === "model" ? "assistant" : item.role ?? "user"
    messages.push({ role, content })
  }
  return canonical(messages)
}

function renderPart(part, media) {
  if (part.type === "media") {
    const fileIndex = media.length
    media.push({
      fileIndex,
      mime: part.mime,
      url: part.url,
      ...(part.filename ? { filename: part.filename } : {}),
    })
    return { type: "file", fileIndex }
  }
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "json") return { type: "json", value: part.value }
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      ...(part.id ? { id: part.id } : {}),
      name: part.name,
      arguments: part.arguments,
    }
  }
  if (part.type === "tool_result") {
    return {
      type: "tool_result",
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...(part.error ? { error: true } : {}),
      content: part.content.map((inner) => renderPart(inner, media)),
    }
  }
  return part
}

export function renderOpenCodePrompt(value) {
  const messages = Array.isArray(value) ? value : value?.messages ?? []
  const systemMessages = messages.filter((message) => message.role === "system" || message.role === "developer")
  const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer")
  const system = systemMessages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
  const media = []
  if (
    conversation.length === 1 &&
    conversation[0].role === "user" &&
    conversation[0].content.length === 1 &&
    conversation[0].content[0].type === "text"
  ) {
    return { system, text: conversation[0].content[0].text, media }
  }
  const transcript = conversation.map((message) => JSON.stringify({
    role: message.role,
    content: message.content.map((part) => renderPart(part, media)),
  })).join("\n")
  const text = [
    "Continue the canonical conversation below as the assistant. Treat each following line as JSON data, preserve role and tool semantics, and produce the next assistant response after the final item.",
    transcript,
  ].join("\n\n")
  return { system, text, media }
}

export const canonicalizeOpenAIChat = adaptOpenAIChat
export const canonicalizeOpenAIResponses = adaptOpenAIResponses
export const canonicalizeAnthropic = adaptAnthropic
export const canonicalizeGemini = adaptGemini
export const renderCanonicalMessages = renderOpenCodePrompt

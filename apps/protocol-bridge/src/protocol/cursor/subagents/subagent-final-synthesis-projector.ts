export interface SubAgentFinalSynthesisMessage {
  role: "user" | "assistant"
  content: unknown
}

export interface ProjectedSubAgentFinalSynthesisMessage {
  role: "user" | "assistant"
  content: string
}

/**
 * Forced sub-agent synthesis is a text-only summarization pass over previous
 * evidence, not a live tool continuation. Convert structured tool blocks into
 * readable transcript text so providers that require active tool definitions for
 * historical toolUse/toolResult blocks receive a plain message history.
 */
export function projectSubAgentFinalSynthesisMessages(
  messages: SubAgentFinalSynthesisMessage[]
): ProjectedSubAgentFinalSynthesisMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: renderSubAgentFinalSynthesisContent(message.content),
  }))
}

function renderSubAgentFinalSynthesisContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return stringifySubAgentSynthesisValue(content)
  }

  const rendered: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) rendered.push(block)
      continue
    }
    if (!block || typeof block !== "object") {
      const value = stringifySubAgentSynthesisValue(block)
      if (value.trim()) rendered.push(value)
      continue
    }

    const record = block as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : ""
    if (type === "text" || type === "input_text") {
      const text = typeof record.text === "string" ? record.text : ""
      if (text.trim()) rendered.push(text)
      continue
    }

    if (type === "tool_use") {
      const id = typeof record.id === "string" ? record.id : ""
      const name = typeof record.name === "string" ? record.name : "tool"
      const input = stringifySubAgentSynthesisValue(record.input ?? {})
      rendered.push(
        `[tool_use] name=${name}${id ? ` id=${id}` : ""}\ninput: ${input}`
      )
      continue
    }

    if (type === "tool_result") {
      const id =
        typeof record.tool_use_id === "string" ? record.tool_use_id : ""
      const status =
        record.is_error === true || record.status === "error"
          ? "error"
          : "success"
      const result = renderSubAgentFinalSynthesisToolResult(record.content)
      rendered.push(
        `[tool_result]${id ? ` id=${id}` : ""} status=${status}\n${result}`
      )
      continue
    }

    if (type === "image" || type === "image_url" || type === "input_image") {
      rendered.push("[image]")
      continue
    }

    const fallback = stringifySubAgentSynthesisValue(record)
    if (fallback.trim()) rendered.push(fallback)
  }

  return rendered.join("\n\n")
}

function renderSubAgentFinalSynthesisToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return stringifySubAgentSynthesisValue(content)
  }

  const parts: string[] = []
  for (const item of content) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item)
      continue
    }
    if (!item || typeof item !== "object") {
      const value = stringifySubAgentSynthesisValue(item)
      if (value.trim()) parts.push(value)
      continue
    }
    const record = item as Record<string, unknown>
    if (typeof record.text === "string") {
      if (record.text.trim()) parts.push(record.text)
    } else {
      const value = stringifySubAgentSynthesisValue(record)
      if (value.trim()) parts.push(value)
    }
  }
  return parts.join("\n")
}

function stringifySubAgentSynthesisValue(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    if (typeof value === "number" || typeof value === "boolean") {
      return `${value}`
    }
    if (typeof value === "bigint") {
      return value.toString()
    }
    if (typeof value === "symbol") {
      return value.description ? `Symbol(${value.description})` : "Symbol()"
    }
    if (typeof value === "function") {
      return `[function ${value.name || "anonymous"}]`
    }
    return "[unserializable value]"
  }
}

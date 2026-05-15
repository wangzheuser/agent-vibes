/**
 * AWS binary Event Stream parser for Kiro responses.
 *
 * AWS encodes streaming generations as a sequence of binary frames:
 *   - 12-byte prelude (total_len, headers_len, prelude CRC)
 *   - headers section (name/value pairs)
 *   - JSON payload
 *   - trailing 4-byte CRC
 *
 * This parser intentionally skips CRC validation (matches the reference
 * Go implementation) and dispatches recognized event types via callbacks.
 */

import type { KiroStreamCallback, KiroToolUse } from "./protocol-types"

interface ToolUseState {
  toolUseId: string
  name: string
  inputBuffer: string
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false })

/**
 * Parse a Node.js readable stream of AWS Event Stream frames and dispatch
 * recognized events to the provided callback bag.
 */
export async function parseKiroEventStream(
  body: ReadableStream<Uint8Array>,
  callback: KiroStreamCallback,
  abortSignal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  let pending = new Uint8Array(0)

  let inputTokens = 0
  let outputTokens = 0
  let totalCredits = 0
  let currentToolUse: ToolUseState | null = null
  let lastAssistantContent = ""
  let lastReasoningContent = ""

  const append = (chunk: Uint8Array): void => {
    if (pending.length === 0) {
      // Copy into a fresh ArrayBuffer-backed view to keep the typed-array
      // generic compatible with concat / slice operations below.
      const copy = new Uint8Array(chunk.length)
      copy.set(chunk, 0)
      pending = copy
      return
    }
    const merged = new Uint8Array(pending.length + chunk.length)
    merged.set(pending, 0)
    merged.set(chunk, pending.length)
    pending = merged
  }

  try {
    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Kiro event stream aborted")
      }

      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value || value.length === 0) {
        continue
      }
      append(value)

      while (pending.length >= 12) {
        const totalLength =
          (pending[0]! << 24) |
          (pending[1]! << 16) |
          (pending[2]! << 8) |
          pending[3]!
        if (!Number.isFinite(totalLength) || totalLength < 16) {
          // Malformed frame — drop the prelude and continue.
          pending = pending.slice(12)
          continue
        }
        if (pending.length < totalLength) {
          // Wait for more bytes.
          break
        }

        const headersLength =
          (pending[4]! << 24) |
          (pending[5]! << 16) |
          (pending[6]! << 8) |
          pending[7]!

        const frame = pending.slice(0, totalLength)
        pending = pending.slice(totalLength)

        const remaining = totalLength - 12
        const msgBuf = frame.subarray(12, 12 + remaining)
        if (headersLength > msgBuf.length - 4) {
          continue
        }

        const eventType = extractEventType(msgBuf.subarray(0, headersLength))
        const payloadBytes = msgBuf.subarray(headersLength, msgBuf.length - 4)
        if (payloadBytes.length === 0) {
          continue
        }

        let event: Record<string, unknown>
        try {
          event = JSON.parse(TEXT_DECODER.decode(payloadBytes)) as Record<
            string,
            unknown
          >
        } catch {
          continue
        }

        ;[inputTokens, outputTokens] = updateTokensFromEvent(
          event,
          inputTokens,
          outputTokens
        )

        switch (eventType) {
          case "assistantResponseEvent": {
            const content = readString(event, "content")
            if (content) {
              const normalized = normalizeChunk(
                content,
                () => lastAssistantContent,
                (next) => {
                  lastAssistantContent = next
                }
              )
              if (normalized && callback.onText) {
                callback.onText(normalized, false)
              }
            }
            break
          }
          case "reasoningContentEvent": {
            const text = readString(event, "text")
            if (text) {
              const normalized = normalizeChunk(
                text,
                () => lastReasoningContent,
                (next) => {
                  lastReasoningContent = next
                }
              )
              if (normalized && callback.onText) {
                callback.onText(normalized, true)
              }
            }
            break
          }
          case "toolUseEvent": {
            currentToolUse = handleToolUseEvent(event, currentToolUse, callback)
            break
          }
          case "meteringEvent": {
            const usage = readNumber(event, "usage")
            if (usage != null) {
              totalCredits += usage
            }
            break
          }
          case "contextUsageEvent": {
            const pct = readNumber(event, "contextUsagePercentage")
            if (pct != null && callback.onContextUsage) {
              callback.onContextUsage(pct)
            }
            break
          }
          default:
            break
        }
      }
    }

    if (callback.onCredits && totalCredits > 0) {
      callback.onCredits(totalCredits)
    }
    if (callback.onComplete) {
      callback.onComplete(inputTokens, outputTokens)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function readString(
  event: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = event[key]
  return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function readNumber(
  event: Record<string, unknown>,
  key: string
): number | undefined {
  const raw = event[key]
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function readTokenNumber(
  m: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    if (!(k in m)) continue
    const v = m[k]
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.trunc(v)
    }
    if (typeof v === "string") {
      const parsed = Number.parseFloat(v)
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed)
      }
    }
  }
  return undefined
}

function collectUsageMaps(
  value: unknown,
  out: Array<Record<string, unknown>>
): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const child of value) {
      collectUsageMaps(child, out)
    }
    return
  }
  if (typeof value !== "object") return

  const obj = value as Record<string, unknown>
  for (const [k, child] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    if (
      (lower === "usage" ||
        lower === "tokenusage" ||
        lower === "token_usage") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      out.push(child as Record<string, unknown>)
    }
    collectUsageMaps(child, out)
  }
}

function updateTokensFromEvent(
  event: Record<string, unknown>,
  currentInputTokens: number,
  currentOutputTokens: number
): [number, number] {
  const candidates: Array<Record<string, unknown>> = [event]
  collectUsageMaps(event, candidates)

  let inputTokens = currentInputTokens
  let outputTokens = currentOutputTokens

  for (const usage of candidates) {
    if (!usage) continue

    const out = readTokenNumber(
      usage,
      "outputTokens",
      "completionTokens",
      "totalOutputTokens",
      "output_tokens",
      "completion_tokens",
      "total_output_tokens"
    )
    if (out != null) {
      outputTokens = out
    }

    const inp = readTokenNumber(
      usage,
      "inputTokens",
      "promptTokens",
      "totalInputTokens",
      "input_tokens",
      "prompt_tokens",
      "total_input_tokens"
    )
    if (inp != null) {
      inputTokens = inp
      continue
    }

    const uncached = readTokenNumber(
      usage,
      "uncachedInputTokens",
      "uncached_input_tokens"
    )
    const cacheRead = readTokenNumber(
      usage,
      "cacheReadInputTokens",
      "cache_read_input_tokens"
    )
    const cacheWrite = readTokenNumber(
      usage,
      "cacheWriteInputTokens",
      "cache_write_input_tokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens"
    )
    const sum = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    if (sum > 0) {
      inputTokens = sum
      continue
    }

    const total = readTokenNumber(usage, "totalTokens", "total_tokens")
    if (total != null && total > 0) {
      let candidateOutput = outputTokens
      const candidateOut = readTokenNumber(
        usage,
        "outputTokens",
        "completionTokens",
        "totalOutputTokens",
        "output_tokens",
        "completion_tokens",
        "total_output_tokens"
      )
      if (candidateOut != null) {
        candidateOutput = candidateOut
      }
      if (total - candidateOutput > 0) {
        inputTokens = total - candidateOutput
      }
    }
  }

  return [inputTokens, outputTokens]
}

function normalizeChunk(
  chunk: string,
  read: () => string,
  write: (next: string) => void
): string {
  if (chunk === "") return ""
  const prev = read()
  if (prev === "") {
    write(chunk)
    return chunk
  }
  if (chunk === prev) {
    return ""
  }
  if (chunk.startsWith(prev)) {
    const delta = chunk.slice(prev.length)
    write(chunk)
    return delta
  }
  if (prev.startsWith(chunk)) {
    return ""
  }

  let maxOverlap = 0
  const maxLen = Math.min(prev.length, chunk.length)
  for (let i = maxLen; i > 0; i--) {
    if (prev.endsWith(chunk.slice(0, i))) {
      maxOverlap = i
      break
    }
  }
  write(chunk)
  return maxOverlap > 0 ? chunk.slice(maxOverlap) : chunk
}

function handleToolUseEvent(
  event: Record<string, unknown>,
  current: ToolUseState | null,
  callback: KiroStreamCallback
): ToolUseState | null {
  const toolUseId = readString(event, "toolUseId")
  const name = readString(event, "name")
  const isStop = event["stop"] === true

  if (toolUseId && name) {
    if (current === null) {
      current = { toolUseId, name, inputBuffer: "" }
    } else if (current.toolUseId !== toolUseId) {
      finishToolUse(current, callback)
      current = { toolUseId, name, inputBuffer: "" }
    }
  }

  if (current) {
    const input = event["input"]
    if (typeof input === "string") {
      current.inputBuffer += input
    } else if (input && typeof input === "object" && !Array.isArray(input)) {
      try {
        current.inputBuffer = JSON.stringify(input)
      } catch {
        // ignore non-serializable input snapshot
      }
    }
  }

  if (isStop && current) {
    finishToolUse(current, callback)
    return null
  }

  return current
}

function finishToolUse(
  state: ToolUseState,
  callback: KiroStreamCallback
): void {
  let parsed: Record<string, unknown> | null = null
  if (state.inputBuffer.length > 0) {
    try {
      const candidate: unknown = JSON.parse(state.inputBuffer)
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      parsed = null
    }
  }
  if (!parsed) parsed = {}

  const tu: KiroToolUse = {
    toolUseId: state.toolUseId,
    name: state.name,
    input: parsed,
  }
  callback.onToolUse?.(tu)
}

/**
 * Read the `:event-type` value out of an AWS Event Stream header section.
 *
 * Header format per byte:
 *   nameLen(u8) | name(bytes) | valueType(u8) | value(...)
 * Recognized value types: 7 = string (u16 length + bytes); 6 = byte-buffer
 * (u16 length + bytes); 0/1 = bool; 2 = u8; 3 = u16; 4 = u32; 5 = u64;
 * 8 = timestamp (u64); 9 = uuid (16 bytes).
 */
function extractEventType(headers: Uint8Array): string {
  let offset = 0
  while (offset < headers.length) {
    if (offset >= headers.length) break
    const nameLen = headers[offset]!
    offset += 1
    if (offset + nameLen > headers.length) break
    const name = TEXT_DECODER.decode(headers.subarray(offset, offset + nameLen))
    offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]!
    offset += 1

    if (valueType === 7) {
      if (offset + 2 > headers.length) break
      const valueLen = (headers[offset]! << 8) | headers[offset + 1]!
      offset += 2
      if (offset + valueLen > headers.length) break
      const value = TEXT_DECODER.decode(
        headers.subarray(offset, offset + valueLen)
      )
      offset += valueLen
      if (name === ":event-type") {
        return value
      }
      continue
    }

    if (valueType === 6) {
      if (offset + 2 > headers.length) break
      const len = (headers[offset]! << 8) | headers[offset + 1]!
      offset += 2 + len
      continue
    }

    const skipSizes: Record<number, number> = {
      0: 0,
      1: 0,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      8: 8,
      9: 16,
    }
    const skip = skipSizes[valueType]
    if (typeof skip !== "number") break
    offset += skip
  }
  return ""
}

/**
 * Anthropic Messages response/SSE → OpenAI Chat Completions response/SSE.
 *
 * The bridge routes every inbound request through MessagesService, whose
 * canonical output is the Anthropic shape:
 *   - non-streaming: AnthropicResponse (content blocks + usage)
 *   - streaming: a sequence of Anthropic SSE strings
 *       (`event: <type>\ndata: <json>\n\n`)
 *
 * This module reverses that into the OpenAI surface so OpenAI SDK clients
 * see native `chat.completion` / `chat.completion.chunk` payloads.
 *
 * Anthropic thinking blocks map to the de-facto `reasoning_content` field
 * used by OpenAI-compatible providers (DeepSeek, one-api, etc.).
 */

import type { AnthropicResponse } from "../../shared/anthropic"
import type {
  OpenAiChatChoice,
  OpenAiChatCompletionChunk,
  OpenAiChatCompletionResponse,
  OpenAiCompletionResponse,
  OpenAiFinishReason,
  OpenAiToolCall,
  OpenAiUsage,
} from "./openai-types"

// ── stop_reason mapping ─────────────────────────────────────────────────

export function mapStopReason(
  stopReason: string | null | undefined,
  hasToolCalls: boolean
): OpenAiFinishReason {
  if (hasToolCalls && (stopReason === "tool_use" || stopReason == null)) {
    return "tool_calls"
  }
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "refusal":
      return "content_filter"
    case null:
    case undefined:
      return "stop"
    default:
      return "stop"
  }
}

function mapUsage(usage: AnthropicResponse["usage"]): OpenAiUsage {
  const promptTokens =
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  const completionTokens = usage.output_tokens || 0
  const result: OpenAiUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
  if (usage.cache_read_input_tokens) {
    result.prompt_tokens_details = {
      cached_tokens: usage.cache_read_input_tokens,
    }
  }
  return result
}

// ── Non-streaming ───────────────────────────────────────────────────────

/**
 * Translate a complete AnthropicResponse into an OpenAI chat.completion.
 */
export function translateAnthropicToOpenAiChat(
  response: AnthropicResponse,
  model: string,
  created: number
): OpenAiChatCompletionResponse {
  let text = ""
  let reasoning = ""
  const toolCalls: OpenAiToolCall[] = []

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text
    } else if (block.type === "thinking") {
      reasoning += block.thinking
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  const finishReason = mapStopReason(response.stop_reason, toolCalls.length > 0)

  const choice: OpenAiChatChoice = {
    index: 0,
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: finishReason,
    logprobs: null,
  }

  return {
    id: response.id || `chatcmpl-${cryptoRandomId()}`,
    object: "chat.completion",
    created,
    model,
    choices: [choice],
    usage: mapUsage(response.usage),
  }
}

/**
 * Translate a complete AnthropicResponse into a legacy text completion.
 */
export function translateAnthropicToOpenAiCompletion(
  response: AnthropicResponse,
  model: string,
  created: number
): OpenAiCompletionResponse {
  let text = ""
  for (const block of response.content) {
    if (block.type === "text") text += block.text
  }
  return {
    id: response.id || `cmpl-${cryptoRandomId()}`,
    object: "text_completion",
    created,
    model,
    choices: [
      {
        index: 0,
        text,
        finish_reason: mapStopReason(response.stop_reason, false),
        logprobs: null,
      },
    ],
    usage: mapUsage(response.usage),
  }
}

// ── Streaming: Anthropic SSE → OpenAI chunk SSE ─────────────────────────

interface AnthropicSseEvent {
  type: string
  index?: number
  delta?: Record<string, unknown>
  content_block?: Record<string, unknown>
  message?: Record<string, unknown>
  usage?: Record<string, unknown>
}

/**
 * Parse a single Anthropic SSE frame (a `data:`-prefixed block) into its
 * decoded event object. Returns null for keep-alive/blank frames or the
 * `[DONE]` sentinel. Shared by the chat and completion stream translators.
 */
function parseSseFrame(frame: string): AnthropicSseEvent | null {
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join("\n")
  if (payload === "[DONE]") return null
  try {
    return JSON.parse(payload) as AnthropicSseEvent
  } catch {
    return null
  }
}

/**
 * Buffers raw Anthropic SSE text and yields decoded events once complete
 * `\n\n`-terminated frames are available. Shared by stream translators that
 * don't need bespoke buffering logic.
 */
class AnthropicSseFrameBuffer {
  private buffer = ""

  push(raw: string): AnthropicSseEvent[] {
    this.buffer += raw
    const events: AnthropicSseEvent[] = []
    let sepIndex: number
    while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, sepIndex)
      this.buffer = this.buffer.slice(sepIndex + 2)
      const event = parseSseFrame(frame)
      if (event) events.push(event)
    }
    return events
  }
}

/**
 * Stateful translator that consumes raw Anthropic SSE text and emits OpenAI
 * chat.completion.chunk SSE strings. Feed each upstream string chunk to
 * `push()`, then call `finish()` once the upstream generator completes.
 */
export class OpenAiChatStreamTranslator {
  private buffer = ""
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private readonly includeUsage: boolean

  private sentRole = false
  private finishReason: OpenAiFinishReason = null
  private hasToolCalls = false
  // Maps Anthropic content-block index → OpenAI tool_call index.
  private toolBlockToIndex = new Map<number, number>()
  private nextToolIndex = 0
  // Tracks the type of each open block so deltas route correctly.
  private blockTypes = new Map<number, string>()
  private usage: OpenAiUsage | null = null

  constructor(opts: {
    id: string
    created: number
    model: string
    includeUsage: boolean
  }) {
    this.id = opts.id
    this.created = opts.created
    this.model = opts.model
    this.includeUsage = opts.includeUsage
  }

  /**
   * Parse a raw Anthropic SSE text chunk and return any OpenAI SSE strings
   * that should be flushed to the client.
   */
  push(raw: string): string[] {
    this.buffer += raw
    const out: string[] = []
    // SSE frames are separated by a blank line.
    let sepIndex: number
    while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, sepIndex)
      this.buffer = this.buffer.slice(sepIndex + 2)
      const event = parseSseFrame(frame)
      if (event) out.push(...this.handleEvent(event))
    }
    return out
  }

  private handleEvent(event: AnthropicSseEvent): string[] {
    switch (event.type) {
      case "content_block_start":
        return this.handleBlockStart(event)
      case "content_block_delta":
        return this.handleBlockDelta(event)
      case "message_delta":
        return this.handleMessageDelta(event)
      case "error":
        // Surface upstream mid-stream errors as a terminating chunk; the
        // controller-level error writer handles pre-stream failures.
        return []
      default:
        // message_start / content_block_stop / message_stop / ping → no
        // direct OpenAI chunk; finish() emits the terminal frame.
        return []
    }
  }

  private handleBlockStart(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const block = event.content_block ?? {}
    const blockType = (block.type as string) || "text"
    this.blockTypes.set(index, blockType)

    if (blockType === "tool_use") {
      this.hasToolCalls = true
      const toolIndex = this.nextToolIndex++
      this.toolBlockToIndex.set(index, toolIndex)
      const toolCall: OpenAiToolCall = {
        index: toolIndex,
        id: (block.id as string) || "",
        type: "function",
        function: {
          name: (block.name as string) || "",
          arguments: "",
        },
      }
      return [this.chunk({ tool_calls: [toolCall] })]
    }
    return []
  }

  private handleBlockDelta(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const delta = event.delta ?? {}
    const deltaType = delta.type as string

    if (deltaType === "text_delta") {
      const text = (delta.text as string) || ""
      if (!text) return []
      return [this.chunk({ content: text })]
    }
    if (deltaType === "thinking_delta") {
      const thinking = (delta.thinking as string) || ""
      if (!thinking) return []
      return [this.chunk({ reasoning_content: thinking })]
    }
    if (deltaType === "input_json_delta") {
      const partial = (delta.partial_json as string) || ""
      const toolIndex = this.toolBlockToIndex.get(index)
      if (toolIndex == null) return []
      const toolCall: OpenAiToolCall = {
        index: toolIndex,
        id: "",
        type: "function",
        function: { name: "", arguments: partial },
      }
      return [this.chunk({ tool_calls: [toolCall] })]
    }
    return []
  }

  private handleMessageDelta(event: AnthropicSseEvent): string[] {
    const delta = event.delta ?? {}
    const stopReason = delta.stop_reason as string | null | undefined
    if (stopReason !== undefined) {
      this.finishReason = mapStopReason(stopReason, this.hasToolCalls)
    }
    if (this.includeUsage && event.usage) {
      const outputTokens = (event.usage.output_tokens as number) || 0
      const inputTokens = (event.usage.input_tokens as number) || 0
      this.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      }
    }
    return []
  }

  /**
   * Emit the terminal chunk (with finish_reason), an optional usage-only
   * chunk, and the `[DONE]` sentinel.
   */
  finish(): string[] {
    const out: string[] = []
    const finishReason = this.finishReason ?? "stop"
    out.push(this.terminalChunk(finishReason))
    if (this.includeUsage) {
      out.push(this.usageChunk())
    }
    out.push("data: [DONE]\n\n")
    return out
  }

  // ── chunk builders ────────────────────────────────────────────────────

  private chunk(delta: {
    content?: string
    reasoning_content?: string
    tool_calls?: OpenAiToolCall[]
  }): string {
    const deltaObj: Record<string, unknown> = {}
    if (!this.sentRole) {
      deltaObj.role = "assistant"
      this.sentRole = true
    }
    if (delta.content !== undefined) deltaObj.content = delta.content
    if (delta.reasoning_content !== undefined) {
      deltaObj.reasoning_content = delta.reasoning_content
    }
    if (delta.tool_calls !== undefined) deltaObj.tool_calls = delta.tool_calls

    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, delta: deltaObj, finish_reason: null, logprobs: null },
      ],
    }
    return formatOpenAiSse(chunk)
  }

  private terminalChunk(finishReason: OpenAiFinishReason): string {
    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, delta: {}, finish_reason: finishReason, logprobs: null },
      ],
      ...(this.includeUsage ? { usage: null } : {}),
    }
    return formatOpenAiSse(chunk)
  }

  private usageChunk(): string {
    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [],
      usage: this.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }
    return formatOpenAiSse(chunk)
  }
}

/**
 * Stateful translator for the legacy `/v1/completions` streaming surface.
 * Only text deltas are surfaced (thinking/tool_use blocks have no place in
 * the legacy text-completion schema). Emits `text_completion` chunks.
 */
export class OpenAiCompletionStreamTranslator {
  private readonly frames = new AnthropicSseFrameBuffer()
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private finishReason: OpenAiFinishReason = null

  constructor(opts: { id: string; created: number; model: string }) {
    this.id = opts.id
    this.created = opts.created
    this.model = opts.model
  }

  push(raw: string): string[] {
    const out: string[] = []
    for (const event of this.frames.push(raw)) {
      if (event.type === "content_block_delta") {
        const delta = event.delta ?? {}
        if ((delta.type as string) === "text_delta") {
          const text = (delta.text as string) || ""
          if (text) out.push(this.chunk(text, null))
        }
      } else if (event.type === "message_delta") {
        const stopReason = (event.delta ?? {}).stop_reason as
          | string
          | null
          | undefined
        if (stopReason !== undefined) {
          this.finishReason = mapStopReason(stopReason, false)
        }
      }
    }
    return out
  }

  finish(): string[] {
    return [this.chunk("", this.finishReason ?? "stop"), "data: [DONE]\n\n"]
  }

  private chunk(text: string, finishReason: OpenAiFinishReason): string {
    return formatOpenAiSse({
      id: this.id,
      object: "text_completion",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, text, finish_reason: finishReason, logprobs: null },
      ],
    })
  }
}

function formatOpenAiSse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 12)
}

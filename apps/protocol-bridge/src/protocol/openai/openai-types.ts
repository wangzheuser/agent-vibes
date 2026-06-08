/**
 * OpenAI Chat Completions / Completions wire types.
 *
 * These describe the *inbound* OpenAI-compatible protocol surface the
 * bridge exposes at `/v1/chat/completions` and `/v1/completions`. They are
 * deliberately permissive (extra fields allowed via index signatures) so
 * unknown client params don't break parsing — the translator only reads the
 * fields it understands and forwards the rest as no-ops.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat
 */

// ── Chat Completions: request ───────────────────────────────────────────

export interface OpenAiTextPart {
  type: "text"
  text: string
}

export interface OpenAiImagePart {
  type: "image_url"
  image_url: { url: string; detail?: string }
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart

export interface OpenAiToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
  /** Present only inside streaming deltas. */
  index?: number
}

export interface OpenAiChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool"
  content?: string | OpenAiContentPart[] | null
  name?: string
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

export interface OpenAiFunctionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type OpenAiToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }

export interface OpenAiStreamOptions {
  include_usage?: boolean
}

export interface OpenAiChatCompletionRequest {
  model: string
  messages: OpenAiChatMessage[]
  tools?: OpenAiFunctionTool[]
  tool_choice?: OpenAiToolChoice
  stream?: boolean
  stream_options?: OpenAiStreamOptions
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stop?: string | string[]
  reasoning_effort?: string
  response_format?: { type: string; [key: string]: unknown }
  [key: string]: unknown
}

// ── Chat Completions: response ──────────────────────────────────────────

export interface OpenAiResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_content?: string
  tool_calls?: OpenAiToolCall[]
}

export type OpenAiFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null

export interface OpenAiChatChoice {
  index: number
  message: OpenAiResponseMessage
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface OpenAiChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: OpenAiChatChoice[]
  usage: OpenAiUsage
}

// ── Chat Completions: streaming chunk ───────────────────────────────────

export interface OpenAiChatDelta {
  role?: "assistant"
  content?: string | null
  reasoning_content?: string
  tool_calls?: OpenAiToolCall[]
}

export interface OpenAiChatChunkChoice {
  index: number
  delta: OpenAiChatDelta
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: OpenAiChatChunkChoice[]
  usage?: OpenAiUsage | null
}

// ── Legacy Completions (text) ───────────────────────────────────────────

export interface OpenAiCompletionRequest {
  model: string
  prompt: string | string[]
  stream?: boolean
  stream_options?: OpenAiStreamOptions
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  [key: string]: unknown
}

export interface OpenAiCompletionChoice {
  index: number
  text: string
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiCompletionResponse {
  id: string
  object: "text_completion"
  created: number
  model: string
  choices: OpenAiCompletionChoice[]
  usage: OpenAiUsage
}

export interface OpenAiCompletionChunk {
  id: string
  object: "text_completion"
  created: number
  model: string
  choices: Array<{
    index: number
    text: string
    finish_reason: OpenAiFinishReason
    logprobs: null
  }>
  usage?: OpenAiUsage | null
}

// ── Error envelope ──────────────────────────────────────────────────────

export interface OpenAiErrorEnvelope {
  error: {
    message: string
    type: string
    param: string | null
    code: string | null
  }
}

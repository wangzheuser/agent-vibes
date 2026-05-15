/**
 * Content block types in Anthropic responses
 */
export interface TextBlock {
  type: "text"
  text: string
  citations?: Array<Record<string, unknown>>
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock

/**
 * Anthropic-compatible response type
 * Used by backend services that emit Anthropic-compatible responses.
 */
export interface AnthropicResponse {
  id: string
  type: string
  role: string
  content: ContentBlock[]
  model: string
  stop_reason: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation?: {
      ephemeral_5m_input_tokens?: number
      ephemeral_1h_input_tokens?: number
    }
  }
}

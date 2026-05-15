/**
 * Kiro / AWS CodeWhisperer protocol types.
 *
 * Mirrors the request/response shapes accepted by the Kiro IDE backend
 * (`q.us-east-1.amazonaws.com/generateAssistantResponse` and the
 * `codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse` mirror).
 *
 * The Go reference implementation is at
 * https://github.com/Quorinex/Kiro-Go (proxy/kiro.go).
 */

export interface KiroImageSource {
  bytes: string
}

export interface KiroImage {
  format: string
  source: KiroImageSource
}

export interface KiroToolInputSchema {
  json: unknown
}

export interface KiroToolWrapper {
  toolSpecification: {
    name: string
    description: string
    inputSchema: KiroToolInputSchema
  }
}

export interface KiroResultContent {
  text: string
}

export interface KiroToolResult {
  toolUseId: string
  content: KiroResultContent[]
  status: "success" | "error"
}

export interface KiroUserInputMessageContext {
  tools?: KiroToolWrapper[]
  toolResults?: KiroToolResult[]
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string
  origin?: string
  images?: KiroImage[]
  userInputMessageContext?: KiroUserInputMessageContext
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroAssistantResponseMessage {
  content: string
  toolUses?: KiroToolUse[]
}

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroInferenceConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
}

export interface KiroConversationState {
  agentContinuationId?: string
  agentTaskType?: string
  /**
   * 抓包验证（KiroIDE 0.12.200）：必填，固定 "MANUAL"。
   */
  chatTriggerType: string
  /**
   * 抓包验证（KiroIDE 0.12.200）：必填，UUID。同一会话连续请求复用同一个 ID。
   */
  conversationId: string
  currentMessage: {
    userInputMessage: KiroUserInputMessage
  }
  history?: KiroHistoryMessage[]
}

export interface KiroPayload {
  conversationState: KiroConversationState
  profileArn?: string
  inferenceConfig?: KiroInferenceConfig
}

/** Streaming callback bag used by the event-stream parser. */
export interface KiroStreamCallback {
  onText?: (text: string, isThinking: boolean) => void
  onToolUse?: (toolUse: KiroToolUse) => void
  onComplete?: (inputTokens: number, outputTokens: number) => void
  onError?: (err: Error) => void
  onCredits?: (credits: number) => void
  onContextUsage?: (percentage: number) => void
}

/** Endpoint descriptor used for sequential fallback. */
export interface KiroEndpoint {
  url: string
  origin: string
  amzTarget: string
  name: string
}

export const KIRO_ENDPOINTS: readonly KiroEndpoint[] = [
  {
    url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    origin: "AI_EDITOR",
    amzTarget: "",
    name: "Kiro IDE",
  },
  {
    url: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    origin: "AI_EDITOR",
    amzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    name: "CodeWhisperer",
  },
  {
    url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    origin: "AI_EDITOR",
    amzTarget: "AmazonQDeveloperStreamingService.SendMessage",
    name: "AmazonQ",
  },
]

export const KIRO_REST_API_BASE =
  "https://codewhisperer.us-east-1.amazonaws.com"

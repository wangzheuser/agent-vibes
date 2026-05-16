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

/**
 * License attribution for a single span of generated content.
 *
 * Surfaced via `codeReferenceEvent`. Amazon CodeWhisperer's commercial
 * terms require Q Developer / Kiro clients to display these references
 * when the model emits content matching public training corpora. We pass
 * them upstream as opaque metadata; the proxy layer is responsible for
 * deciding whether/how to render them.
 */
export interface KiroCodeReference {
  licenseName?: string
  repository?: string
  url?: string
  information?: string
  recommendationContentSpan?: {
    start?: number
    end?: number
  }
}

/** Streaming callback bag used by the event-stream parser. */
export interface KiroStreamCallback {
  onText?: (text: string, isThinking: boolean) => void
  onToolUse?: (toolUse: KiroToolUse) => void
  onComplete?: (inputTokens: number, outputTokens: number) => void
  /**
   * Called when the AWS event stream surfaces an in-band error
   * (`error`, `invalidStateEvent`). Without this hook those frames are
   * silently dropped and the user just sees a truncated reply with
   * no feedback. Note that out-of-band HTTP errors (4xx/5xx before the
   * stream starts) are NOT routed here — they throw from `callKiro`.
   */
  onError?: (err: Error) => void
  onCredits?: (credits: number) => void
  onContextUsage?: (percentage: number) => void
  /**
   * Called when the model emits a `codeReferenceEvent`. Caller decides
   * whether to surface license attribution to the user (Q Developer
   * commercial terms require display when references are emitted).
   */
  onCodeReferences?: (references: KiroCodeReference[]) => void
}

/** Endpoint descriptor used for sequential fallback. */
export interface KiroEndpoint {
  url: string
  origin: string
  amzTarget: string
  name: string
}

/**
 * Kiro IDE / AWS CodeWhisperer streaming endpoints.
 *
 * Verified against the official Kiro client (`Kiro.app/.../extension.js`):
 *   - The client always uses `https://q.us-east-1.amazonaws.com` as the
 *     primary streaming endpoint and never falls back to a `codewhisperer`
 *     hostname (see `awsCommercialConfigs` and `endpoint:` constants).
 *   - The X-Amz-Target header is set by the AWS SDK only when calling
 *     `codewhisperer.us-east-1.amazonaws.com`; against the `q.` host the SDK
 *     omits it (also confirmed by `kiro_traffic.log` capture).
 *   - The valid amzTarget for the streaming `GenerateAssistantResponse`
 *     command is `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`.
 *     The previous third entry (`AmazonQDeveloperStreamingService.SendMessage`)
 *     was wrong on two counts: the namespace is `AmazonCodeWhispererStreamingService`
 *     (not `AmazonQDeveloperStreamingService`), and `SendMessage` accepts a
 *     different request schema than `generateAssistantResponse` so reusing
 *     the same payload would 400. That entry has been removed.
 */
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
]

export const KIRO_REST_API_BASE =
  "https://codewhisperer.us-east-1.amazonaws.com"

/**
 * Unified History Management Types
 *
 * This module defines unified message types used by the proxy,
 * supporting both content-block tool calls and function-call style fields.
 */

/**
 * Text content block
 */
export interface TextBlock {
  type: "text"
  text: string
}

/**
 * Tool use content block (Anthropic format)
 * Represents an AI request to use a tool
 */
export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Tool result content block (Anthropic format)
 * Represents the result of a tool execution
 */
export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
  structuredContent?: Record<string, unknown>
}

/**
 * Image content block
 */
export interface ImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

/**
 * Thinking content block (Claude extended thinking)
 */
export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

/**
 * All possible content block types
 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | ThinkingBlock

/**
 * Function-call style tool call
 */
export interface FunctionToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type LooseMessageContent =
  | string
  | ContentBlock[]
  | Array<{ type: string; [key: string]: unknown }>

/**
 * Unified message format
 * Supports both content-block and function-call style formats.
 */
export interface UnifiedMessage {
  role: "system" | "user" | "assistant"
  content: string | ContentBlock[]

  // Function-call style tool calls (assistant messages)
  tool_calls?: FunctionToolCall[]

  // Function-call style tool result reference (tool role messages)
  tool_call_id?: string

  // Metadata
  token_count?: number
  created_at?: number
}

/**
 * Tool pair for integrity checking
 */
export interface ToolPair {
  tool_use_id: string
  tool_use_message_index: number
  tool_result_message_index: number | null
  tool_name: string
}

export interface ContextUsageSnapshot {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  totalTokens: number
  recordedAt: number
}

export interface ContextTranscriptRecord {
  id: string
  role: "user" | "assistant"
  content: LooseMessageContent
  createdAt: number
}

export interface ContextProjectionAttachment {
  kind:
    | "sub_agent"
    | "read_paths"
    | "file_states"
    | "file_snapshots"
    | "todos"
    | "investigation_memory"
  label: string
  content: string
  tokenCount: number
}

/**
 * One entry in the compaction history chain.
 *
 * **Scope contract** (compared to claude-code):
 *
 *   claude-code distinguishes two boundary types in its message stream:
 *   `compact_boundary` (heavy summary compaction, like our commit) and
 *   `microcompact_boundary` (lightweight tool-result clearing, with
 *   `compactedToolIds[]` recorded on the boundary message).  This shape
 *   only models the heavy variant — microcompact in our pipeline rewrites
 *   tool_result blocks in place via `recordsOverride` and a persisted
 *   replacement dictionary, without producing a commit.
 *
 *   That split is intentional: heavy compaction is irreversible and
 *   needs a permanent audit trail; microcompact is a per-request
 *   rendering optimisation whose state lives in
 *   `ContextToolResultReplacementState`.  Both states are reset together
 *   when a heavy commit is applied (see
 *   `ContextCompactionService.pruneArchivedDerivedState`).
 */
export interface ContextCompactionCommit {
  id: string
  strategy: "auto" | "manual" | "reactive"
  createdAt: number
  epoch?: number
  parentCompactionId?: string
  archivedThroughRecordId: string
  projectionAnchorRecordId?: string
  archivedMessageCount: number
  sourceRecordCount?: number
  attachmentFingerprint?: string
  sourceTokenCount: number
  summary: string
  summaryTokenCount: number
  projectedTokenCount: number
}

export interface ContextUsageLedgerState {
  anchorRecordId?: string
  lastUsage?: ContextUsageSnapshot
  projectedTokenCount?: number
  recordedCompactionId?: string
  attachmentFingerprint?: string
}

export interface ContextCompactionBasis {
  recordCount: number
  attachmentFingerprint: string
  appliedAt: number
  compactionId: string
  epoch: number
}

export interface ContextToolResultReplacementState {
  seenToolUseIds: string[]
  replacementByToolUseId: Record<string, string>
}

export interface ContextInvestigationMemoryEntry {
  batchId: string
  label: string
  details: string
  toolCallIds: string[]
  toolCount: number
  readOnly: boolean
  createdAt: number
}

export interface InvestigationMemorySummaryLike {
  label: string
  details: string
  toolCount?: number
  readOnly?: boolean
  createdAt?: number
}

/**
 * Aggregate root for one conversation's context state.
 *
 * **Mutability contract — single-writer**
 *
 * This object is mutated in place by `ContextCompactionService` and
 * related services (records pushed, compaction history appended,
 * investigation memory filtered, replacement state pruned, etc.).  The
 * design only stays sound under a single-writer assumption: at any
 * moment exactly one async task should be calling into the context
 * services for a given state.
 *
 * Two callers in the bridge currently obey this:
 *
 * 1. `cursor-connect-stream.service.ts` serialises requests per session
 *    via `ChatSessionManager` so the writer is the request handler.
 * 2. `anthropic/messages.service.ts` is stateless — every request
 *    creates an ephemeral state via `ContextManagerService`.
 *
 * If you ever introduce a new caller (background composer follow-up,
 * push-driven session updates, etc.), wrap concurrent access in a
 * per-session mutex BEFORE calling any context service.  The state
 * shape is graph-y enough that interleaved mutation will produce
 * silently corrupt projections (commit chain torn, replacement
 * dictionary out of sync with records, etc.) and the test suite
 * cannot catch that because tests run serially by construction.
 *
 * Do not "fix" this by deep-cloning on every read — it would be
 * correct but allocates O(records × rounds) on every request and
 * defeats the ledger's projected-token cache.
 */
export interface ContextConversationState {
  records: ContextTranscriptRecord[]
  compactionHistory: ContextCompactionCommit[]
  activeCompactionId?: string
  compactionEpoch?: number
  lastAppliedCompaction?: ContextCompactionBasis
  usageLedger: ContextUsageLedgerState
  toolResultReplacementState?: ContextToolResultReplacementState
  investigationMemory: ContextInvestigationMemoryEntry[]
}

export interface ProjectedContextMessage {
  role: "user" | "assistant"
  content: LooseMessageContent
  source: "record" | "boundary" | "summary" | "attachment" | "snip"
  recordId?: string
  commitId?: string
  attachmentKind?: ContextProjectionAttachment["kind"]
  compactionEvent?: {
    type: "boundary" | "summary"
    commitId: string
    epoch?: number
    parentCompactionId?: string
    archivedThroughRecordId?: string
    summaryTokenCount?: number
    sourceTokenCount?: number
    projectedTokenCount?: number
  }
}

/**
 * Helper type guard for TextBlock
 */
export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text"
}

/**
 * Helper type guard for ToolUseBlock
 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use"
}

/**
 * Helper type guard for ToolResultBlock
 */
export function isToolResultBlock(
  block: ContentBlock
): block is ToolResultBlock {
  return block.type === "tool_result"
}

/**
 * Helper type guard for ImageBlock
 */
export function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image"
}

/**
 * Helper type guard for ThinkingBlock
 */
export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === "thinking"
}

/**
 * Parse content that may be a JSON string or array
 * Returns null if parsing fails or content is not array-like
 */
export function parseContent(content: unknown): ContentBlock[] | null {
  // Already an array
  if (Array.isArray(content)) {
    return content as ContentBlock[]
  }

  // Try to parse JSON string
  if (typeof content === "string") {
    const trimmed = content.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          return parsed as ContentBlock[]
        }
      } catch {
        // Not valid JSON, return null
      }
    }
  }

  return null
}

/**
 * Normalize message content to array format
 * Handles both string and array content
 */
export function normalizeContent(content: LooseMessageContent): ContentBlock[] {
  if (typeof content === "string") {
    // Try to parse as JSON array first
    const parsed = parseContent(content)
    if (parsed) {
      return parsed
    }
    // Plain text string - wrap in TextBlock
    return [{ type: "text", text: content }]
  }
  return content as ContentBlock[]
}

/**
 * Extract text from content (string or array)
 */
export function extractText(content: LooseMessageContent): string {
  if (typeof content === "string") {
    // Try to parse as JSON array
    const parsed = parseContent(content)
    if (parsed) {
      return parsed
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")
    }
    return content
  }

  return (content as ContentBlock[])
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("")
}

/**
 * Canonical formatter for `sub_agent` session-memory entries.
 *
 * Two call sites need to produce the same shape:
 *   - `cursor-connect-stream.service.ts::upsertSubAgentSessionMemory`
 *     directly writes a session-memory entry the moment a sub-agent
 *     finishes / is aborted. It has rich live state (turn count,
 *     tool-call count, modified files, transcript paths).
 *   - `session-memory-compaction.service.ts::summarizeSubAgentMemory`
 *     re-extracts a sub-agent record from an archived tool_result
 *     during compaction. It only has the rendered text and any
 *     `taskSuccess` structured payload, so several fields will be
 *     undefined.
 *
 * Keeping the formatting in one place avoids field drift between the
 * "fresh" entry written at completion time and any "rebuilt" entry
 * pulled out of the transcript during compaction. The output is
 * stable so downstream parsers (tests, telemetry, the attachment
 * builder's per-line trim) can rely on it.
 *
 * Output shape:
 *   `agentId=<id>; agentType=<type>; status=<status>; turns=<n>; ...`
 *
 * Fields with empty/undefined values are dropped (no `agentId=`
 * dangling). `agentId` is required — when absent we return null so
 * callers can short-circuit instead of producing a memory entry that
 * cannot be deduped against future updates.
 */

export interface SubAgentMemoryFormatInput {
  agentId: string
  agentType?: string
  status?: string
  turnCount?: number
  toolCallCount?: number
  durationMs?: number
  modifiedFiles?: readonly string[]
  /** Sub-agent's `finalText`. Trimmed to `resultMaxChars`. */
  resultText?: string
  /** Compact one-liner of `Key tool evidence` items. */
  evidenceText?: string
  task?: string
  transcriptPath?: string
  resultPath?: string
}

export interface SubAgentMemoryFormatOptions {
  resultMaxChars?: number
  evidenceMaxChars?: number
  taskMaxChars?: number
  /** Hard cap on the joined output. Default 600. */
  totalMaxChars?: number
}

const DEFAULT_RESULT_MAX = 360
const DEFAULT_EVIDENCE_MAX = 480
const DEFAULT_TASK_MAX = 180
const DEFAULT_TOTAL_MAX = 600

/**
 * Build the body of a `sub_agent` session-memory entry without the
 * leading `Sub-agent result: ` prefix. Returns `null` when no
 * `agentId` is available — callers should treat this as "skip this
 * write" rather than producing a malformed entry.
 */
export function formatSubAgentMemoryBody(
  input: SubAgentMemoryFormatInput,
  options?: SubAgentMemoryFormatOptions
): string | null {
  const agentId = (input.agentId || "").trim()
  if (!agentId) return null

  const resultMax = options?.resultMaxChars ?? DEFAULT_RESULT_MAX
  const evidenceMax = options?.evidenceMaxChars ?? DEFAULT_EVIDENCE_MAX
  const taskMax = options?.taskMaxChars ?? DEFAULT_TASK_MAX
  const totalMax = options?.totalMaxChars ?? DEFAULT_TOTAL_MAX

  const parts: string[] = [`agentId=${agentId}`]

  const task = squash(input.task)
  if (task) parts.push(`task=${clip(task, taskMax)}`)

  const agentType = squash(input.agentType)
  if (agentType) parts.push(`agentType=${agentType}`)

  const status = squash(input.status)
  if (status) parts.push(`status=${status}`)

  if (typeof input.turnCount === "number" && Number.isFinite(input.turnCount)) {
    parts.push(`turns=${Math.max(0, Math.floor(input.turnCount))}`)
  }
  if (
    typeof input.toolCallCount === "number" &&
    Number.isFinite(input.toolCallCount)
  ) {
    parts.push(`toolCalls=${Math.max(0, Math.floor(input.toolCallCount))}`)
  }
  if (
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs)
  ) {
    parts.push(`durationMs=${Math.max(0, Math.floor(input.durationMs))}`)
  }

  if (input.modifiedFiles && input.modifiedFiles.length > 0) {
    const preview = input.modifiedFiles.slice(0, 8).join(", ")
    const overflow =
      input.modifiedFiles.length > 8
        ? ` (+${input.modifiedFiles.length - 8} more)`
        : ""
    parts.push(`modifiedFiles=${preview}${overflow}`)
  }

  const result = squash(input.resultText)
  if (result) parts.push(`result=${clip(result, resultMax)}`)

  const evidence = squash(input.evidenceText)
  if (evidence) parts.push(`evidence=${clip(evidence, evidenceMax)}`)

  const transcriptPath = (input.transcriptPath || "").trim()
  if (transcriptPath) parts.push(`transcript=${transcriptPath}`)

  const resultPath = (input.resultPath || "").trim()
  if (resultPath) parts.push(`output=${resultPath}`)

  return clip(parts.join("; "), totalMax)
}

/**
 * Same as {@link formatSubAgentMemoryBody} but prefixed with
 * `Sub-agent result: `. Returns `null` when no `agentId` is
 * available.
 */
export function formatSubAgentMemoryEntry(
  input: SubAgentMemoryFormatInput,
  options?: SubAgentMemoryFormatOptions
): string | null {
  const body = formatSubAgentMemoryBody(input, options)
  return body ? `Sub-agent result: ${body}` : null
}

/**
 * Stable dedup key for a `sub_agent` session-memory entry. Uses the
 * agentId when available, or the parent tool-call id as fallback.
 * Returns `null` when neither is available — the caller should not
 * write an entry in that case.
 */
export function buildSubAgentMemorySourceCompactionId(
  agentId: string | undefined,
  parentToolCallId: string | undefined
): string | null {
  const trimmedAgent = (agentId || "").trim()
  const trimmedParent = (parentToolCallId || "").trim()
  const key = trimmedAgent || trimmedParent
  return key ? `sub_agent:${key}` : null
}

function squash(value: string | undefined): string {
  if (!value) return ""
  return value.replace(/\s+/g, " ").trim()
}

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

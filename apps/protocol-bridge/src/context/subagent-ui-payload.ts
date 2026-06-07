import type { LooseMessageContent } from "./types"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * A sub-agent (`task`) tool_result carries the full child-session
 * transcript in `structuredContent.taskSuccess.conversationSteps`. That
 * array exists ONLY so the IDE can replay the sub-agent's steps in its
 * transcript UI — it is never part of what the parent model is shown.
 *
 * The token counter charges a tool_result block for
 * `max(textTokens, structuredContentTokens)`
 * (token-counter.service.ts countContentBlock), so a sub-agent result
 * whose conversationSteps serialise to ~1 MB makes that single record
 * cost ~300K tokens. The moment the sub-agent result is folded back into
 * the parent conversation the projected context blows the request budget
 * and `ContextCompactionService.ensureWithinBudget` throws
 * `ContextProjectionBudgetExceededError` — record-granularity compaction
 * cannot shrink a single oversized record, so the parent turn dies.
 *
 * The fix is to never let this UI-only payload enter the backend
 * projection in the first place: strip it at the one authoritative
 * `state.records → backend messages` boundary (ContextProjectionService),
 * so token counting, truncation, and the final send all observe clean
 * data. This is a pure projection transform — the underlying transcript
 * record keeps the full payload for IDE replay.
 *
 * Returns the same `content` reference when nothing changed so callers
 * can cheaply detect no-ops.
 */
export function stripSubAgentUiOnlyPayload(
  content: LooseMessageContent
): LooseMessageContent {
  if (!Array.isArray(content)) {
    return content
  }

  let changed = false
  const next = content.map((block) => {
    if (!isPlainObject(block) || block.type !== "tool_result") {
      return block
    }
    const structured = block.structuredContent
    if (!isPlainObject(structured)) {
      return block
    }
    const taskSuccess = structured.taskSuccess
    if (
      !isPlainObject(taskSuccess) ||
      !Array.isArray(taskSuccess.conversationSteps)
    ) {
      return block
    }

    changed = true
    const { conversationSteps: _conversationSteps, ...taskSuccessRest } =
      taskSuccess
    return {
      ...block,
      structuredContent: {
        ...structured,
        taskSuccess: taskSuccessRest,
      },
    }
  })

  return changed ? (next as LooseMessageContent) : content
}

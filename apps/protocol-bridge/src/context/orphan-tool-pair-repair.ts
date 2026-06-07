import {
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UnifiedMessage,
  isToolResultBlock,
  isToolUseBlock,
} from "./types"

/**
 * Send-time repair of tool_use ↔ tool_result pairs that were split across a
 * compaction boundary (or lost when a budget-overflow round archived one half
 * of the pair). Pure transform over the projected message list — the stored
 * transcript records are never mutated (Cursor re-sends the original
 * transcript and `replaceMessages` reconcile would overwrite any record
 * rewrite by id), so this MUST run on every projection.
 *
 * Two symmetric orphan kinds are repaired:
 *
 * 1. Orphaned tool_result — its tool_use was archived behind the boundary.
 *    Rewritten into a text block preserving the result body so the request
 *    stays protocol-valid without the tool_use.
 *
 * 2. Orphaned tool_use — its tool_result was archived/lost. Left untouched it
 *    reaches the Kiro translator, which closes it with a `status:"error"`
 *    "interrupted or result was lost due to context truncation" placeholder
 *    (llm/aws/translator.ts). That misleads the model into thinking the tool
 *    failed (a successful grep_search looks like it errored). Repaired by
 *    appending a neutral, non-error synthetic tool_result.
 *
 * CRITICAL: a tool_use whose id is in `pendingToolUseIds` is genuinely
 * in-flight (its result has not arrived yet) and MUST be left untouched —
 * synthesising a result for it would corrupt an active tool call.
 */
export function repairOrphanedToolPairs(
  messages: UnifiedMessage[],
  options?: { pendingToolUseIds?: Iterable<string> }
): UnifiedMessage[] {
  const toolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isToolUseBlock(block)) {
        toolUseIds.add(block.id)
      } else if (isToolResultBlock(block)) {
        answeredToolUseIds.add(block.tool_use_id)
      }
    }
  }

  const resultRepaired = repairOrphanedToolResults(messages, toolUseIds)
  return repairOrphanedToolUses(
    resultRepaired,
    answeredToolUseIds,
    new Set(options?.pendingToolUseIds ?? [])
  )
}

function repairOrphanedToolResults(
  messages: UnifiedMessage[],
  toolUseIds: ReadonlySet<string>
): UnifiedMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
        changed = true
        return {
          type: "text",
          text: renderOrphanedToolResultText(block),
        } as TextBlock
      }
      return block
    })
    return changed ? { ...message, content } : message
  })
}

function repairOrphanedToolUses(
  messages: UnifiedMessage[],
  answeredToolUseIds: ReadonlySet<string>,
  pendingToolUseIds: ReadonlySet<string>
): UnifiedMessage[] {
  const out: UnifiedMessage[] = []
  for (const message of messages) {
    out.push(message)
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    const orphans: ToolUseBlock[] = []
    for (const block of message.content) {
      if (
        isToolUseBlock(block) &&
        !answeredToolUseIds.has(block.id) &&
        !pendingToolUseIds.has(block.id)
      ) {
        orphans.push(block)
      }
    }
    if (orphans.length === 0) continue
    out.push({
      role: "user",
      content: orphans.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: renderOrphanedToolUseText(block),
      })) as ContentBlock[],
    })
  }
  return out
}

function renderOrphanedToolResultText(block: ToolResultBlock): string {
  const body =
    typeof block.content === "string"
      ? block.content
      : block.content
          .map((inner) => (inner.type === "text" ? inner.text : ""))
          .filter((text) => text.length > 0)
          .join("\n")
  return (
    `[Tool result for an earlier tool call now summarized into the ` +
    `compaction summary above]\n${body}`
  )
}

function renderOrphanedToolUseText(block: ToolUseBlock): string {
  return (
    `[The result of this earlier ${block.name} call was archived during ` +
    `context compaction and is no longer available verbatim. The call ` +
    `itself completed; this is not an error. Re-run the tool if you need ` +
    `the result again.]`
  )
}

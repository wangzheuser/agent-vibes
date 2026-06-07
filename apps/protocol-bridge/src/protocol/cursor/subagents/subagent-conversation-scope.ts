/**
 * Marker that separates a parent conversationId from the sub-agent scope
 * suffix. Mirrors the `:compact` suffix the compaction sub-request already
 * appends to `_conversationId` (see cursor-connect-stream.service.ts), so the
 * Codex transport keys its per-conversation turn-context session — and thus
 * the incremental chain (`previous_response_id` + strict input extension) —
 * independently for each scope.
 */
export const SUB_AGENT_CONVERSATION_SCOPE_MARKER = ":sub:"

/**
 * Derive the conversationId a sub-agent's Codex requests should ride on.
 *
 * Without scoping, every sub-agent turn and every parent-agent turn share one
 * conversationId and therefore one CodexTurnContext. Because the parent's
 * `instructions`/`tools` differ from the sub-agent's, each alternating turn
 * trips `static_fields_changed`, invalidates the incremental chain, and forces
 * a full history resend. Scoping by `subagentId` keeps the parent chain and
 * each sub-agent chain intact.
 *
 * `subagentId` is stable across a single sub-agent's turns, so the sub-agent's
 * own chain still works turn-to-turn. When `subagentId` is empty we fall back
 * to the bare parent id rather than minting a dangling `...:sub:` key.
 */
export function buildSubAgentScopedConversationId(
  parentConversationId: string,
  subagentId: string | undefined
): string {
  const trimmedParent = (parentConversationId || "").trim()
  const trimmedSub = (subagentId || "").trim()
  if (!trimmedSub) {
    return trimmedParent
  }
  return `${trimmedParent}${SUB_AGENT_CONVERSATION_SCOPE_MARKER}${trimmedSub}`
}

import type { BackendType } from "./model-router.service"

export interface ToolContinuationMessage {
  role: "user" | "assistant"
  content: unknown
}

export function backendRequiresCompleteToolBatchBeforeContinuation(
  _backend: BackendType
): boolean {
  // All known LLM backends require that every tool_use in an assistant message
  // has a corresponding tool_result before the next request is sent.
  // Sending partial tool results causes "Improperly formed request" errors.
  return true
}

export function findPendingToolUseIdsInMessages(
  messages: ToolContinuationMessage[],
  pendingToolUseIds?: Iterable<string>
): string[] {
  const pendingIds = new Set(
    Array.from(pendingToolUseIds ?? [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)
  )
  if (pendingIds.size === 0) {
    return []
  }

  const blocking = new Set<string>()

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }

    for (const rawBlock of message.content) {
      if (!rawBlock || typeof rawBlock !== "object") continue
      const block = rawBlock as {
        type?: unknown
        id?: unknown
      }
      if (block.type !== "tool_use" || typeof block.id !== "string") {
        continue
      }
      const toolUseId = block.id.trim()
      if (toolUseId && pendingIds.has(toolUseId)) {
        blocking.add(toolUseId)
      }
    }
  }

  return Array.from(blocking)
}

import {
  buildSubAgentScopedConversationId,
  SUB_AGENT_CONVERSATION_SCOPE_MARKER,
} from "./subagent-conversation-scope"

describe("buildSubAgentScopedConversationId", () => {
  it("appends the sub-agent scope marker and id to the parent conversationId", () => {
    expect(buildSubAgentScopedConversationId("conv-123", "subagent-abc")).toBe(
      `conv-123${SUB_AGENT_CONVERSATION_SCOPE_MARKER}subagent-abc`
    )
  })

  it("keys distinct sub-agents under the same parent to distinct ids", () => {
    const parent = "conv-123"
    const a = buildSubAgentScopedConversationId(parent, "subagent-a")
    const b = buildSubAgentScopedConversationId(parent, "subagent-b")
    expect(a).not.toBe(b)
    // ...and neither collides with the bare parent id (the parent agent's
    // own incremental chain), which is the whole point of the fix.
    expect(a).not.toBe(parent)
    expect(b).not.toBe(parent)
  })

  it("is stable across turns for the same sub-agent so its own chain survives", () => {
    const first = buildSubAgentScopedConversationId("conv-123", "subagent-abc")
    const second = buildSubAgentScopedConversationId("conv-123", "subagent-abc")
    expect(first).toBe(second)
  })

  it("falls back to the bare parent id when the subagentId is missing", () => {
    expect(buildSubAgentScopedConversationId("conv-123", undefined)).toBe(
      "conv-123"
    )
    expect(buildSubAgentScopedConversationId("conv-123", "")).toBe("conv-123")
    expect(buildSubAgentScopedConversationId("conv-123", "   ")).toBe(
      "conv-123"
    )
  })

  it("trims surrounding whitespace on both inputs", () => {
    expect(
      buildSubAgentScopedConversationId("  conv-123  ", "  subagent-abc  ")
    ).toBe(`conv-123${SUB_AGENT_CONVERSATION_SCOPE_MARKER}subagent-abc`)
  })
})

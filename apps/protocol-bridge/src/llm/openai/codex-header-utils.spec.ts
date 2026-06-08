import {
  buildCodexHttpHeaders,
  buildCodexWebSocketHeaders,
  type CodexClientIdentity,
} from "./codex-header-utils"

const identity: CodexClientIdentity = {
  version: "0.0.0-test",
  userAgent: "agent-vibes-test",
  originator: "agent-vibes-test",
}

describe("codex header utils", () => {
  const scopedConversationId =
    "3687a40b-db95-4441-8ff7-3e2213a924e3:sub:subagent-1780878829248-upwmub"

  it("normalizes long WebSocket session_id values derived from conversation ids", () => {
    const headers = buildCodexWebSocketHeaders({
      token: "token",
      isApiKey: false,
      identity,
      conversationId: scopedConversationId,
    })

    expect(headers.session_id).toHaveLength(64)
    expect(headers.session_id).not.toBe(scopedConversationId)
  })

  it("normalizes long HTTP session_id values derived from conversation ids", () => {
    const headers = buildCodexHttpHeaders({
      token: "token",
      isApiKey: false,
      stream: true,
      identity,
      conversationId: scopedConversationId,
    })

    expect(headers.session_id).toHaveLength(64)
    expect(headers.session_id).not.toBe(scopedConversationId)
  })

  it("keeps existing prompt cache Session_id headers unchanged", () => {
    const cacheId = "123e4567-e89b-12d3-a456-426614174000"
    const headers = buildCodexHttpHeaders({
      token: "token",
      isApiKey: false,
      stream: true,
      identity,
      conversationId: scopedConversationId,
      cacheHeaders: { Session_id: cacheId },
    })

    expect(headers.Session_id).toBe(cacheId)
    expect(headers.session_id).toBeUndefined()
  })
})

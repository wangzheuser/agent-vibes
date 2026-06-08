import { CodexCacheService } from "./codex-cache.service"

describe("CodexCacheService", () => {
  let service: CodexCacheService

  beforeEach(() => {
    service = new CodexCacheService()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  it("keeps valid UUID cache ids unchanged", () => {
    const cacheId = "123e4567-e89b-12d3-a456-426614174000"

    expect(service.injectCacheKey({}, cacheId)).toEqual({
      prompt_cache_key: cacheId,
    })
    expect(service.buildWebSocketCacheHeaders(cacheId)).toEqual({
      Conversation_id: cacheId,
    })
  })

  it("normalizes long scoped conversation ids before using them as prompt cache keys", () => {
    const scopedConversationId =
      "3687a40b-db95-4441-8ff7-3e2213a924e3:sub:subagent-1780878829248-upwmub"

    const body = service.injectCacheKey({}, scopedConversationId) as {
      prompt_cache_key: string
    }
    const headers = service.buildWebSocketCacheHeaders(scopedConversationId)

    expect(body.prompt_cache_key).toHaveLength(36)
    expect(body.prompt_cache_key.length).toBeLessThanOrEqual(64)
    expect(headers.Conversation_id).toBe(body.prompt_cache_key)
  })

  it("normalizes long cache ids deterministically", () => {
    const scopedConversationId =
      "3687a40b-db95-4441-8ff7-3e2213a924e3:sub:subagent-1780878829265-tfs9fr"

    expect(service.injectCacheKey({}, scopedConversationId)).toEqual(
      service.injectCacheKey({}, scopedConversationId)
    )
  })
})

/**
 * Unified Provider Adapter Interface.
 *
 * Each LLM provider (Codex, Claude, Gemini) implements this interface.
 * The Agent Runtime calls these methods without knowing provider-specific
 * transport details (WebSocket, SSE, previous_response_id, etc.).
 *
 * Event format: all adapters emit Claude-compatible SSE event strings,
 * which is the existing lingua franca of the protocol bridge.
 */

// ── Warmup ───────────────────────────────────────────────────────────

/**
 * Hint for the provider to preemptively prepare resources.
 * Each adapter interprets this differently:
 *   - Codex: establish WebSocket + send generate:false prompt cache warmup
 *   - Claude/Gemini: no-op (HTTP connections don't need prewarming)
 */
export interface ProviderWarmupHint {
  /** Target model name (already resolved by router) */
  model: string
  /** Conversation ID for session binding */
  conversationId?: string
  /** Reason label for logging/telemetry */
  reason: string
  /** Pending tool call IDs — adapter uses this for session binding */
  pendingToolUseIds?: string[]
  /**
   * Optional warmup payload snapshot.
   * If provided, the adapter may use it for prompt cache prewarming.
   * If not provided, the adapter will use its internally cached payload.
   */
  warmupPayload?: Record<string, unknown>
}

// ── Interface ────────────────────────────────────────────────────────

/**
 * ProviderAdapter abstracts a single LLM provider backend.
 *
 * All provider-specific transport logic (WebSocket management, auth,
 * connection pooling, previous_response_id, prewarm, incremental append)
 * is encapsulated within the adapter implementation.
 *
 * The protocol bridge / agent runtime only interacts through this interface.
 */
export interface ProviderAdapter {
  /**
   * Preemptively prepare resources for an upcoming stream request.
   * Provider-specific behavior:
   *   - Codex: establish WebSocket + optional generate:false warmup
   *   - Claude/Gemini: typically no-op
   *
   * This method is fire-and-forget; failures are logged but don't block.
   */
  warmup(hint: ProviderWarmupHint): void

  /**
   * Release provider-specific resources for a conversation.
   * Called when a conversation ends or times out.
   */
  dispose(conversationId: string): void
}

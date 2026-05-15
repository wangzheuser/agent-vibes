/**
 * Per-account prompt-cache tracker for the Kiro backend.
 *
 * Kiro / AWS CodeWhisperer does not return Anthropic-style
 * `cache_read_input_tokens` / `cache_creation_input_tokens` in the
 * `usage` block, so we simulate them client-side by hashing each
 * cacheable block (tools, system, messages) into breakpoints and
 * keeping a per-account map of recently seen prefixes.
 *
 * Reference: https://github.com/Quorinex/Kiro-Go (proxy/cache_tracker.go).
 *
 * The tracker is intentionally pure (no I/O) so it can be unit-tested.
 */

import * as crypto from "crypto"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"

const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000
const ONE_HOUR_MS = 60 * 60_000

/** Minimum cacheable token count required for a breakpoint to be considered. */
const DEFAULT_MIN_CACHEABLE_TOKENS = 1024
const OPUS_MIN_CACHEABLE_TOKENS = 4096

/**
 * Approximate token estimator: ~4 characters per token. Cheap and stable;
 * used purely as a heuristic for breakpoint sizing.
 */
function estimateApproxTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

function minCacheableTokensForModel(model: string): number {
  return /opus/i.test(model || "")
    ? OPUS_MIN_CACHEABLE_TOKENS
    : DEFAULT_MIN_CACHEABLE_TOKENS
}

export interface KiroPromptCacheUsage {
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cacheCreation5mInputTokens: number
  cacheCreation1hInputTokens: number
}

export interface KiroPromptCacheBreakpoint {
  fingerprint: string
  cumulativeTokens: number
  ttlMs: number
}

export interface KiroPromptCacheProfile {
  breakpoints: KiroPromptCacheBreakpoint[]
  totalInputTokens: number
  model: string
}

interface CacheEntry {
  expiresAt: number
  ttlMs: number
}

interface CacheableBlock {
  value: unknown
  tokens: number
  ttlMs: number
  isMessageEnd: boolean
}

export class KiroPromptCacheTracker {
  private readonly entriesByAccount = new Map<string, Map<string, CacheEntry>>()

  constructor(private readonly maxSupportedTtlMs: number = ONE_HOUR_MS) {}

  /**
   * Build a deterministic cache profile (set of fingerprints + cumulative
   * token counts) for the request.  Returns `null` when the request has no
   * `cache_control` breakpoints to track.
   */
  buildProfile(
    dto: CreateMessageDto,
    estimatedInputTokens: number
  ): KiroPromptCacheProfile | null {
    const blocks = flattenCacheBlocks(dto)
    if (blocks.length === 0) return null

    const hasher = crypto.createHash("sha256")
    const breakpoints: KiroPromptCacheBreakpoint[] = []
    let cumulativeTokens = 0
    let activeTtlMs = 0

    for (const block of blocks) {
      const canonical = canonicalizeCacheValue(block.value)
      writeHashChunk(hasher, canonical)
      cumulativeTokens += block.tokens

      let breakpointTtl = 0
      if (block.ttlMs > 0) {
        breakpointTtl = block.ttlMs
        activeTtlMs = block.ttlMs
      } else if (block.isMessageEnd && activeTtlMs > 0) {
        breakpointTtl = activeTtlMs
      }

      if (breakpointTtl <= 0) continue

      const fingerprint = hasher.copy().digest("hex")
      breakpoints.push({
        fingerprint,
        cumulativeTokens,
        ttlMs: breakpointTtl,
      })
    }

    if (breakpoints.length === 0) return null

    const totalInputTokens = Math.max(estimatedInputTokens, cumulativeTokens)
    return {
      breakpoints,
      totalInputTokens,
      model: dto.model || "",
    }
  }

  /**
   * Compute the simulated cache usage for a request using the given account.
   * Caller must invoke `update()` after a successful response so subsequent
   * requests can match against these breakpoints.
   */
  compute(
    accountKey: string,
    profile: KiroPromptCacheProfile | null
  ): KiroPromptCacheUsage {
    const empty: KiroPromptCacheUsage = {
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
    }
    if (!accountKey || !profile || profile.breakpoints.length === 0) {
      return empty
    }

    const now = Date.now()
    this.pruneExpired(now)

    const minTokens = minCacheableTokensForModel(profile.model)
    const last = profile.breakpoints[profile.breakpoints.length - 1]!
    let lastTokens = Math.min(last.cumulativeTokens, profile.totalInputTokens)

    const entries = this.entriesByAccount.get(accountKey)
    if (!entries || entries.size === 0) {
      // First request for this account: report creation only above threshold.
      const effectiveCreation = lastTokens < minTokens ? 0 : lastTokens
      const breakdown = computeTtlBreakdown(profile, 0)
      return {
        cacheCreationInputTokens: effectiveCreation,
        cacheReadInputTokens: 0,
        cacheCreation5mInputTokens: breakdown.cache5m,
        cacheCreation1hInputTokens: breakdown.cache1h,
      }
    }

    // Cap cacheable tokens at 85% of total — newest content cannot 100% hit.
    const maxCacheable = Math.floor(profile.totalInputTokens * 0.85)
    if (lastTokens > maxCacheable) lastTokens = maxCacheable

    let matchedTokens = 0
    for (let i = profile.breakpoints.length - 1; i >= 0; i--) {
      const bp = profile.breakpoints[i]!
      if (bp.cumulativeTokens < minTokens) continue
      const entry = entries.get(bp.fingerprint)
      if (!entry || entry.expiresAt < now) continue

      // Refresh TTL on hit (sliding expiration).
      entry.expiresAt = now + entry.ttlMs

      matchedTokens = Math.min(bp.cumulativeTokens, profile.totalInputTokens)
      if (matchedTokens > lastTokens) matchedTokens = lastTokens
      break
    }

    const creation = Math.max(lastTokens - matchedTokens, 0)
    const breakdown = computeTtlBreakdown(profile, matchedTokens)
    return {
      cacheCreationInputTokens: creation,
      cacheReadInputTokens: matchedTokens,
      cacheCreation5mInputTokens: breakdown.cache5m,
      cacheCreation1hInputTokens: breakdown.cache1h,
    }
  }

  /**
   * Record breakpoints from the (now-served) request so future calls on the
   * same account can match them.
   */
  update(accountKey: string, profile: KiroPromptCacheProfile | null): void {
    if (!accountKey || !profile || profile.breakpoints.length === 0) return

    const now = Date.now()
    this.pruneExpired(now)

    const minTokens = minCacheableTokensForModel(profile.model)
    let entries = this.entriesByAccount.get(accountKey)
    if (!entries) {
      entries = new Map()
      this.entriesByAccount.set(accountKey, entries)
    }

    for (const bp of profile.breakpoints) {
      if (bp.cumulativeTokens < minTokens) continue
      const ttlMs = Math.min(bp.ttlMs, this.maxSupportedTtlMs)
      entries.set(bp.fingerprint, {
        expiresAt: now + ttlMs,
        ttlMs,
      })
    }
  }

  /**
   * Drop the cache for an account (e.g. credential rotation).  Idempotent.
   */
  forget(accountKey: string): void {
    this.entriesByAccount.delete(accountKey)
  }

  private pruneExpired(now: number): void {
    for (const [accountKey, entries] of this.entriesByAccount) {
      for (const [fp, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(fp)
      }
      if (entries.size === 0) this.entriesByAccount.delete(accountKey)
    }
  }
}

/**
 * Compute the bill-side breakdown of newly created tokens between 5m / 1h
 * TTL buckets, given how many tokens were already matched against cache.
 */
function computeTtlBreakdown(
  profile: KiroPromptCacheProfile,
  matchedTokens: number
): { cache5m: number; cache1h: number } {
  if (!profile || profile.breakpoints.length === 0) {
    return { cache5m: 0, cache1h: 0 }
  }
  let cache5m = 0
  let cache1h = 0
  let previous = matchedTokens
  for (const bp of profile.breakpoints) {
    const current = Math.min(bp.cumulativeTokens, profile.totalInputTokens)
    if (current <= previous) continue
    const delta = current - previous
    if (bp.ttlMs >= ONE_HOUR_MS) cache1h += delta
    else cache5m += delta
    previous = current
  }
  return { cache5m, cache1h }
}

/**
 * Subtract cache-credited tokens from the raw input token count so the
 * billed input tokens reflect only the uncached portion.
 */
export function billedKiroInputTokens(
  inputTokens: number,
  usage: KiroPromptCacheUsage
): number {
  return Math.max(
    inputTokens - usage.cacheCreationInputTokens - usage.cacheReadInputTokens,
    0
  )
}

// ── Block flattening ────────────────────────────────────────────────────

interface DtoMessage {
  role?: string
  content?: unknown
}

function flattenCacheBlocks(dto: CreateMessageDto): CacheableBlock[] {
  const blocks: CacheableBlock[] = []

  // Request prelude — model + tool_choice. Always present, never a breakpoint.
  blocks.push({
    value: {
      kind: "request_prelude",
      model: dto.model || "",
      tool_choice: dto.tool_choice ?? null,
    },
    tokens: estimateApproxTokens(
      JSON.stringify({
        model: dto.model || "",
        tool_choice: dto.tool_choice ?? null,
      })
    ),
    ttlMs: 0,
    isMessageEnd: false,
  })

  // Tools
  const tools = dto.tools as Array<Record<string, unknown>> | undefined
  if (Array.isArray(tools)) {
    tools.forEach((tool, toolIndex) => {
      const value = {
        kind: "tool",
        tool_index: toolIndex,
        name: tool["name"],
        description: tool["description"],
        input_schema: tool["input_schema"],
      }
      const fingerprintValue = stripPositionKeys(value)
      blocks.push({
        value: fingerprintValue,
        tokens: estimateApproxTokens(canonicalizeCacheValue(fingerprintValue)),
        ttlMs: normalizePromptCacheTtl(extractPromptCacheTtl(tool)),
        isMessageEnd: false,
      })
    })
  }

  // System
  appendSystemBlocks(blocks, dto.system as unknown)

  // Messages
  const messages = (dto.messages || []) as DtoMessage[]
  messages.forEach((msg, messageIndex) => {
    appendMessageBlocks(blocks, messageIndex, msg)
  })

  return blocks
}

function appendSystemBlocks(blocks: CacheableBlock[], system: unknown): void {
  if (typeof system === "string") {
    pushPromptBlock(
      blocks,
      {
        kind: "system",
        system_index: 0,
        block: { type: "text", text: system },
      },
      false
    )
    return
  }
  if (Array.isArray(system)) {
    system.forEach((block, idx) => {
      pushPromptBlock(
        blocks,
        {
          kind: "system",
          system_index: idx,
          block,
        },
        false
      )
    })
  }
}

function appendMessageBlocks(
  blocks: CacheableBlock[],
  messageIndex: number,
  msg: DtoMessage
): void {
  const role = msg.role || "user"
  const content = msg.content
  if (typeof content === "string") {
    pushPromptBlock(
      blocks,
      {
        kind: "message",
        message_index: messageIndex,
        role,
        block_index: 0,
        block: { type: "text", text: content },
      },
      true
    )
    return
  }
  if (Array.isArray(content)) {
    const lastIdx = content.length - 1
    content.forEach((block, blockIndex) => {
      pushPromptBlock(
        blocks,
        {
          kind: "message",
          message_index: messageIndex,
          role,
          block_index: blockIndex,
          block,
        },
        blockIndex === lastIdx
      )
    })
  }
}

function pushPromptBlock(
  blocks: CacheableBlock[],
  wrapper: Record<string, unknown>,
  isMessageEnd: boolean
): void {
  const blockValue = wrapper["block"]
  const ttl = normalizePromptCacheTtl(extractPromptCacheTtl(blockValue))

  // Drop volatile billing metadata so the fingerprint stays stable.
  if (isAnthropicBillingHeaderBlock(blockValue)) return

  const fingerprintValue = stripPositionKeys(wrapper)
  const canonical = canonicalizeCacheValue(fingerprintValue)
  blocks.push({
    value: fingerprintValue,
    tokens: estimateApproxTokens(canonical),
    ttlMs: ttl,
    isMessageEnd,
  })
}

function stripPositionKeys(
  value: Record<string, unknown>
): Record<string, unknown> {
  const cloned: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isPositionKey(key)) continue
    cloned[key] = item
  }
  return cloned
}

function isPositionKey(key: string): boolean {
  return (
    key === "tool_index" ||
    key === "system_index" ||
    key === "message_index" ||
    key === "block_index"
  )
}

function isAnthropicBillingHeaderBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  const type = typeof obj.type === "string" ? obj.type : ""
  if (type !== "" && type !== "text") return false
  const text = typeof obj.text === "string" ? obj.text : ""
  if (!text) return false
  const trimmed = text.replace(/^[\s\t\r\n]+/, "").toLowerCase()
  return trimmed.startsWith("x-anthropic-billing-header:")
}

function extractPromptCacheTtl(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0
  const obj = value as Record<string, unknown>
  const cacheControl = obj["cache_control"]
  if (
    !cacheControl ||
    typeof cacheControl !== "object" ||
    Array.isArray(cacheControl)
  ) {
    return 0
  }
  const cc = cacheControl as Record<string, unknown>
  const type = typeof cc.type === "string" ? cc.type.toLowerCase() : ""
  if (type !== "ephemeral") return 0
  const parsed = parsePromptCacheTtlValue(cc.ttl)
  return parsed > 0 ? parsed : DEFAULT_PROMPT_CACHE_TTL_MS
}

function parsePromptCacheTtlValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value * 1000
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return 0
    const m = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
    if (m) {
      const amount = Number.parseFloat(m[1]!)
      const unit = m[2] || "s"
      switch (unit) {
        case "ms":
          return Math.round(amount)
        case "s":
          return Math.round(amount * 1_000)
        case "m":
          return Math.round(amount * 60_000)
        case "h":
          return Math.round(amount * 3_600_000)
      }
    }
    const num = Number.parseFloat(trimmed)
    if (Number.isFinite(num) && num > 0) return num * 1000
  }
  return 0
}

function normalizePromptCacheTtl(ttlMs: number): number {
  if (ttlMs <= 0) return 0
  if (ttlMs > ONE_HOUR_MS) return ONE_HOUR_MS
  if (ttlMs > DEFAULT_PROMPT_CACHE_TTL_MS) return ONE_HOUR_MS
  return DEFAULT_PROMPT_CACHE_TTL_MS
}

function writeHashChunk(hasher: crypto.Hash, chunk: string): void {
  const buf = Buffer.from(chunk, "utf8")
  hasher.update(String(buf.length))
  hasher.update(Buffer.from([0]))
  hasher.update(buf)
  hasher.update(Buffer.from([0]))
}

/**
 * Canonical JSON: object keys sorted alphabetically, `cache_control` skipped
 * so toggling cache control on/off does not change the fingerprint.
 */
function canonicalizeCacheValue(value: unknown): string {
  return canonicalizeImpl(value)
}

function canonicalizeImpl(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return JSON.stringify(value)
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  if (Array.isArray(value)) {
    const parts = value.map((item) => canonicalizeImpl(item))
    return `[${parts.join(",")}]`
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((key) => key !== "cache_control")
      .sort()
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeImpl(obj[key])}`
    )
    return `{${parts.join(",")}}`
  }
  return JSON.stringify(value)
}

export const __TEST__ = {
  estimateApproxTokens,
  canonicalizeCacheValue,
  computeTtlBreakdown,
  flattenCacheBlocks,
  normalizePromptCacheTtl,
  parsePromptCacheTtlValue,
}

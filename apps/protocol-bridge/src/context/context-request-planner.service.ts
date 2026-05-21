import { Injectable } from "@nestjs/common"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  ContextCompactionResult,
  ContextCompactionService,
} from "./context-compaction.service"
import { ContextManagerService } from "./context-manager.service"
import {
  resolveAutoCompactTokenLimit,
  resolvePredictiveCompactTokenLimit,
} from "./context-auto-compact-policy"
import { ContextConversationState, UnifiedMessage } from "./types"
import { TokenCounterService } from "./token-counter.service"

export interface ContextRequestBudgetInput {
  backend: string
  protocolMaxTokens?: number
  backendMaxTokens?: number
  defaultMaxTokens: number
  protectedContextTokens?: number
  systemPrompt?: string
  systemPromptTokens?: number
  toolDefinitions?: unknown
  backendSystemPromptTokens?: number
  fixedOverheadTokens?: number
  maxOutputTokens?: number
  requestedServiceTier?: string
}

export interface ContextRequestBudget {
  maxTokens: number
  systemPromptTokens: number
  maxOutputTokens: number
  autoCompactTokenLimit?: number
  predictiveCompactTokenLimit?: number
  backendClampedFrom?: number
  backendClampedTo?: number
}

export interface ContextProjectionOptions {
  integrityMode?: "strict-adjacent" | "global"
  pendingToolUseIds?: Iterable<string>
  strategy?: "auto" | "manual" | "reactive"
  nativeCacheEdits?: boolean
  dryRun?: boolean
}

export type ContextProjectionBudget = Pick<
  ContextRequestBudget,
  | "maxTokens"
  | "systemPromptTokens"
  | "autoCompactTokenLimit"
  | "predictiveCompactTokenLimit"
>

@Injectable()
export class ContextRequestPlannerService {
  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly contextManager: ContextManagerService
  ) {}

  resolveBudget(input: ContextRequestBudgetInput): ContextRequestBudget {
    const protocolMaxTokens = this.normalizePositiveInteger(
      input.protocolMaxTokens
    )
    const backendMaxTokens = this.normalizePositiveInteger(
      input.backendMaxTokens
    )
    const defaultMaxTokens =
      this.normalizePositiveInteger(input.defaultMaxTokens) ?? 166_000

    // The backend limit is a hard cap, not the default request budget.
    // Cursor only sends a large protocol limit when the conversation/model is
    // actually in max-context mode; otherwise keep the normal default budget
    // and use backendMaxTokens only to clamp oversized protocol requests.
    let maxTokens = protocolMaxTokens || defaultMaxTokens
    let backendClampedFrom: number | undefined
    let backendClampedTo: number | undefined
    if (backendMaxTokens && maxTokens > backendMaxTokens) {
      backendClampedFrom = maxTokens
      backendClampedTo = backendMaxTokens
      maxTokens = backendMaxTokens
    }

    const protocolSystemPromptTokens =
      this.normalizePositiveInteger(input.systemPromptTokens) ??
      this.countSystemPromptTokens(input.systemPrompt)
    const systemPromptTokens =
      (this.normalizePositiveInteger(input.protectedContextTokens) ?? 0) +
      protocolSystemPromptTokens +
      this.tokenCounter.countJsonValue(input.toolDefinitions) +
      (this.normalizePositiveInteger(input.backendSystemPromptTokens) ?? 0) +
      (this.normalizePositiveInteger(input.fixedOverheadTokens) ?? 0)

    const maxOutputTokens =
      this.normalizePositiveInteger(input.maxOutputTokens) ?? 0
    const autoCompactTokenLimit = resolveAutoCompactTokenLimit({
      backend: input.backend,
      maxTokens,
      maxOutputTokens,
      requestedServiceTier: input.requestedServiceTier,
    })
    const predictiveCompactTokenLimit = resolvePredictiveCompactTokenLimit({
      backend: input.backend,
      maxTokens,
      maxOutputTokens,
      requestedServiceTier: input.requestedServiceTier,
    })

    return {
      maxTokens,
      systemPromptTokens,
      maxOutputTokens,
      autoCompactTokenLimit,
      predictiveCompactTokenLimit,
      backendClampedFrom,
      backendClampedTo,
    }
  }

  projectMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): ContextCompactionResult {
    return this.contextManager.buildBackendMessagesFromMessages(
      messages,
      snapshot,
      this.buildCompactionOptions(budget, options)
    )
  }

  projectState(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): ContextCompactionResult {
    return this.contextManager.buildBackendMessages(
      state,
      snapshot,
      this.buildCompactionOptions(budget, options)
    )
  }

  private buildCompactionOptions(
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): Parameters<ContextCompactionService["ensureWithinBudget"]>[2] {
    return {
      maxTokens: budget.maxTokens,
      systemPromptTokens: budget.systemPromptTokens,
      autoCompactTokenLimit: budget.autoCompactTokenLimit,
      predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
      integrityMode: options?.integrityMode,
      pendingToolUseIds: options?.pendingToolUseIds,
      strategy: options?.strategy || "auto",
      nativeCacheEdits: options?.nativeCacheEdits,
      dryRun: options?.dryRun,
    }
  }

  private countSystemPromptTokens(systemPrompt?: string): number {
    if (!systemPrompt) {
      return 0
    }
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content: systemPrompt,
      } as UnifiedMessage,
    ])
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }
}

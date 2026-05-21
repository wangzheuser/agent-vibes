import { Injectable, Logger } from "@nestjs/common"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  ContextCompactionCandidate,
  ContextCompactionPlan,
  ContextCompactionService,
} from "./context-compaction.service"
import {
  ContextConversationState,
  ContextTranscriptRecord,
  extractText,
} from "./types"

export interface ContextCompactRunnerSummaryRequest {
  prompt: string
  maxTokens: number
  candidate: ContextCompactionCandidate
}

export interface ContextCompactRunnerSummaryResult {
  summary: string
  hookUserMessage?: string
}

export type ContextCompactRunnerSummaryProvider = (
  request: ContextCompactRunnerSummaryRequest
) => Promise<ContextCompactRunnerSummaryResult>

export type ContextCompactRunnerHookProvider = (
  candidate: ContextCompactionCandidate
) => Promise<string | undefined>

@Injectable()
export class ContextCompactRunnerService {
  private readonly logger = new Logger(ContextCompactRunnerService.name)

  constructor(private readonly compaction: ContextCompactionService) {}

  async compactIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      summaryProvider: ContextCompactRunnerSummaryProvider
      hookUserMessage?: string
      hookProvider?: ContextCompactRunnerHookProvider
    }
  ): Promise<ContextCompactionPlan | undefined> {
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      options
    )
    if (!candidate) return undefined

    const hookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    const summaryPrompt = this.buildSummaryPrompt(candidate.archivedRecords)
    const summaryResult = await options.summaryProvider({
      prompt: summaryPrompt,
      maxTokens: candidate.summaryBudget,
      candidate,
    })
    const summary = summaryResult.summary.trim()
    if (!summary) {
      throw new Error("LLM compact runner returned an empty summary")
    }

    const plan = this.compaction.applyGeneratedSummaryCompaction(
      state,
      snapshot,
      candidate,
      {
        summary,
        hookUserMessage: summaryResult.hookUserMessage || hookUserMessage,
      }
    )
    this.logger.log(
      `LLM compact runner applied commit=${plan.commit.id} archived=${plan.commit.archivedMessageCount} summaryTokens=${plan.commit.summaryTokenCount}`
    )
    return plan
  }

  private buildSummaryPrompt(
    records: readonly ContextTranscriptRecord[]
  ): string {
    const transcript = records
      .map((record, index) => {
        const text = this.renderRecord(record)
        return `<message index="${index + 1}" role="${record.role}">\n${text}\n</message>`
      })
      .join("\n\n")

    return [
      "Summarize the conversation segment below for continuation.",
      "Preserve user goals, constraints, decisions, files, commands, tool outcomes, open work, and verification state.",
      "Do not answer the user. Return only the compact continuation summary.",
      "",
      "<conversation_segment>",
      transcript,
      "</conversation_segment>",
    ].join("\n")
  }

  private renderRecord(record: ContextTranscriptRecord): string {
    if (typeof record.content === "string") {
      return record.content
    }
    const text = extractText(record.content)
    if (text.trim()) return text
    try {
      return JSON.stringify(record.content)
    } catch {
      return ""
    }
  }
}

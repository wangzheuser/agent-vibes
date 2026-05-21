import { Injectable } from "@nestjs/common"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import {
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isAttachmentRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  renderCompactBoundary,
  renderCompactSummary,
} from "./context-transcript-events"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextTranscriptRecord,
  ProjectedContextMessage,
} from "./types"

@Injectable()
export class ContextProjectionService {
  constructor(private readonly attachments: ContextAttachmentBuilderService) {}

  project(
    state: ContextConversationState,
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
      recordsOverride?: readonly ContextTranscriptRecord[]
    }
  ): ProjectedContextMessage[] {
    const sourceRecords = options?.recordsOverride || state.records
    const compactSlice = getRecordsAfterCompactBoundary(sourceRecords)
    const projected = compactSlice.flatMap((record) =>
      this.projectRecord(record)
    )
    const activeCommit = getActiveCompactCommitFromTranscript(sourceRecords)
    const hasPostCompactAttachments = compactSlice.some(isAttachmentRecord)
    const liveAttachments =
      options?.attachmentSnapshot && !hasPostCompactAttachments
        ? this.attachments.buildAttachments(options.attachmentSnapshot, {
            maxTokens: options.attachmentTokenBudget,
          })
        : []

    return [
      ...projected,
      ...this.buildAttachmentMessages(liveAttachments, activeCommit?.id),
    ]
  }

  getActiveCommit(
    state: ContextConversationState
  ): ContextCompactionCommit | undefined {
    return getActiveCompactCommitFromTranscript(state.records)
  }

  getCommitChain(state: ContextConversationState): ContextCompactionCommit[] {
    const active = this.getActiveCommit(state)
    return active ? [active] : []
  }

  renderCompactionBoundary(commit: ContextCompactionCommit): string {
    return renderCompactBoundary(commit)
  }

  renderCompactionSummary(commit: ContextCompactionCommit): string {
    return renderCompactSummary(commit)
  }

  renderProjectedMessage(message: ProjectedContextMessage): string | undefined {
    return typeof message.content === "string" ? message.content : undefined
  }

  private projectRecord(
    record: ContextTranscriptRecord
  ): ProjectedContextMessage[] {
    if (isMessageRecord(record)) {
      return [
        {
          role: record.role,
          content: record.content,
          source: "record",
          recordId: record.id,
        },
      ]
    }

    if (isCompactBoundaryRecord(record)) {
      const commit = record.compactMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderCompactBoundary(commit)
                : "Conversation compacted",
          source: "boundary",
          commitId: commit?.id,
          recordId: record.id,
          compactionEvent: commit
            ? {
                type: "boundary",
                commitId: commit.id,
                epoch: commit.epoch,
                parentCompactionId: commit.parentCompactionId,
                archivedThroughRecordId: commit.archivedThroughRecordId,
                sourceTokenCount: commit.sourceTokenCount,
                projectedTokenCount: commit.projectedTokenCount,
              }
            : undefined,
        },
      ]
    }

    if (isCompactSummaryRecord(record)) {
      const commit = record.compactMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderCompactSummary(commit)
                : "",
          source: "summary",
          commitId: commit?.id,
          recordId: record.id,
          compactionEvent: commit
            ? {
                type: "summary",
                commitId: commit.id,
                epoch: commit.epoch,
                parentCompactionId: commit.parentCompactionId,
                archivedThroughRecordId: commit.archivedThroughRecordId,
                summaryTokenCount: commit.summaryTokenCount,
                sourceTokenCount: commit.sourceTokenCount,
                projectedTokenCount: commit.projectedTokenCount,
              }
            : undefined,
        },
      ]
    }

    if (isSnipBoundaryRecord(record) || isMicrocompactBoundaryRecord(record)) {
      return []
    }

    if (isAttachmentRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "attachment",
          recordId: record.id,
          attachmentKind: record.attachmentMetadata?.kind,
        },
      ]
    }

    if (isHookResultRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "hook",
          recordId: record.id,
          commitId: record.hookMetadata?.compactionId,
        },
      ]
    }

    return []
  }

  private buildAttachmentMessages(
    attachments: ReturnType<
      ContextAttachmentBuilderService["buildAttachments"]
    >,
    commitId?: string
  ): ProjectedContextMessage[] {
    return attachments.map((attachment) => ({
      role: "user" as const,
      content: attachment.content,
      source: "attachment" as const,
      commitId,
      attachmentKind: attachment.kind,
    }))
  }
}

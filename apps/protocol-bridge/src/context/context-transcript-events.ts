import { randomUUID } from "crypto"
import {
  ContextCompactionCommit,
  ContextProjectionAttachment,
  ContextTranscriptRecord,
  LooseMessageContent,
} from "./types"

export function isMessageRecord(record: ContextTranscriptRecord): boolean {
  return !record.kind || record.kind === "message"
}

export function isCompactBoundaryRecord(
  record: ContextTranscriptRecord
): boolean {
  return record.kind === "compact_boundary"
}

export function isCompactSummaryRecord(
  record: ContextTranscriptRecord
): boolean {
  return record.kind === "compact_summary"
}

export function isSnipBoundaryRecord(record: ContextTranscriptRecord): boolean {
  return record.kind === "snip_boundary"
}

export function isMicrocompactBoundaryRecord(
  record: ContextTranscriptRecord
): boolean {
  return record.kind === "microcompact_boundary"
}

export function isAttachmentRecord(record: ContextTranscriptRecord): boolean {
  return record.kind === "attachment"
}

export function isHookResultRecord(record: ContextTranscriptRecord): boolean {
  return record.kind === "hook_result"
}

export function createCompactBoundaryRecord(
  commit: ContextCompactionCommit,
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `compact_boundary_${commit.id}`,
    role: "user",
    kind: "compact_boundary",
    content: renderCompactBoundary(commit),
    createdAt,
    compactMetadata: { commit },
  }
}

export function createCompactSummaryRecord(
  commit: ContextCompactionCommit,
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `compact_summary_${commit.id}`,
    role: "user",
    kind: "compact_summary",
    content: renderCompactSummary(commit),
    createdAt,
    compactMetadata: { commit, summary: commit.summary },
  }
}

export function createSnipBoundaryRecord(
  removedRecordIds: readonly string[],
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `snip_boundary_${randomUUID()}`,
    role: "user",
    kind: "snip_boundary",
    content: "Context snipped",
    createdAt,
    snipMetadata: { removedRecordIds: [...removedRecordIds] },
  }
}

export function createMicrocompactBoundaryRecord(
  input: {
    preTokens: number
    tokensSaved: number
    compactedToolIds: readonly string[]
    trigger?: "auto" | "idle"
  },
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `microcompact_boundary_${randomUUID()}`,
    role: "user",
    kind: "microcompact_boundary",
    content: "Context microcompacted",
    createdAt,
    microcompactMetadata: {
      trigger: input.trigger || "auto",
      preTokens: input.preTokens,
      tokensSaved: input.tokensSaved,
      compactedToolIds: [...input.compactedToolIds],
    },
  }
}

export function createAttachmentRecord(
  attachment: ContextProjectionAttachment,
  compactionId: string,
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `compact_attachment_${compactionId}_${attachment.kind}_${randomUUID()}`,
    role: "user",
    kind: "attachment",
    content: attachment.content,
    createdAt,
    attachmentMetadata: attachment,
  }
}

export function createHookResultRecord(
  input: {
    compactionId: string
    trigger: "manual" | "auto" | "reactive"
    content: string
  },
  createdAt: number = Date.now()
): ContextTranscriptRecord {
  return {
    id: `compact_hook_${input.compactionId}_${randomUUID()}`,
    role: "user",
    kind: "hook_result",
    content: input.content,
    createdAt,
    hookMetadata: {
      trigger: input.trigger,
      compactionId: input.compactionId,
    },
  }
}

export function renderCompactBoundary(commit: ContextCompactionCommit): string {
  return (
    `[Context boundary ${commit.id}]\n` +
    `Earlier conversation content was compacted into the summary that follows. ` +
    `Use it as working context and continue from the retained messages.`
  )
}

export function renderCompactSummary(commit: ContextCompactionCommit): string {
  return (
    `[Context summary ${commit.id}]\n` +
    `${commit.summary}\n\n` +
    `Use this only as compressed working context.`
  )
}

export function findLastCompactBoundaryIndex(
  records: readonly ContextTranscriptRecord[]
): number {
  for (let index = records.length - 1; index >= 0; index--) {
    if (isCompactBoundaryRecord(records[index]!)) {
      return index
    }
  }
  return -1
}

export function getRecordsAfterCompactBoundary(
  records: readonly ContextTranscriptRecord[],
  options?: { includeSnipped?: boolean }
): ContextTranscriptRecord[] {
  const boundaryIndex = findLastCompactBoundaryIndex(records)
  const sliced =
    boundaryIndex >= 0 ? records.slice(boundaryIndex) : [...records]
  return options?.includeSnipped ? sliced : projectSnippedView(sliced)
}

export function projectSnippedView(
  records: readonly ContextTranscriptRecord[]
): ContextTranscriptRecord[] {
  const removed = new Set<string>()
  for (const record of records) {
    if (!isSnipBoundaryRecord(record)) continue
    for (const id of record.snipMetadata?.removedRecordIds || []) {
      removed.add(id)
    }
  }
  if (removed.size === 0) {
    return [...records]
  }
  return records.filter((record) => !removed.has(record.id))
}

export function getActiveCompactCommitFromTranscript(
  records: readonly ContextTranscriptRecord[]
): ContextCompactionCommit | undefined {
  const index = findLastCompactBoundaryIndex(records)
  if (index < 0) return undefined
  const commit = records[index]?.compactMetadata?.commit
  return isValidCommit(commit) ? commit : undefined
}

export function deriveCompactionHistoryFromTranscript(
  records: readonly ContextTranscriptRecord[]
): ContextCompactionCommit[] {
  const commits: ContextCompactionCommit[] = []
  for (const record of records) {
    if (!isCompactBoundaryRecord(record)) continue
    const commit = record.compactMetadata?.commit
    if (isValidCommit(commit)) {
      commits.push(commit)
    }
  }
  return commits
}

export function stripInternalContextEvents(
  records: readonly ContextTranscriptRecord[]
): ContextTranscriptRecord[] {
  return records.filter(isMessageRecord)
}

export function cloneRecordWithContent(
  record: ContextTranscriptRecord,
  content: LooseMessageContent
): ContextTranscriptRecord {
  return {
    ...record,
    kind: record.kind || "message",
    content,
  }
}

function isValidCommit(value: unknown): value is ContextCompactionCommit {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ContextCompactionCommit).id === "string" &&
    typeof (value as ContextCompactionCommit).archivedThroughRecordId ===
      "string" &&
    typeof (value as ContextCompactionCommit).summary === "string"
  )
}

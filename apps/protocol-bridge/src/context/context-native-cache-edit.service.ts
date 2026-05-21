import { Injectable } from "@nestjs/common"
import {
  CacheEditsBlock,
  ContextConversationState,
  ContextNativeCacheEditState,
  ContentBlock,
  ProjectedContextMessage,
  isCacheEditsBlock,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"

export interface ContextNativeCacheEditApplyResult {
  changed: boolean
  projectedMessages: ProjectedContextMessage[]
  registeredToolResults: number
  newlyRegisteredToolResults: number
  newlyDeletedToolResults: number
  pinnedEditBlocks: number
}

const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "read_file",
  "read_file_v2",
  "view_file",
  "run_terminal_command",
  "terminal",
  "grep_search",
  "glob_search",
  "web_search",
  "web_fetch",
  "edit_file",
  "file_edit",
  "write_file",
  "file_write",
])

const TRIGGER_THRESHOLD = 10
const KEEP_RECENT = 5
const MAX_PINNED_EDIT_BLOCKS = 32

@Injectable()
export class ContextNativeCacheEditService {
  apply(
    state: ContextConversationState,
    projectedMessages: readonly ProjectedContextMessage[]
  ): ContextNativeCacheEditApplyResult {
    const cacheState = this.ensureState(state)
    const scan = this.scanProjected(projectedMessages)
    const newlyRegisteredToolResults = this.registerToolResults(
      cacheState,
      scan.compactableResultIds
    )

    const deletedSet = new Set(cacheState.deletedToolUseIds)
    const activeToolIds = cacheState.toolOrder.filter(
      (id) => !deletedSet.has(id)
    )
    const toDelete =
      activeToolIds.length > TRIGGER_THRESHOLD
        ? activeToolIds.slice(0, activeToolIds.length - KEEP_RECENT)
        : []

    const target = this.findTargetUserMessage(projectedMessages)
    if (toDelete.length > 0 && target) {
      for (const id of toDelete) {
        deletedSet.add(id)
      }
      cacheState.deletedToolUseIds = cacheState.toolOrder.filter((id) =>
        deletedSet.has(id)
      )
      cacheState.pinnedEdits.push({
        targetRecordId: target.message.recordId,
        targetMessageIndex: target.index,
        block: this.createCacheEditsBlock(toDelete),
        createdAt: Date.now(),
      })
      if (cacheState.pinnedEdits.length > MAX_PINNED_EDIT_BLOCKS) {
        cacheState.pinnedEdits = cacheState.pinnedEdits.slice(
          -MAX_PINNED_EDIT_BLOCKS
        )
      }
    }

    if (cacheState.pinnedEdits.length === 0) {
      return {
        changed: false,
        projectedMessages: [...projectedMessages],
        registeredToolResults: scan.compactableResultIds.length,
        newlyRegisteredToolResults,
        newlyDeletedToolResults: 0,
        pinnedEditBlocks: 0,
      }
    }

    const rendered = this.renderCacheEdits(
      projectedMessages,
      cacheState,
      scan.compactableResultIds
    )

    return {
      changed: rendered.changed,
      projectedMessages: rendered.messages,
      registeredToolResults: scan.compactableResultIds.length,
      newlyRegisteredToolResults,
      newlyDeletedToolResults: toDelete.length,
      pinnedEditBlocks: cacheState.pinnedEdits.length,
    }
  }

  reset(state: ContextConversationState): number {
    const cacheState = state.nativeCacheEditState
    if (!cacheState) return 0
    const removed =
      cacheState.toolOrder.length +
      cacheState.deletedToolUseIds.length +
      cacheState.pinnedEdits.length
    state.nativeCacheEditState = {
      toolOrder: [],
      deletedToolUseIds: [],
      pinnedEdits: [],
      toolsSentToApi: false,
    }
    return removed
  }

  private ensureState(
    state: ContextConversationState
  ): ContextNativeCacheEditState {
    const raw = state.nativeCacheEditState
    if (raw) {
      raw.toolOrder = Array.isArray(raw.toolOrder) ? raw.toolOrder : []
      raw.deletedToolUseIds = Array.isArray(raw.deletedToolUseIds)
        ? raw.deletedToolUseIds
        : []
      raw.pinnedEdits = Array.isArray(raw.pinnedEdits) ? raw.pinnedEdits : []
      return raw
    }

    state.nativeCacheEditState = {
      toolOrder: [],
      deletedToolUseIds: [],
      pinnedEdits: [],
      toolsSentToApi: false,
    }
    return state.nativeCacheEditState
  }

  private scanProjected(
    projectedMessages: readonly ProjectedContextMessage[]
  ): {
    compactableResultIds: string[]
  } {
    const compactableToolUseIds = new Set<string>()
    const compactableResultIds: string[] = []
    const seenResultIds = new Set<string>()

    for (const message of projectedMessages) {
      for (const block of this.safeNormalize(message.content)) {
        if (
          message.role === "assistant" &&
          isToolUseBlock(block) &&
          COMPACTABLE_TOOL_NAMES.has(block.name)
        ) {
          compactableToolUseIds.add(block.id)
        }
      }
    }

    for (const message of projectedMessages) {
      if (message.role !== "user") continue
      for (const block of this.safeNormalize(message.content)) {
        if (
          isToolResultBlock(block) &&
          compactableToolUseIds.has(block.tool_use_id) &&
          !seenResultIds.has(block.tool_use_id)
        ) {
          seenResultIds.add(block.tool_use_id)
          compactableResultIds.push(block.tool_use_id)
        }
      }
    }

    return { compactableResultIds }
  }

  private registerToolResults(
    cacheState: ContextNativeCacheEditState,
    toolUseIds: readonly string[]
  ): number {
    const known = new Set(cacheState.toolOrder)
    let registered = 0
    for (const id of toolUseIds) {
      if (known.has(id)) continue
      known.add(id)
      cacheState.toolOrder.push(id)
      registered++
    }
    return registered
  }

  private renderCacheEdits(
    projectedMessages: readonly ProjectedContextMessage[],
    cacheState: ContextNativeCacheEditState,
    compactableResultIds: readonly string[]
  ): { changed: boolean; messages: ProjectedContextMessage[] } {
    const compactableSet = new Set(compactableResultIds)
    const messages = projectedMessages.map((message) => ({
      ...message,
      content: this.cloneContent(message.content),
    }))
    const lastUserIndex = this.findTargetUserMessage(messages)?.index ?? -1
    if (lastUserIndex < 0) {
      return { changed: false, messages }
    }

    let changed = false

    for (let index = 0; index <= lastUserIndex; index++) {
      const message = messages[index]
      if (!message || message.role !== "user") continue
      const content = this.ensureArrayContent(message)
      let updated = false
      const nextContent = content.map((block) => {
        if (
          !isToolResultBlock(block) ||
          !compactableSet.has(block.tool_use_id)
        ) {
          return block
        }
        if (block.cache_reference === block.tool_use_id) {
          return block
        }
        updated = true
        return {
          ...block,
          cache_reference: block.tool_use_id,
        }
      })
      if (updated) {
        message.content = nextContent
        changed = true
      }
    }

    const seenCacheReferences = new Set<string>()
    for (const pin of cacheState.pinnedEdits) {
      const targetIndex = this.resolvePinnedTargetIndex(messages, pin)
      if (targetIndex < 0) continue
      const message = messages[targetIndex]
      if (!message || message.role !== "user") continue
      const deduped = this.dedupeCacheEdits(pin.block, seenCacheReferences)
      if (deduped.edits.length === 0) continue

      const content = this.ensureArrayContent(message)
      this.ensureCacheControl(content)
      this.insertCacheEditsAfterToolResults(content, deduped)
      message.content = content
      changed = true
    }

    return { changed, messages }
  }

  private resolvePinnedTargetIndex(
    messages: readonly ProjectedContextMessage[],
    pin: { targetRecordId?: string; targetMessageIndex: number }
  ): number {
    if (pin.targetRecordId) {
      const byRecord = messages.findIndex(
        (message) =>
          message.role === "user" && message.recordId === pin.targetRecordId
      )
      if (byRecord >= 0) return byRecord
    }
    if (messages[pin.targetMessageIndex]?.role === "user") {
      return pin.targetMessageIndex
    }
    return this.findTargetUserMessage(messages)?.index ?? -1
  }

  private findTargetUserMessage(
    messages: readonly ProjectedContextMessage[]
  ): { index: number; message: ProjectedContextMessage } | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.role === "user") {
        return { index, message }
      }
    }
    return undefined
  }

  private createCacheEditsBlock(
    toolUseIds: readonly string[]
  ): CacheEditsBlock {
    return {
      type: "cache_edits",
      edits: toolUseIds.map((id) => ({
        type: "delete",
        cache_reference: id,
      })),
    }
  }

  private dedupeCacheEdits(
    block: CacheEditsBlock,
    seenCacheReferences: Set<string>
  ): CacheEditsBlock {
    const edits = block.edits.filter((edit) => {
      if (seenCacheReferences.has(edit.cache_reference)) return false
      seenCacheReferences.add(edit.cache_reference)
      return true
    })
    return { type: "cache_edits", edits }
  }

  private insertCacheEditsAfterToolResults(
    content: ContentBlock[],
    block: CacheEditsBlock
  ): void {
    const lastToolResultIndex = content.reduce(
      (lastIndex, item, index) => (isToolResultBlock(item) ? index : lastIndex),
      -1
    )
    const insertAt =
      lastToolResultIndex >= 0 ? lastToolResultIndex + 1 : content.length
    content.splice(insertAt, 0, block)
  }

  private ensureCacheControl(content: ContentBlock[]): void {
    const targetIndex = this.findLastCacheableBlockIndex(content)
    if (targetIndex < 0) {
      content.push({
        type: "text",
        text: "",
        cache_control: { type: "ephemeral" },
      })
      return
    }
    const target = content[targetIndex]
    if (target && !isCacheEditsBlock(target)) {
      target.cache_control = target.cache_control || { type: "ephemeral" }
    }
  }

  private findLastCacheableBlockIndex(
    content: readonly ContentBlock[]
  ): number {
    for (let index = content.length - 1; index >= 0; index--) {
      const block = content[index]
      if (!block || isCacheEditsBlock(block)) continue
      return index
    }
    return -1
  }

  private ensureArrayContent(message: ProjectedContextMessage): ContentBlock[] {
    const content = this.safeNormalize(message.content).map((block) => ({
      ...block,
    }))
    message.content = content
    return content
  }

  private cloneContent(
    content: ProjectedContextMessage["content"]
  ): ProjectedContextMessage["content"] {
    if (typeof content === "string") return content
    return this.safeNormalize(content).map((block) => {
      if (isToolResultBlock(block) && Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map((innerBlock) => ({ ...innerBlock })),
        }
      }
      return { ...block }
    }) as ContentBlock[]
  }

  private safeNormalize(
    content: ProjectedContextMessage["content"]
  ): ContentBlock[] {
    try {
      return normalizeContent(content)
    } catch {
      return []
    }
  }
}

import { Logger } from "@nestjs/common"

import { CodexService } from "../../../../llm/openai/codex.service"
import {
  applyDomainFilters,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * OpenAI Codex Responses-API `web_search` server-tool adapter.
 *
 * Mirrors the wire-shape used inside codex-rs proper: the Responses
 * API exposes `web_search` as a top-level entry in `tools[]`, the
 * model emits `web_search_call` items, and the SSE stream carries
 * `url_citation` annotations alongside the assistant text. The
 * existing `CodexService.executeWebSearch` does exactly that and
 * hands us back `{ text, references }`.
 *
 * Selected for the `codex` and `openai-compat` backends by default.
 * Available iff `CodexService` reports configured account credentials.
 */
export class CodexServerToolAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(CodexServerToolAdapter.name)
  readonly name: WebSearchAdapterName = "codex-server-tool"

  constructor(private readonly codex: CodexService) {}

  isAvailable(): boolean {
    return this.codex.isAvailable()
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const grounded = await this.codex.executeWebSearch({
      query,
      model: options.model,
      conversationId: options.conversationId,
    })

    throwIfAborted(options.signal)

    const raw: WebSearchResult[] = grounded.references.map((ref) => ({
      title: ref.title || ref.url,
      url: ref.url,
      snippet: ref.chunk || undefined,
      chunk: ref.chunk || undefined,
    }))

    const filtered = applyDomainFilters(raw, options)
    const limit = options.numResults ?? 8
    const trimmed =
      Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered

    options.onProgress?.({
      type: "search_results_received",
      query,
      resultCount: trimmed.length,
    })

    const summaryText = grounded.text.trim()

    if (trimmed.length === 0 && summaryText.length === 0) {
      this.logger.warn(
        `[codex-server-tool] empty result (query="${query.slice(0, 80)}")`
      )
      throw new Error(
        "codex-server-tool returned no results (empty web_search_call response)"
      )
    }

    // Codex's server-side web_search occasionally produces a useful
    // assistant summary without emitting any url_citation annotations
    // (typical of zero-state queries like "Cursor pricing 2026" where
    // the model paraphrases known facts after the search call). The
    // upstream WebSearchService treats `results.length === 0` as a
    // hard failure and surfaces "no results" to the model, throwing
    // away the summary text. Project the summary into a single
    // synthetic result so the agent still receives the grounded
    // answer; the synthetic URL stays inside the codex.com namespace
    // so callers can attribute it to the adapter rather than confuse
    // it with a real third-party citation.
    if (trimmed.length === 0 && summaryText.length > 0) {
      this.logger.debug(
        `[codex-server-tool] synthesizing reference from text-only summary ` +
          `(query="${query.slice(0, 80)}")`
      )
      return [
        {
          title: `Codex web_search summary: ${query.slice(0, 80)}`,
          url: `https://codex/web_search?q=${encodeURIComponent(query)}`,
          snippet: summaryText.slice(0, 1000),
          chunk: summaryText,
        },
      ]
    }

    return trimmed
  }
}

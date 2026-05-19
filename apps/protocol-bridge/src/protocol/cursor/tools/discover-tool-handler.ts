/**
 * `discover_tool` — bridge-internal tool that lets the model fetch the
 * full description + input_schema of a deferred tool on demand.
 *
 * This is **not** a Cursor protocol tool: it has no `CLIENT_SIDE_TOOL_V2_*`
 * proto identifier, no IDE-side execution path, and no MCP backing.  It
 * exists only so the bridge can ship a slim tool surface upstream while
 * still letting the model reach less common tools when it needs them.
 *
 * Lifecycle:
 *   1. We inject this tool's definition into every outgoing
 *      `tools` array (when defer is enabled).
 *   2. The system prompt advertises a catalog of deferred tools, each
 *      with a one-line summary, and tells the model to call
 *      `discover_tool({ tool_name })` before using any of them.
 *   3. When the model emits a `tool_use` for `discover_tool`, the
 *      cursor-connect-stream dispatch layer recognises the name, calls
 *      `handleDiscoverToolCall()` instead of the IDE / upstream, and
 *      returns the requested tool's full schema as the tool_result.
 *   4. The session's `discoveredTools` set is updated so subsequent
 *      turns include the discovered tool's full schema in the core
 *      surface — no further `discover_tool` round-trips needed for the
 *      same tool in the same session.
 *
 * Why a dedicated handler module (instead of folding it into
 * `runDeferredToolIfNeeded` etc.):
 *   - The other deferred-family tools have a real Cursor protocol
 *     counterpart and are dispatched via `InteractionQuery` or
 *     `ExecServerMessage`. `discover_tool` is unique: it is satisfied
 *     entirely from in-memory state (the tool catalog).  Keeping it in
 *     a separate file makes the "this never leaves the bridge" property
 *     obvious.
 */

import type { ToolDefinition } from "./cursor-tool-mapper"
import { DISCOVER_TOOL_NAME } from "./tool-defer-policy"

/**
 * Anthropic-style tool definition for `discover_tool`.  Shape matches
 * what `buildToolsForApi()` returns, so it can be appended to the result
 * array directly without any coercion.
 */
export const DISCOVER_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: DISCOVER_TOOL_NAME,
  description:
    "Retrieve the full schema of a tool that was advertised in the " +
    "<deferred_tools> section of the system prompt but is not yet loaded " +
    "for direct invocation. Pass the exact tool name as listed in that " +
    "catalog. The result is the tool's full description and input schema; " +
    "after a successful discovery you may call the tool normally on the " +
    "next turn (no need to call discover_tool again for the same tool in " +
    "this session).\n\n" +
    "Use this only when the catalog tells you the tool exists. Do not " +
    "invent tool names — names not in the catalog will return an error " +
    "and waste a turn.",
  input_schema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "Exact name of the deferred tool to load, copied verbatim from " +
          "the <deferred_tools> catalog (case-sensitive).",
      },
    },
    required: ["tool_name"],
  },
}

/**
 * Result payload returned to the model as the tool_result text.
 *
 * We return JSON rather than a custom format so the model can reliably
 * parse the schema if it wants to. Keeping it boring also makes wire-log
 * inspection trivial.
 */
export interface DiscoverToolSuccess {
  status: "success"
  tool_name: string
  description: string
  input_schema: Record<string, unknown>
  /** When true, the next turn's tools array will include this tool. */
  promoted_to_core: true
}

export interface DiscoverToolError {
  status: "error"
  tool_name: string
  error: string
  /** Names available for discovery, to help the model self-correct. */
  available?: string[]
}

export type DiscoverToolResult = DiscoverToolSuccess | DiscoverToolError

/**
 * The set of tool definitions we know how to discover.  Caller passes
 * the **deferred** subset (i.e. tools that were trimmed out of the
 * upstream payload but are still installed).  We look up by exact name.
 */
export interface DiscoverToolCatalogEntry {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Resolve a `discover_tool` call.  Pure: no I/O, no session mutation;
 * the caller is responsible for adding `result.tool_name` to the
 * session's `discoveredTools` on success.
 */
export function handleDiscoverToolCall(
  toolInput: Record<string, unknown>,
  catalog: ReadonlyMap<string, DiscoverToolCatalogEntry>
): DiscoverToolResult {
  const requested =
    typeof toolInput.tool_name === "string" ? toolInput.tool_name.trim() : ""

  if (!requested) {
    return {
      status: "error",
      tool_name: "",
      error:
        "Missing required parameter `tool_name`. Pass the exact name of " +
        "a deferred tool as listed in the <deferred_tools> catalog.",
      available: Array.from(catalog.keys()).slice(0, 32),
    }
  }

  const entry = catalog.get(requested)
  if (!entry) {
    // Try a case-insensitive lookup as a courtesy; common-failure mode is
    // models lower-casing names that have non-trivial casing (notably
    // some MCP tool prefixes).
    const lowered = requested.toLowerCase()
    let recovered: DiscoverToolCatalogEntry | undefined
    for (const value of catalog.values()) {
      if (value.name.toLowerCase() === lowered) {
        recovered = value
        break
      }
    }
    if (!recovered) {
      return {
        status: "error",
        tool_name: requested,
        error: `Unknown deferred tool "${requested}". Names are case-sensitive; check the <deferred_tools> catalog in the system prompt.`,
        available: Array.from(catalog.keys()).slice(0, 32),
      }
    }
    return {
      status: "success",
      tool_name: recovered.name,
      description: recovered.description,
      input_schema: recovered.input_schema,
      promoted_to_core: true,
    }
  }

  return {
    status: "success",
    tool_name: entry.name,
    description: entry.description,
    input_schema: entry.input_schema,
    promoted_to_core: true,
  }
}

/**
 * Format a `DiscoverToolResult` as the textual tool_result content the
 * model will see.  We render JSON to keep things model-agnostic — every
 * provider will produce useable JSON parsing for this.
 */
export function formatDiscoverToolResultText(
  result: DiscoverToolResult
): string {
  if (result.status === "success") {
    const body = {
      tool_name: result.tool_name,
      description: result.description,
      input_schema: result.input_schema,
      next_step: `You may now call ${result.tool_name} directly. The full schema will remain loaded for the rest of this session.`,
    }
    return `[discover_tool success]\n${JSON.stringify(body, null, 2)}`
  }
  const body: Record<string, unknown> = {
    tool_name: result.tool_name,
    error: result.error,
  }
  if (result.available && result.available.length > 0) {
    body.available_sample = result.available
  }
  return `[discover_tool error]\n${JSON.stringify(body, null, 2)}`
}

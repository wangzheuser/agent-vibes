/**
 * Extract the multi-root workspace folder list from a Cursor agent.v1
 * `RequestContext` plus its `ConversationStateStructure` fallback.
 *
 * Cursor IDE — even on the Agent v1 path that doesn't carry the
 * `aiserver.v1.WorkspaceFolder` message directly — still publishes
 * the user's full multi-root workspace through three correlated
 * signals on `agent.v1.RequestContext` / `agent.v1.ConversationStateStructure`:
 *
 *   1. `requestContext.repositoryInfo[].workspaceUri` (primary)
 *      `RepositoryIndexingInfo` carries one entry per IDE-opened
 *      folder, regardless of whether it's a git repo. Each entry has
 *      `workspaceUri = "file:///abs/path"` and `repoName` (the IDE
 *      label, falls back to the folder's basename when no display
 *      name is set). When the user has 2+ folders open via
 *      `File > Add Folder to Workspace`, this array reflects every
 *      one of them — that's how IDE state propagates to the Agent.
 *
 *   2. `requestContext.gitRepos[].path` (secondary fallback)
 *      Pure local-fs paths Cursor scanned for git metadata. This
 *      misses non-git folders but covers the case where IDE
 *      indexing hasn't populated repositoryInfo yet (cold start).
 *
 *   3. `conversationState.previousWorkspaceUris` (resume fallback)
 *      Snapshot of workspaceUris from the prior request, set by
 *      Cursor when resuming a paused conversation. Used when the
 *      live `repositoryInfo` is empty (e.g. paused → IDE restart →
 *      resume) to avoid losing workspace context across the gap.
 *
 * The helper merges all three sources, deduplicating by resolved
 * absolute path, preserving the first source's ordering. Output is
 * the canonical shape the rest of the bridge consumes —
 * `ParsedCursorRequest.projectContext.workspaceFolders`.
 *
 * Note: we deliberately do NOT consume `aiserver.v1.WorkspaceFolder`
 * here. That message lives on the older `StreamUnifiedChatRequest`
 * Cursor Chat path, which the bridge handles separately. If/when we
 * need to support that path, this helper should grow another
 * `extractFromStreamUnifiedChat` overload that maps
 * `WorkspaceFolder { uri, name }` into the same canonical shape.
 */

import * as nodePath from "path"

/**
 * Structural subset of `agent.v1.ConversationStateStructure` that
 * this helper reads. Using a structural type instead of importing
 * the proto avoids coupling a pure-logic helper to generated code
 * that may change on proto regeneration.
 */
export interface ConversationStateFolderInput {
  previousWorkspaceUris?: readonly string[]
}

/**
 * Subset of `agent.v1.RequestContext` fields this helper reads.
 * Defining a structural type instead of importing the full proto
 * type avoids forcing every caller to handle nullability one field
 * at a time — and keeps the helper trivially testable without
 * proto-encoded fixtures.
 */
export interface WorkspaceFolderExtractionInput {
  repositoryInfo?: ReadonlyArray<{
    readonly workspaceUri?: string
    readonly repoName?: string
  }>
  gitRepos?: ReadonlyArray<{
    readonly path?: string
  }>
}

export interface ExtractedWorkspaceFolder {
  /** Original `file://` URI when the source was URI-shaped, or
   * `file://${path}` synthesized from a path-only source. */
  uri: string
  /** Resolved local absolute path — `file://` prefix stripped and
   * percent-decoded. */
  path: string
  /** IDE-displayed name. Falls back to the basename of `path`. */
  name: string
}

/**
 * Decode a Cursor-style `file://` URI into a local absolute path.
 *
 * Cursor consistently sends `file:///abs/path` (three slashes,
 * authority-empty per RFC 8089). We strip exactly one `file://`
 * prefix, then percent-decode so paths containing spaces or unicode
 * round-trip correctly. Anything that doesn't start with `file://`
 * is treated as already-decoded (e.g. `gitRepos[].path` is a raw
 * filesystem path).
 *
 * Returns "" when the input is empty/whitespace so callers can use
 * a falsy check.
 */
export function decodeWorkspaceUri(uri: string | undefined): string {
  if (!uri) return ""
  const trimmed = uri.trim()
  if (!trimmed) return ""
  const stripped = trimmed.startsWith("file://")
    ? trimmed.slice("file://".length)
    : trimmed
  // Cursor sends `file:///abs/path` with three slashes; after stripping
  // the prefix above we get `/abs/path` which is the correct shape.
  // Windows would produce `/C:/...` here; we leave that alone — Node's
  // path module handles both forms transparently and we don't run on
  // Windows in the bridge today.
  try {
    return decodeURIComponent(stripped)
  } catch {
    // Malformed percent-encoding — return raw stripped value so the
    // boundary check still has something to compare against (and the
    // user sees the unfortunate URI in the error message rather than
    // an opaque "decode failure").
    return stripped
  }
}

/**
 * Pull the basename out of an absolute path for fallback display
 * naming. Strips trailing slashes first so `/foo/bar/` → `bar`.
 */
function basenameOf(absPath: string): string {
  const trimmed = absPath.replace(/[/\\]+$/u, "")
  if (!trimmed) return ""
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed
}

/**
 * Merge `repositoryInfo`, `gitRepos`, and `conversationState
 * .previousWorkspaceUris` into a single ordered, dedup'd workspace
 * folder list.
 *
 * Dedup key is the resolved absolute path. First source wins (so
 * `repositoryInfo` keeps its name even if `gitRepos` has the same
 * path), which matches Cursor's own ordering — the IDE pushes the
 * primary workspace first.
 */
export function extractWorkspaceFolders(
  requestContext: WorkspaceFolderExtractionInput | undefined,
  conversationState?: ConversationStateFolderInput
): ExtractedWorkspaceFolder[] {
  const seen = new Set<string>()
  const out: ExtractedWorkspaceFolder[] = []

  const push = (rawUriOrPath: string | undefined, name: string | undefined) => {
    if (!rawUriOrPath) return
    const decodedPath = decodeWorkspaceUri(rawUriOrPath)
    if (!decodedPath) return
    // Dedup by normalized absolute path so `/tmp/foo` and
    // `/private/tmp/foo` (macOS) collapse into one entry. We use
    // path.resolve (no realpathSync) to avoid I/O on every push —
    // the downstream `resolveAllowedWorkspaceRoots` does the full
    // realpath normalization for boundary checks.
    const normalizedKey = nodePath.resolve(decodedPath)
    if (seen.has(normalizedKey)) return
    seen.add(normalizedKey)
    const uri = rawUriOrPath.trim().startsWith("file://")
      ? rawUriOrPath.trim()
      : `file://${decodedPath}`
    out.push({
      uri,
      path: decodedPath,
      name: (name && name.trim()) || basenameOf(decodedPath) || decodedPath,
    })
  }

  // 1. requestContext.repositoryInfo (primary)
  for (const repo of requestContext?.repositoryInfo || []) {
    push(repo.workspaceUri, repo.repoName)
  }

  // 2. requestContext.gitRepos (secondary fallback — only adds
  //    paths repositoryInfo missed). gitRepos has no display name
  //    so we always synthesize from basename.
  for (const git of requestContext?.gitRepos || []) {
    push(git.path, undefined)
  }

  // 3. conversationState.previousWorkspaceUris (resume fallback)
  for (const uri of conversationState?.previousWorkspaceUris || []) {
    push(uri, undefined)
  }

  return out
}

/**
 * Convenience wrapper that ALSO returns a "primary root" suitable
 * for the legacy `projectContext.rootPath` field. The primary is
 * just the first folder in the merged list — same semantics callers
 * have today via `if (!rootPath) rootPath = path` style early-binding.
 *
 * Returns rootPath="" when no workspace info is available; callers
 * decide whether to fall back to `process.cwd()` or skip the
 * `projectContext` entirely.
 */
export function extractWorkspaceFoldersWithPrimary(
  requestContext: WorkspaceFolderExtractionInput | undefined,
  conversationState?: ConversationStateFolderInput
): {
  rootPath: string
  workspaceFolders: ExtractedWorkspaceFolder[]
} {
  const workspaceFolders = extractWorkspaceFolders(
    requestContext,
    conversationState
  )
  return {
    rootPath: workspaceFolders[0]?.path || "",
    workspaceFolders,
  }
}

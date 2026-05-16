/**
 * Skill 激活策略求解器。
 *
 * 输入：原始 Cursor Rule 列表 + 当前 session 的选中/激活/上下文路径状态。
 * 输出：把每条 rule 分类为「Skill / 普通 rule」，并对 Skill 计算激活原因。
 *
 * 激活规则（与 Cursor 官方协议对齐）：
 *   1. type === "manuallyAttached" → manual
 *   2. selectedRulePaths/Names 命中 → selected
 *   3. activeSkillNames 命中 → previously_loaded
 *   4. paths glob 匹配 contextPaths → path_match
 *
 * Glob 匹配交给 `picomatch`（minimatch 的高性能实现），不重造轮子。
 */

import * as nodePath from "path"
import picomatch from "picomatch"
import type { CursorRule } from "../../../gen/agent/v1_pb"
import {
  normalizePathForMatch,
  normalizeSkillName,
  parseSkillFrontmatter,
} from "./frontmatter"
import type {
  CursorSkillActivationReason,
  CursorSkillMetadata,
  CursorSkillPolicyInput,
  CursorSkillPolicyResult,
} from "./types"

/** 从一组 Cursor Rule 中识别 Skill、计算激活状态、生成 prompt 用 rule 子集。 */
export function resolveCursorSkillPolicy(
  input: CursorSkillPolicyInput
): CursorSkillPolicyResult {
  const rules = input.rules || []
  const selectedPaths = new Set(
    (input.selectedRulePaths || []).map((item) => normalizePathForMatch(item))
  )
  const selectedNames = new Set(
    (input.selectedRuleNames || []).map((item) => normalizeSkillName(item))
  )
  const activeNames = new Set(
    (input.activeSkillNames || []).map((item) => normalizeSkillName(item))
  )
  const contextPaths = input.contextPaths || []

  const promptRules: CursorRule[] = []
  const availableSkills: CursorSkillMetadata[] = []
  const activeSkills: CursorSkillMetadata[] = []
  const inactiveSkills: CursorSkillMetadata[] = []
  const suppressedSkills: CursorSkillMetadata[] = []

  for (const rule of rules) {
    const metadata = getCursorSkillMetadata(rule)
    if (!metadata) {
      promptRules.push(rule)
      continue
    }

    const activationReason = resolveSkillActivationReason({
      metadata,
      rule,
      selectedPaths,
      selectedNames,
      activeNames,
      projectRoot: input.projectRoot,
      contextPaths,
    })
    const active = Boolean(activationReason)
    const skill: CursorSkillMetadata = {
      ...metadata,
      active,
      activationReason: activationReason || undefined,
    }

    availableSkills.push(skill)
    if (active) {
      activeSkills.push(skill)
      promptRules.push(rule)
    } else {
      inactiveSkills.push(skill)
      suppressedSkills.push(skill)
    }
  }

  return {
    promptRules,
    availableSkills: dedupeSkillsByName(availableSkills),
    activeSkills: dedupeSkillsByName(activeSkills),
    inactiveSkills: dedupeSkillsByName(inactiveSkills),
    suppressedSkills: dedupeSkillsByName(suppressedSkills),
  }
}

/** 把单条 Cursor Rule 解析为 Skill metadata；非 Skill 返回 null。 */
export function getCursorSkillMetadata(
  rule: CursorRule
): Omit<CursorSkillMetadata, "active" | "activationReason"> | null {
  const frontmatter = parseSkillFrontmatter(rule.content || "")
  const pathSkillName = extractSkillNameFromPath(rule.fullPath || "")
  const name = normalizeSkillName(frontmatter.name || pathSkillName || "")
  const typeCase = rule.type?.type.case
  const looksLikeSkill =
    Boolean(name) &&
    (typeCase === "agentFetched" ||
      typeCase === "manuallyAttached" ||
      isSkillFilePath(rule.fullPath || "") ||
      Boolean(frontmatter.name))

  if (!looksLikeSkill || !name) {
    return null
  }

  const agentFetchedDescription =
    typeCase === "agentFetched" ? rule.type?.type.value.description : undefined

  return {
    name,
    description:
      frontmatter.description || agentFetchedDescription || undefined,
    whenToUse: frontmatter.whenToUse,
    paths: frontmatter.paths,
    fullPath: rule.fullPath || "",
    content: rule.content || "",
    ruleType: typeCase,
  }
}

/** 按 name 精确查找 Skill；找到时强制返回 active=false。 */
export function findCursorSkillByName(
  rules: CursorRule[] | undefined,
  skillName: string
): CursorSkillMetadata | null {
  const requestedName = normalizeSkillName(skillName)
  if (!requestedName) return null

  for (const rule of rules || []) {
    const metadata = getCursorSkillMetadata(rule)
    if (metadata && metadata.name === requestedName) {
      return { ...metadata, active: false }
    }
  }
  return null
}

/**
 * 给定一个工具尝试访问的路径，反查它是否落在某个 Skill 的内部目录里。
 * 用于「未激活的 Skill 不允许被工具直接读取」的访问拦截。
 */
export function findCursorSkillForInternalPath(
  rules: CursorRule[] | undefined,
  rawPath: string
): CursorSkillMetadata | null {
  const targetPath = normalizePathForMatch(rawPath).toLowerCase()
  if (!targetPath) return null

  for (const rule of rules || []) {
    const metadata = getCursorSkillMetadata(rule)
    if (!metadata) continue
    const skillRoot = normalizePathForMatch(
      nodePath.posix.dirname(normalizePathForMatch(metadata.fullPath))
    ).toLowerCase()
    if (skillRoot && pathIsInside(targetPath, skillRoot)) {
      return { ...metadata, active: false }
    }
    if (metadata.name === "canvas" && isCursorCanvasProjectPath(targetPath)) {
      return { ...metadata, active: false }
    }
  }

  return null
}

/* ---------------- 内部辅助 ---------------- */

function resolveSkillActivationReason(input: {
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
  rule: CursorRule
  selectedPaths: Set<string>
  selectedNames: Set<string>
  activeNames: Set<string>
  projectRoot?: string
  contextPaths: string[]
}): CursorSkillActivationReason | null {
  const { metadata, rule, selectedPaths, selectedNames, activeNames } = input
  if (rule.type?.type.case === "manuallyAttached") {
    return "manual"
  }
  if (selectedPaths.has(normalizePathForMatch(metadata.fullPath))) {
    return "selected"
  }
  if (selectedNames.has(metadata.name)) {
    return "selected"
  }
  if (activeNames.has(metadata.name)) {
    return "previously_loaded"
  }
  if (
    metadata.paths.length > 0 &&
    matchesAnyPath(metadata.paths, input.contextPaths, input.projectRoot)
  ) {
    return "path_match"
  }
  return null
}

function dedupeSkillsByName(
  skills: CursorSkillMetadata[]
): CursorSkillMetadata[] {
  const seen = new Set<string>()
  const result: CursorSkillMetadata[] = []
  for (const skill of skills) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push(skill)
  }
  return result
}

function extractSkillNameFromPath(rawPath: string): string | null {
  const normalizedPath = normalizePathForMatch(rawPath)
  const segments = normalizedPath.split("/").filter(Boolean)
  const fileName = segments[segments.length - 1] || ""
  if (fileName.toLowerCase() !== "skill.md") return null
  return segments[segments.length - 2] || null
}

function isSkillFilePath(rawPath: string): boolean {
  return Boolean(extractSkillNameFromPath(rawPath))
}

function matchesAnyPath(
  patterns: string[],
  contextPaths: string[],
  projectRoot?: string
): boolean {
  if (contextPaths.length === 0) return false
  const matcher = buildPathMatcher(patterns)
  if (!matcher) return false
  const root = projectRoot ? normalizePathForMatch(projectRoot) : ""
  for (const rawPath of contextPaths) {
    const candidate = toRelativePath(rawPath, root)
    if (matcher(candidate)) return true
    // 同时按绝对路径再试一次，兼容 patterns 写成 `/abs/path` 或 `**/foo` 的情况。
    if (matcher(normalizePathForMatch(rawPath).replace(/^\/+/, ""))) return true
  }
  return false
}

function buildPathMatcher(
  patterns: string[]
): ((path: string) => boolean) | null {
  const cleaned = patterns
    .map((pattern) => normalizePathForMatch(pattern).replace(/^\/+/, ""))
    .filter((pattern) => pattern.length > 0)
  if (cleaned.length === 0) return null
  return picomatch(cleaned, {
    dot: true,
    nocase: true,
    contains: true,
  })
}

function toRelativePath(rawPath: string, normalizedRoot: string): string {
  const normalized = normalizePathForMatch(rawPath)
  if (normalizedRoot && pathIsInside(normalized, normalizedRoot)) {
    return normalized.slice(normalizedRoot.length).replace(/^\/+/, "")
  }
  return normalized.replace(/^\/+/, "")
}

function pathIsInside(rawPath: string, rawParent: string): boolean {
  const pathValue = normalizePathForMatch(rawPath).replace(/\/+$/, "")
  const parent = normalizePathForMatch(rawParent).replace(/\/+$/, "")
  return pathValue === parent || pathValue.startsWith(`${parent}/`)
}

function isCursorCanvasProjectPath(normalizedLowerPath: string): boolean {
  const segments = normalizedLowerPath.split("/").filter(Boolean)
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] !== ".cursor" || segments[index + 1] !== "projects") {
      continue
    }
    const projectSegments = segments.slice(index + 2)
    return (
      projectSegments.includes("canvases") ||
      (projectSegments[projectSegments.length - 1] || "").endsWith(
        ".canvas.tsx"
      )
    )
  }
  return false
}

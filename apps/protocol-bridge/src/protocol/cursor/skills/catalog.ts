/**
 * Skill catalog 渲染 —— 把 metadata 列表序列化成 prompt 中的「目录段落」。
 *
 * 策略参考 Claude Code 的 SkillTool/prompt.ts：
 *   1. 先尝试以默认 description 长度渲染整体；
 *   2. 总字符数超预算时，把 description 等比缩短至单条上限；
 *   3. 仍超预算时，最末几条降级为「仅显示名字」。
 *
 * 这样能在长 Skill 列表场景下稳定控制 prompt 体积，
 * 而不像之前那样硬编码 `slice(0, 24)` 把多余 Skill 直接抹掉。
 */

import type { CursorSkillCatalogBudget, CursorSkillMetadata } from "./types"

const DEFAULT_BUDGET: Required<CursorSkillCatalogBudget> = {
  maxTotalChars: 4000,
  maxDescriptionChars: 220,
  maxItems: 32,
}

const SECTION_HEADER_LINES = [
  "Available Cursor Skills:",
  "These are discoverable skill workflows. Inactive skills are listed by metadata only; their full instructions are not active prompt rules.",
  "To activate a skill, call fetch_rules with skill_name, then follow the returned skill instructions.",
  "Do not read skill files or skill-owned internal workspace paths directly before the skill is active.",
  "",
]

const ITEM_NAME_OVERHEAD = 24 // "- name [active:reason]: " 的估算长度

/** 渲染 Skill catalog；列表为空返回 null。 */
export function renderCursorSkillsCatalog(
  skills: CursorSkillMetadata[],
  budget?: CursorSkillCatalogBudget
): string | null {
  if (skills.length === 0) {
    return null
  }
  const limits = { ...DEFAULT_BUDGET, ...(budget || {}) }

  const visibleSkills = skills.slice(0, limits.maxItems)
  const omittedCount = skills.length - visibleSkills.length

  const headerChars = SECTION_HEADER_LINES.reduce(
    (sum, line) => sum + line.length + 1,
    0
  )
  const availableChars = Math.max(0, limits.maxTotalChars - headerChars)

  // 尝试 1：默认 description 长度
  const fullEntries = visibleSkills.map((skill) =>
    formatSkillEntry(skill, limits.maxDescriptionChars)
  )
  const fullTotal = fullEntries.reduce((sum, line) => sum + line.length + 1, 0)
  if (fullTotal <= availableChars) {
    return composeSection(fullEntries, omittedCount)
  }

  // 尝试 2：等比缩短 description
  const overheadPerLine = ITEM_NAME_OVERHEAD + 1
  const totalOverhead = overheadPerLine * visibleSkills.length
  const descBudget = Math.max(
    32,
    Math.floor((availableChars - totalOverhead) / visibleSkills.length)
  )
  if (descBudget < limits.maxDescriptionChars) {
    const truncated = visibleSkills.map((skill) =>
      formatSkillEntry(skill, descBudget)
    )
    const truncatedTotal = truncated.reduce(
      (sum, line) => sum + line.length + 1,
      0
    )
    if (truncatedTotal <= availableChars) {
      return composeSection(truncated, omittedCount)
    }
  }

  // 尝试 3：最末几条降级为 names-only
  const namesOnly = visibleSkills.map((skill) => formatSkillNameOnly(skill))
  return composeSection(namesOnly, omittedCount)
}

function formatSkillEntry(
  skill: CursorSkillMetadata,
  maxDescriptionChars: number
): string {
  const state = skill.active
    ? `active:${skill.activationReason || "unknown"}`
    : "inactive"
  const details = [
    skill.description
      ? `description=${truncate(skill.description, maxDescriptionChars)}`
      : "",
    skill.whenToUse
      ? `when_to_use=${truncate(skill.whenToUse, maxDescriptionChars)}`
      : "",
    skill.paths.length > 0 ? `paths=${skill.paths.join(", ")}` : "",
  ].filter(Boolean)
  return `- ${skill.name} [${state}]${details.length > 0 ? `: ${details.join("; ")}` : ""}`
}

function formatSkillNameOnly(skill: CursorSkillMetadata): string {
  const state = skill.active
    ? `active:${skill.activationReason || "unknown"}`
    : "inactive"
  return `- ${skill.name} [${state}]`
}

function composeSection(entries: string[], omittedCount: number): string {
  const lines = [...SECTION_HEADER_LINES, ...entries]
  if (omittedCount > 0) {
    lines.push(`- ... ${omittedCount} more skill(s) omitted`)
  }
  return lines.join("\n")
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/**
 * SKILL.md 头部 YAML frontmatter 解析。
 *
 * 解析使用 `yaml`（eemeli/yaml）库，支持完整 YAML 1.2 语法。
 * 这里只做：定位 `---` 包围块 → 交给 yaml.parse → 字段归一化。
 *
 * 字段策略：
 *   - 标量字段：name、description、whenToUse（含别名 when_to_use / when-to-use）
 *   - 数组字段：paths（yaml 库自动处理 inline 数组、多行 list、单值容错）
 *   - 解析失败/缺字段静默回退，永不抛出
 */

import { parse as parseYamlDocument } from "yaml"

interface ParsedFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  paths: string[]
}

const FRONTMATTER_FIELD_ALIASES: Record<string, keyof ParsedFrontmatter> = {
  when_to_use: "whenToUse",
  "when-to-use": "whenToUse",
  whenToUse: "whenToUse",
  name: "name",
  description: "description",
  paths: "paths",
}

const FRONTMATTER_DELIMITER = /^\s*---\s*$/

/**
 * 解析 SKILL.md 内容头部的 YAML frontmatter。
 *
 * 没有 frontmatter 或解析失败时返回 `{ paths: [] }`，
 * 调用方应通过 name 是否存在判断该 rule 是否为 Skill。
 */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const block = extractFrontmatterBlock(content)
  if (block === null) {
    return { paths: [] }
  }

  let raw: unknown
  try {
    raw = parseYamlDocument(block)
  } catch {
    return { paths: [] }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { paths: [] }
  }

  const result: ParsedFrontmatter = { paths: [] }
  for (const [rawKey, rawValue] of Object.entries(
    raw as Record<string, unknown>
  )) {
    const canonicalKey = FRONTMATTER_FIELD_ALIASES[rawKey]
    if (!canonicalKey) continue
    if (canonicalKey === "paths") {
      result.paths = coerceStringArray(rawValue)
    } else {
      const text = coerceString(rawValue)
      if (text) result[canonicalKey] = text
    }
  }
  return result
}

/** 仅返回 frontmatter.name，用于诊断/兼容路径。 */
export function extractCursorRuleFrontmatterName(
  content: string
): string | null {
  return parseSkillFrontmatter(content).name || null
}

/** 把 skill name 归一化为小写无空格形式，作为内部唯一键。 */
export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

/** 跨平台路径归一化：把反斜杠统一为正斜杠。 */
export function normalizePathForMatch(value: string): string {
  return value.split("\\").join("/")
}

/* ---------------- 内部 ---------------- */

function extractFrontmatterBlock(content: string): string | null {
  const normalized = content.trimStart().replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  if (!lines[0] || !FRONTMATTER_DELIMITER.test(lines[0])) {
    return null
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && FRONTMATTER_DELIMITER.test(line)
  )
  if (closing < 0) return null
  return lines.slice(1, closing).join("\n")
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceString(item))
      .filter((item): item is string => Boolean(item))
  }
  const single = coerceString(value)
  return single ? [single] : []
}

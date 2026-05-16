/**
 * Skill 描述/路径的轻量搜索。
 *
 * 当 Skill 数量增多、目录文本无法在 prompt 中全部展示时，需要给 Agent
 * 一种「按任务描述反查 Skill」的能力。这里用 `minisearch` 构建一次性
 * inverted index，做 BM25 风格打分。每次调用都重建索引：Cursor 一个 session
 * 的 Skill 数量在 10-50 量级，重建成本 < 1ms，没必要做缓存。
 *
 * 对比方案：
 *   - 自写 TF-IDF：维护成本高
 *   - 引入 fuse.js：模糊匹配但分值不稳定
 *   - minisearch：体积小、API 干净、支持 prefix + fuzzy
 */

import MiniSearch from "minisearch"
import type { CursorSkillMetadata, CursorSkillSearchHit } from "./types"

const SEARCH_FIELDS = ["name", "description", "whenToUse", "paths"] as const
type SearchField = (typeof SEARCH_FIELDS)[number]

interface IndexedSkill {
  id: string
  name: string
  description: string
  whenToUse: string
  paths: string
}

/**
 * 在给定 Skill 列表中按自然语言查询打分排序。
 *
 * @param query 用户/Agent 提供的任务描述
 * @param limit 最多返回几条；默认 5
 */
export function searchCursorSkills(
  skills: CursorSkillMetadata[],
  query: string,
  limit = 5
): CursorSkillSearchHit[] {
  const trimmed = query.trim()
  if (!trimmed || skills.length === 0) {
    return []
  }

  const search = new MiniSearch<IndexedSkill>({
    idField: "id",
    fields: SEARCH_FIELDS as unknown as string[],
    storeFields: ["id"],
    searchOptions: {
      boost: { name: 3, whenToUse: 2, description: 1, paths: 1 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: "OR",
    },
  })

  search.addAll(skills.map(toIndexedSkill))

  const skillsByName = new Map(
    skills.map((skill) => [skill.name, skill] as const)
  )
  const rawHits = search.search(trimmed)
  const hits: CursorSkillSearchHit[] = []
  for (const hit of rawHits) {
    const skill = skillsByName.get(String(hit.id))
    if (!skill) continue
    hits.push({
      skill,
      score: hit.score,
      matchedFields: filterMatchFields(hit.match),
    })
    if (hits.length >= limit) break
  }
  return hits
}

function toIndexedSkill(skill: CursorSkillMetadata): IndexedSkill {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description || "",
    whenToUse: skill.whenToUse || "",
    paths: skill.paths.join(" "),
  }
}

function filterMatchFields(
  match: Record<string, string[]> | undefined
): SearchField[] {
  if (!match) return []
  const result: SearchField[] = []
  for (const field of SEARCH_FIELDS) {
    if (match[field]) result.push(field)
  }
  return result
}

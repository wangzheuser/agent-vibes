import { create } from "@bufbuild/protobuf"

import { CursorRuleSchema, type CursorRule } from "../../../gen/agent/v1_pb"

/**
 * Bridge-internalised behavioral guidelines.
 *
 * These are the "Karpathy guidelines" — behavioral meta-rules that
 * reduce common LLM coding mistakes (think before coding, simplicity,
 * surgical changes, goal-driven execution). They previously only
 * reached the model when the user happened to have a workspace open
 * that ships them as a `.cursor/rules/*.mdc` file. Relying on that was
 * fragile: open a different workspace and the behavioral guidance
 * silently disappeared.
 *
 * Internalising them here makes the guidance unconditional and
 * backend-agnostic. The content is injected as a synthetic
 * `CursorRule` so it flows through the exact same `Cursor Rules:`
 * rendering pipeline every backend translator already implements — no
 * per-backend changes are needed.
 */
export const KARPATHY_GUIDELINES = `# Karpathy behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.`

/**
 * Stable synthetic path for the built-in ruleset. Used as provenance in
 * logs and as the `full_path` the rendering pipeline shows. The
 * `agent-vibes://` scheme makes the bridge origin unmistakable and
 * cannot collide with a real workspace file path.
 */
export const BUILT_IN_KARPATHY_PATH =
  "agent-vibes://built-in/karpathy-guidelines.mdc"

/**
 * Signature substring that identifies a karpathy ruleset regardless of
 * provenance. Lets a client-supplied copy (e.g. a workspace that ships
 * its own `.cursor/rules/karpathy-guidelines.mdc`) suppress the
 * built-in one so the guidance is never duplicated in the prompt.
 */
const KARPATHY_SIGNATURE = "Karpathy behavioral guidelines"

/** True when a rule's content is (any copy of) the karpathy guidelines. */
export function isKarpathyRule(content: string | undefined): boolean {
  return typeof content === "string" && content.includes(KARPATHY_SIGNATURE)
}

/**
 * Construct the synthetic `CursorRule` carrying the karpathy guidelines.
 * Typed as a `global` rule so it always applies, matching how the
 * client ships its own copy.
 */
export function buildBuiltInKarpathyRule(): CursorRule {
  return create(CursorRuleSchema, {
    fullPath: BUILT_IN_KARPATHY_PATH,
    content: KARPATHY_GUIDELINES,
    type: { type: { case: "global", value: {} } },
  })
}

/**
 * Bridge-internalised engineering & UI discipline.
 *
 * Complements the karpathy guidelines with concrete prohibitions the
 * team cares about during real implementation work. Kept as a *separate*
 * rule (not folded into the karpathy text) so each ruleset stays a
 * coherent, independently-editable unit.
 *
 * Unlike karpathy, this content originates only here — no client ever
 * ships it — so no dedup against client-supplied rules is needed.
 */
export const ENGINEERING_DISCIPLINE = `# Engineering & UI discipline

Concrete prohibitions for implementation work. These are about *how* code and UI are written, not *what* to build. Use judgment; when a prohibited pattern is genuinely the right call, say so explicitly and explain why rather than doing it silently.

## Code discipline

**No unreasonable degradation, fallback, or catch-all handling — especially when it silently hides bugs.**
- Do not wrap code in broad try/catch (or equivalent) that swallows errors to "make it work". Let failures surface.
- Do not add silent fallbacks (default values, empty returns, retries) that mask a real failure or a contract violation.
- Do not add defensive branches for conditions that cannot occur. If a condition *can* occur and matters, handle it explicitly and visibly; if it shouldn't, fail loudly.
- A fallback is only acceptable when the degraded path is a real, intended product behavior — and then it must be obvious in the code, not buried.

**No temporary or placeholder implementations.**
- Do not stub a function, return fake data, or leave \`TODO\`/\`not implemented\` in place of real logic.
- If a placeholder is genuinely unavoidable (blocked dependency, staged rollout), you MUST call it out explicitly: state that it's a placeholder, why it exists, and what completing it requires. Never present a placeholder as finished work.

**No redundant or duplicated code.**
- Do not copy-paste logic that already exists; reuse or extract it.
- Do not introduce a second way to do something the codebase already does. Match the existing pattern.
- Before adding a helper/util, check whether an equivalent already exists.

## UI discipline

**No generic emoji or icon overuse.**
- Do not sprinkle generic emoji into UI copy, labels, or headings as decoration.
- Do not add icons that carry no information. An icon must clarify meaning or action, not fill space.

**No unreasonable nesting of cards and bordered containers.**
- Do not stack cards-within-cards or border-within-border for visual effect.
- Prefer spacing, typography, and grouping over wrapping everything in another bordered/elevated container.
- Each level of containment must earn its place with a real structural reason.`

/** Stable synthetic path for the built-in engineering/UI ruleset. */
export const BUILT_IN_DISCIPLINE_PATH =
  "agent-vibes://built-in/engineering-ui-discipline.mdc"

/**
 * Construct the synthetic `CursorRule` carrying the engineering & UI
 * discipline rules. Same `global` typing as the karpathy rule.
 */
export function buildBuiltInDisciplineRule(): CursorRule {
  return create(CursorRuleSchema, {
    fullPath: BUILT_IN_DISCIPLINE_PATH,
    content: ENGINEERING_DISCIPLINE,
    type: { type: { case: "global", value: {} } },
  })
}

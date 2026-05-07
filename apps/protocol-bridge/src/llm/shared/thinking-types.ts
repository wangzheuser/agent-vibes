export type ThinkingIntentEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type ThinkingIntent =
  | { mode: "disabled" }
  | { mode: "adaptive"; effort?: ThinkingIntentEffort }
  | { mode: "explicit_effort"; effort: ThinkingIntentEffort }
  | { mode: "explicit_budget"; budgetTokens: number }

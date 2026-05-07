export const GOOGLE_STARTUP_UPSTREAM_CHECK_ENV =
  "AGENT_VIBES_GOOGLE_STARTUP_UPSTREAM_CHECK"

export function isGoogleStartupUpstreamCheckEnabled(): boolean {
  const raw = process.env[GOOGLE_STARTUP_UPSTREAM_CHECK_ENV]
  if (typeof raw !== "string") return false
  const normalized = raw.trim().toLowerCase()
  return normalized === "true" || normalized === "1"
}

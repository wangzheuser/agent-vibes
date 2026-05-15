/**
 * Discover Kiro credentials cached locally by the Kiro / AWS SSO clients.
 *
 * Scan order:
 *   1. `~/.aws/sso/cache/*.json` — official AWS Builder ID + IdC tokens
 *   2. `<KIRO_USER_DATA>/globalStorage/kiro.kiroAgent/kiro-cache/*.json`
 *      (macOS / Windows / Linux variants)
 *
 * Each candidate file is parsed defensively: invalid JSON or schemas missing
 * the bare-minimum `accessToken` + `refreshToken` pair are skipped.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface DiscoveredKiroToken {
  /** Absolute path of the file that produced this entry. */
  sourcePath: string
  /** "idc" when clientId+clientSecret are present, otherwise "social". */
  authMethod: "idc" | "social"
  region: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
  startUrl?: string
  registrationExpiresAt?: number
}

interface SsoTokenJson {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string | number
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: string | number
}

interface SsoClientRegistrationJson {
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: string | number
}

const AWS_SSO_CACHE_DIRS: string[] = (() => {
  const home = os.homedir()
  switch (process.platform) {
    case "win32":
      return [
        path.join(process.env.USERPROFILE || home, ".aws", "sso", "cache"),
      ]
    default:
      return [path.join(home, ".aws", "sso", "cache")]
  }
})()

const KIRO_GLOBAL_CACHE_DIRS: string[] = (() => {
  const home = os.homedir()
  switch (process.platform) {
    case "darwin":
      return [
        path.join(
          home,
          "Library",
          "Application Support",
          "kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
        path.join(
          home,
          "Library",
          "Application Support",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
      ]
    case "win32": {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming")
      return [
        path.join(
          appData,
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
      ]
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME?.trim()
      const dirs: string[] = []
      if (xdg) {
        dirs.push(
          path.join(
            xdg,
            "Kiro",
            "User",
            "globalStorage",
            "kiro.kiroagent",
            "kiro-cache"
          )
        )
      }
      dirs.push(
        path.join(
          home,
          ".config",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        )
      )
      return dirs
    }
  }
})()

function parseExpiresMs(value: SsoTokenJson["expiresAt"]): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // SSO cache stores absolute seconds; if the value clearly looks like ms,
    // accept it as-is.
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function loadJsonFile<T>(filePath: string): T | null {
  try {
    const buf = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(buf) as T
  } catch {
    return null
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

function buildIdcToken(
  filePath: string,
  parsed: SsoTokenJson,
  registration?: SsoClientRegistrationJson
): DiscoveredKiroToken | null {
  const accessToken = (parsed.accessToken || "").trim()
  const refreshToken = (parsed.refreshToken || "").trim()
  if (!accessToken || !refreshToken) return null

  const clientId =
    (parsed.clientId || registration?.clientId || "").trim() || undefined
  const clientSecret =
    (parsed.clientSecret || registration?.clientSecret || "").trim() ||
    undefined

  const region = (parsed.region || "us-east-1").trim() || "us-east-1"
  const expiresMs = parseExpiresMs(parsed.expiresAt)
  const registrationExpiresMs = parseExpiresMs(
    parsed.registrationExpiresAt || registration?.registrationExpiresAt
  )

  return {
    sourcePath: filePath,
    authMethod: clientId && clientSecret ? "idc" : "social",
    region,
    accessToken,
    refreshToken,
    expiresAt: Math.floor(expiresMs / 1000) || 0,
    clientId,
    clientSecret,
    startUrl: (parsed.startUrl || "").trim() || undefined,
    registrationExpiresAt: registrationExpiresMs
      ? Math.floor(registrationExpiresMs / 1000)
      : undefined,
  }
}

/**
 * Walk a single cache directory, pairing token files with their matching
 * client-registration JSON when one exists. Pairing rule (mirrors the AWS
 * CLI cache layout): both files share the same SHA-1-prefixed file name in
 * the same directory; we additionally support pairing by `startUrl`.
 */
function harvestDirectory(dir: string): DiscoveredKiroToken[] {
  const files = readDirSafe(dir)
  if (files.length === 0) return []

  // Split into candidate buckets.  A file with `accessToken` is a "token"
  // file; one with only `clientId`+`clientSecret` is a registration file.
  const tokenFiles: Array<{ filePath: string; parsed: SsoTokenJson }> = []
  const regFiles: Array<{
    filePath: string
    parsed: SsoClientRegistrationJson
  }> = []
  for (const filePath of files) {
    const parsed = loadJsonFile<SsoTokenJson & SsoClientRegistrationJson>(
      filePath
    )
    if (!parsed) continue
    if (parsed.accessToken && parsed.refreshToken) {
      tokenFiles.push({ filePath, parsed })
    } else if (parsed.clientId && parsed.clientSecret) {
      regFiles.push({ filePath, parsed })
    }
  }

  if (tokenFiles.length === 0) return []

  const result: DiscoveredKiroToken[] = []
  for (const { filePath, parsed } of tokenFiles) {
    let registration: SsoClientRegistrationJson | undefined
    if (!(parsed.clientId && parsed.clientSecret)) {
      // Try to pair by file basename (AWS CLI puts registration alongside).
      const baseName = path.basename(filePath, ".json")
      registration = regFiles.find(
        ({ filePath: rp }) => path.basename(rp, ".json") === baseName
      )?.parsed
      if (!registration && parsed.startUrl) {
        const targetUrl = parsed.startUrl
        registration = regFiles.find(({ parsed: rp }) => {
          const rpAny = rp as Record<string, unknown>
          const ru = typeof rpAny.startUrl === "string" ? rpAny.startUrl : ""
          return ru === targetUrl
        })?.parsed
      }
      if (!registration && regFiles.length === 1) {
        // Single registration → assume it's the one we want.
        registration = regFiles[0]!.parsed
      }
    }
    const built = buildIdcToken(filePath, parsed, registration)
    if (built) result.push(built)
  }
  return result
}

/**
 * Discover all Kiro tokens cached locally.  Order is: AWS SSO cache first
 * (most authoritative for IdC / Builder ID), then Kiro IDE cache.
 */
export function discoverLocalKiroTokens(): DiscoveredKiroToken[] {
  const dirs = [...AWS_SSO_CACHE_DIRS, ...KIRO_GLOBAL_CACHE_DIRS]
  const all: DiscoveredKiroToken[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of harvestDirectory(dir)) {
      // Dedupe by refresh token + region — same identity may be cached in
      // multiple files (one per scope).
      const key = `${entry.region}|${entry.refreshToken}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(entry)
    }
  }
  return all
}

/**
 * Convenience wrapper: pick the freshest discovered token (by `expiresAt`).
 * Returns null when no usable token is cached locally.
 */
export function pickFreshestLocalKiroToken(): DiscoveredKiroToken | null {
  const tokens = discoverLocalKiroTokens()
  if (tokens.length === 0) return null
  return [...tokens].sort((left, right) => right.expiresAt - left.expiresAt)[0]!
}

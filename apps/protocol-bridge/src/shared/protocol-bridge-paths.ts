import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const APP_ROOT_MARKER = "nest-cli.json"
const ACCOUNT_CONFIG_ENV_VARS: Record<string, string> = {
  "antigravity-accounts.json": "AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH",
  "claude-api-accounts.json": "AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH",
  "codex-accounts.json": "AGENT_VIBES_CODEX_ACCOUNTS_PATH",
  "openai-compat-accounts.json": "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH",
  "kiro-accounts.json": "AGENT_VIBES_KIRO_ACCOUNTS_PATH",
}

/**
 * Returns the unified Agent Vibes data directory.
 * Priority: AGENT_VIBES_DATA_DIR env > ~/.agent-vibes/
 */
export function getAgentVibesDataDir(): string {
  return (
    process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes")
  )
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((candidate) => path.resolve(candidate))))
}

export function resolveProtocolBridgeAppRoot(): string {
  const cwd = process.cwd()
  const nestedRoot = path.resolve(cwd, "apps/protocol-bridge")

  if (fs.existsSync(path.join(cwd, APP_ROOT_MARKER))) {
    return cwd
  }

  if (fs.existsSync(path.join(nestedRoot, APP_ROOT_MARKER))) {
    return nestedRoot
  }

  return nestedRoot
}

export function resolveProtocolBridgePath(...segments: string[]): string {
  return path.resolve(resolveProtocolBridgeAppRoot(), ...segments)
}

export function getAccountConfigEnvVarName(filename: string): string | null {
  return ACCOUNT_CONFIG_ENV_VARS[filename] || null
}

export function resolveConfiguredAccountConfigPath(
  filename: string
): string | null {
  const envVar = getAccountConfigEnvVarName(filename)
  if (!envVar) {
    return null
  }

  const configuredPath = process.env[envVar]?.trim()
  if (!configuredPath) {
    return null
  }

  return path.resolve(configuredPath)
}

/**
 * Get candidate paths for an account config file.
 * Priority:
 * 1. Explicit backend-specific env override
 * 2. Unified runtime path (~/.agent-vibes/data/)
 * 3. Legacy dev fallback (only while the unified file is absent)
 */
export function getAccountConfigPathCandidates(filename: string): string[] {
  const configuredPath = resolveConfiguredAccountConfigPath(filename)
  if (configuredPath) {
    return [configuredPath]
  }

  const unifiedPath = path.resolve(getAgentVibesDataDir(), "data", filename)
  if (fs.existsSync(unifiedPath)) {
    return [unifiedPath]
  }

  return uniquePaths([
    unifiedPath,
    resolveProtocolBridgePath("data", filename),
    resolveProtocolBridgePath("data", "accounts", filename),
  ])
}

export function resolveDefaultAccountConfigPath(filename: string): string {
  return (
    resolveConfiguredAccountConfigPath(filename) ||
    path.resolve(getAgentVibesDataDir(), "data", filename)
  )
}

export function getAntigravityAccountsConfigPathCandidates(): string[] {
  const primaryCandidates = getAccountConfigPathCandidates(
    "antigravity-accounts.json"
  )
  const configuredPath = resolveConfiguredAccountConfigPath(
    "antigravity-accounts.json"
  )

  if (configuredPath || fs.existsSync(primaryCandidates[0]!)) {
    return primaryCandidates
  }

  return uniquePaths([
    ...primaryCandidates,
    resolveProtocolBridgePath("data", "accounts.json"),
  ])
}

export function getAntigravityIdeStateDbPathCandidates(): string[] {
  const explicitStateDbPath =
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_STATE_DB_PATH?.trim()
  if (explicitStateDbPath) {
    return [path.resolve(explicitStateDbPath)]
  }

  const explicitDataDir =
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_DATA_DIR?.trim()
  if (explicitDataDir) {
    return [path.resolve(explicitDataDir, "state.vscdb")]
  }

  const home = os.homedir()
  const candidates: string[] = []

  switch (process.platform) {
    case "darwin":
      candidates.push(
        path.join(
          home,
          "Library",
          "Application Support",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    case "linux": {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
      if (xdgConfigHome) {
        candidates.push(
          path.join(
            xdgConfigHome,
            "Antigravity",
            "User",
            "globalStorage",
            "state.vscdb"
          )
        )
      }
      candidates.push(
        path.join(
          home,
          ".config",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    }
    case "win32": {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming")
      candidates.push(
        path.join(
          appData,
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    }
    default:
      candidates.push(
        path.join(
          home,
          ".config",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
  }

  return uniquePaths(candidates)
}

function normalizeIdeVersion(rawValue: unknown): string | null {
  const rawString =
    typeof rawValue === "string" || typeof rawValue === "number"
      ? String(rawValue)
      : ""
  const raw = rawString
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!raw) {
    return null
  }

  const match = raw.match(/(?:Version:\s*)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)
  return match?.[1] || raw
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  if (!fs.existsSync(packageJsonPath)) {
    return null
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return normalizeIdeVersion(parsed.version)
  } catch {
    return null
  }
}

function readVersionFromInfoPlist(infoPlistPath: string): string | null {
  if (!fs.existsSync(infoPlistPath)) {
    return null
  }

  try {
    const plist = fs.readFileSync(infoPlistPath, "utf8")
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    )
    return normalizeIdeVersion(match?.[1])
  } catch {
    return null
  }
}

function readVersionFromAppPath(appPath: string): string | null {
  const normalizedAppPath = appPath.trim()
  if (!normalizedAppPath) {
    return null
  }

  const lowerBaseName = path.basename(normalizedAppPath).toLowerCase()
  if (lowerBaseName === "package.json") {
    return readVersionFromPackageJson(normalizedAppPath)
  }
  if (lowerBaseName === "info.plist") {
    return readVersionFromInfoPlist(normalizedAppPath)
  }

  let appRootPath = normalizedAppPath
  try {
    if (
      fs.existsSync(normalizedAppPath) &&
      fs.statSync(normalizedAppPath).isFile()
    ) {
      appRootPath = path.dirname(normalizedAppPath)
    }
  } catch {
    appRootPath = normalizedAppPath
  }

  const packageJsonCandidates = [
    path.join(appRootPath, "package.json"),
    path.join(appRootPath, "resources", "app", "package.json"),
    path.join(appRootPath, "Resources", "app", "package.json"),
    path.join(appRootPath, "Contents", "Resources", "app", "package.json"),
    path.join(appRootPath, "Contents", "resources", "app", "package.json"),
  ]

  const plistCandidates = [
    path.join(appRootPath, "Contents", "Info.plist"),
    path.join(appRootPath, "Info.plist"),
  ]

  // For a macOS .app bundle, Info.plist (CFBundleShortVersionString) holds the
  // PRODUCT version (e.g. Antigravity 2.0.4), whereas the bundled
  // Resources/app/package.json only carries the underlying VS Code shell
  // version (e.g. 1.107.0). Probe the plist first so VS Code-based apps report
  // their real product version. When a package.json path is passed directly
  // (no .app bundle), this falls through to the package.json scan unchanged.
  const isMacAppBundle = appRootPath.toLowerCase().endsWith(".app")
  const orderedCandidates = isMacAppBundle
    ? [
        { kind: "plist" as const, paths: plistCandidates },
        { kind: "package" as const, paths: packageJsonCandidates },
      ]
    : [
        { kind: "package" as const, paths: packageJsonCandidates },
        { kind: "plist" as const, paths: plistCandidates },
      ]

  for (const group of orderedCandidates) {
    for (const candidate of group.paths) {
      const version =
        group.kind === "plist"
          ? readVersionFromInfoPlist(candidate)
          : readVersionFromPackageJson(candidate)
      if (version) {
        return version
      }
    }
  }

  return null
}

function getWindowsAppPathCandidates(appName: string): string[] {
  const home = os.homedir()
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files"
  const programFilesX86 =
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"

  return [
    path.join(localAppData, "Programs", appName),
    path.join(localAppData, appName),
    path.join(programFiles, appName),
    path.join(programFilesX86, appName),
  ]
}

function getLinuxAppPathCandidates(appName: string): string[] {
  const home = os.homedir()
  const lowerName = appName.toLowerCase()
  const xdgDataHome =
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share")

  return [
    path.join("/usr", "share", lowerName),
    path.join("/usr", "share", appName),
    path.join("/opt", lowerName),
    path.join("/opt", appName),
    path.join(xdgDataHome, lowerName),
    path.join(xdgDataHome, appName),
  ]
}

function getAntigravityAppPathCandidates(): string[] {
  const envPath = String(process.env.ANTIGRAVITY_APP_PATH || "").trim()
  const candidates = envPath ? [envPath] : []

  switch (process.platform) {
    case "darwin":
      candidates.push(
        "/Applications/Antigravity.app",
        "/Applications/Antigravity IDE.app",
        "/Applications/Antigravity Beta.app",
        "/Applications/Setapp/Antigravity.app",
        path.join(os.homedir(), "Applications", "Antigravity.app"),
        path.join(os.homedir(), "Applications", "Antigravity IDE.app")
      )
      break
    case "win32":
      candidates.push(...getWindowsAppPathCandidates("Antigravity"))
      break
    case "linux":
      candidates.push(...getLinuxAppPathCandidates("Antigravity"))
      break
    default:
      candidates.push(...getLinuxAppPathCandidates("Antigravity"))
      break
  }

  return uniquePaths(candidates)
}

export function detectCurrentAntigravityVersion(): string | null {
  const explicitVersion = normalizeIdeVersion(
    process.env.ANTIGRAVITY_IDE_VERSION
  )
  if (explicitVersion) {
    return explicitVersion
  }

  for (const candidate of getAntigravityAppPathCandidates()) {
    const version = readVersionFromAppPath(candidate)
    if (version) {
      return version
    }
  }

  return null
}

function getKiroAppPathCandidates(): string[] {
  const envPath = String(process.env.KIRO_APP_PATH || "").trim()
  const candidates = envPath ? [envPath] : []

  switch (process.platform) {
    case "darwin":
      candidates.push(
        "/Applications/Kiro.app",
        "/Applications/Kiro - Insiders.app",
        "/Applications/Kiro Beta.app",
        "/Applications/Setapp/Kiro.app",
        path.join(os.homedir(), "Applications", "Kiro.app")
      )
      break
    case "win32":
      candidates.push(
        ...getWindowsAppPathCandidates("Kiro"),
        ...getWindowsAppPathCandidates("Kiro - Insiders"),
        ...getWindowsAppPathCandidates("Kiro Beta")
      )
      break
    case "linux":
      candidates.push(
        ...getLinuxAppPathCandidates("Kiro"),
        ...getLinuxAppPathCandidates("Kiro - Insiders"),
        ...getLinuxAppPathCandidates("Kiro Beta")
      )
      break
    default:
      candidates.push(...getLinuxAppPathCandidates("Kiro"))
      break
  }

  return uniquePaths(candidates)
}

export function detectCurrentKiroVersion(): string | null {
  const explicitVersion = normalizeIdeVersion(process.env.KIRO_VERSION)
  if (explicitVersion) {
    return explicitVersion
  }

  for (const candidate of getKiroAppPathCandidates()) {
    const version = readVersionFromAppPath(candidate)
    if (version) {
      return version
    }
  }

  return null
}

export function resolveAntigravityIdeStateDbPath(): string {
  const candidates = getAntigravityIdeStateDbPathCandidates()
  const existing = candidates.find((candidate) => fs.existsSync(candidate))
  return existing || candidates[0]!
}

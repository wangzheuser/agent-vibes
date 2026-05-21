import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function normalizeKiroVersion(rawValue: unknown): string | null {
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
    return normalizeKiroVersion(parsed.version)
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
    return normalizeKiroVersion(match?.[1])
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

  for (const candidate of packageJsonCandidates) {
    const version = readVersionFromPackageJson(candidate)
    if (version) {
      return version
    }
  }

  const plistCandidates = [
    path.join(appRootPath, "Contents", "Info.plist"),
    path.join(appRootPath, "Info.plist"),
  ]

  for (const candidate of plistCandidates) {
    const version = readVersionFromInfoPlist(candidate)
    if (version) {
      return version
    }
  }

  return null
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((candidate) => path.resolve(candidate))))
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
  const envVersion = normalizeKiroVersion(process.env.KIRO_VERSION)
  if (envVersion) {
    return envVersion
  }

  for (const candidate of getKiroAppPathCandidates()) {
    const version = readVersionFromAppPath(candidate)
    if (version) {
      return version
    }
  }

  return null
}

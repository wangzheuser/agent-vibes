#!/usr/bin/env node
/**
 * Antigravity Traffic Capture
 *
 * Captures official Antigravity IDE -> Cloud Code API traffic by inserting
 * mitmdump into Clash Verge's runtime config and reloading mihomo via API.
 *
 * Flow: Antigravity IDE -> TUN -> Clash -> capture-mitm(:10444) -> Clash(VMess) -> Cloud Code
 *
 * How it works:
 *   capture:start  - Patches clash-verge.yaml to add capture-mitm proxy and
 *                     routing rules, reloads mihomo via API, then starts mitmdump.
 *   capture:stop   - Removes the runtime patch, kills mitmdump, reloads mihomo.
 *   capture:repair - Restores the runtime config if capture rules were left behind after an
 *                     unexpected exit or Clash restart.
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { spawn, spawnSync } = require("node:child_process")

const SCRIPT_DIR = __dirname
const MITM_PORT = 10444
const LOG_DIR = path.join(SCRIPT_DIR, "traffic_dumps")
const CAPTURE_SCRIPT = path.join(SCRIPT_DIR, "capture-google-traffic.py")
const platform = require("../lib/platform")

// Clash Verge runtime config paths
const CLASH_DIR = platform.clashConfigDir()
const CLASH_RUNTIME_CONFIG = path.join(CLASH_DIR, "clash-verge.yaml")
const CLASH_SOCKET_DEFAULT = "/tmp/verge/verge-mihomo.sock"
const CAPTURE_PROXY_BLOCK_BEGIN = "# >>> agent-vibes capture proxy"
const CAPTURE_PROXY_BLOCK_END = "# <<< agent-vibes capture proxy"
const CAPTURE_RULE_BLOCK_BEGIN = "# >>> agent-vibes capture rules"
const CAPTURE_RULE_BLOCK_END = "# <<< agent-vibes capture rules"

let mitmdumpBin = null

/**
 * Cross-platform shell command executor.
 * Uses bash on Unix, cmd on Windows.
 */
function runShell(cmd, ok = false) {
  const isWin = platform.PLATFORM === "win32"
  const shell = isWin ? "cmd" : "bash"
  const shellArgs = isWin ? ["/c", cmd] : ["-lc", cmd]
  const r = spawnSync(shell, shellArgs, { stdio: "inherit" })
  if (r.status !== 0 && !ok) process.exit(r.status ?? 1)
  return r
}

/**
 * Cross-platform shell command executor that captures output.
 */
function runShellCapture(cmd, ok = false) {
  const isWin = platform.PLATFORM === "win32"
  const shell = isWin ? "cmd" : "bash"
  const shellArgs = isWin ? ["/c", cmd] : ["-lc", cmd]
  const r = spawnSync(shell, shellArgs, { encoding: "utf-8", stdio: "pipe" })
  if (r.status !== 0 && !ok) process.exit(r.status ?? 1)
  return (r.stdout || "").trim()
}

function runCapture(command, args, ok = false) {
  const r = spawnSync(command, args, { encoding: "utf-8", stdio: "pipe" })
  if (r.error && !ok) {
    console.error(r.error.message)
    process.exit(1)
  }
  if ((r.status ?? 1) !== 0 && !ok) process.exit(r.status ?? 1)
  return {
    error: r.error,
    status: r.status ?? (r.error ? 1 : 0),
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  }
}

/**
 * Read the Clash external controller secret from config.yaml.
 */
function readClashSecret() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^secret:\s*(.+)/)
      if (m) return m[1].trim()
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Resolve the Clash external controller Unix socket path from config.yaml.
 * Used on macOS/Linux. Falls back to CLASH_SOCKET_DEFAULT.
 */
function readClashSocket() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^external-controller-unix:\s*(.+)/)
      if (m) return m[1].trim()
    }
  } catch {
    // ignore
  }
  return CLASH_SOCKET_DEFAULT
}

/**
 * Resolve the Clash external controller TCP address from config.yaml.
 * Used on Windows, or as fallback on other platforms.
 * Returns { host, port } or null.
 */
function readClashTcpController() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^external-controller:\s*(.+)/)
      if (m) {
        const addr = m[1].trim().replace(/^['"]|['"]$/g, "")
        if (!addr) continue
        // Parse host:port (e.g., "127.0.0.1:9097" or ":9090")
        const colonIdx = addr.lastIndexOf(":")
        if (colonIdx === -1) continue
        const host = addr.slice(0, colonIdx) || "127.0.0.1"
        const port = parseInt(addr.slice(colonIdx + 1), 10)
        if (!isNaN(port)) return { host, port }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Make an HTTP request to the Clash API.
 * On macOS/Linux: prefers Unix socket, falls back to TCP.
 * On Windows: uses TCP only.
 */
function clashApiRequest(method, apiPath, body = null) {
  const secret = readClashSecret()
  const headers = { "Content-Type": "application/json" }
  if (secret) headers["Authorization"] = `Bearer ${secret}`

  return new Promise((resolve) => {
    function doRequest(opts) {
      const req = http.request(opts, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve({ statusCode: res.statusCode, data }))
      })
      req.on("error", (err) => resolve({ statusCode: 0, error: err.message }))
      if (body)
        req.write(typeof body === "string" ? body : JSON.stringify(body))
      req.end()
    }

    // Windows: TCP only
    if (platform.PLATFORM === "win32") {
      const tcp = readClashTcpController()
      if (!tcp) {
        resolve({
          statusCode: 0,
          error: "No TCP external-controller configured",
        })
        return
      }
      doRequest({
        hostname: tcp.host,
        port: tcp.port,
        path: apiPath,
        method,
        headers,
      })
      return
    }

    // macOS/Linux: try Unix socket first, fall back to TCP
    const socketPath = readClashSocket()
    const socketReq = http.request(
      { socketPath, path: apiPath, method, headers },
      (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve({ statusCode: res.statusCode, data }))
      }
    )
    socketReq.on("error", () => {
      // Socket failed, try TCP fallback
      const tcp = readClashTcpController()
      if (!tcp) {
        resolve({
          statusCode: 0,
          error: "Cannot reach Clash API (no socket or TCP controller)",
        })
        return
      }
      doRequest({
        hostname: tcp.host,
        port: tcp.port,
        path: apiPath,
        method,
        headers,
      })
    })
    if (body)
      socketReq.write(typeof body === "string" ? body : JSON.stringify(body))
    socketReq.end()
  })
}

/**
 * Reload Clash config via external controller API.
 */
function reloadClash() {
  return clashApiRequest("PUT", "/configs?force=true", {
    path: CLASH_RUNTIME_CONFIG,
  }).then((res) => {
    if (res.statusCode === 204 || res.statusCode === 200) {
      console.log("✓ Clash runtime config reloaded via API")
    } else if (res.error) {
      console.log(`⚠ Cannot reach Clash API: ${res.error}`)
      console.log("  Please restart Clash Verge manually.")
    } else {
      console.log(
        `⚠ Clash API returned ${res.statusCode}: ${(res.data || "").trim() || "(empty)"}`
      )
      console.log("  Please restart Clash Verge manually.")
    }
  })
}

async function flushClashCaches() {
  const requests = [
    { method: "POST", path: "/cache/dns/flush", label: "DNS cache" },
    { method: "POST", path: "/cache/fakeip/flush", label: "fake-ip cache" },
  ]

  for (const req of requests) {
    const res = await clashApiRequest(req.method, req.path)
    if (res.statusCode === 204 || res.statusCode === 200) {
      console.log(`✓ ${req.label} flushed`)
    } else if (res.error) {
      console.log(`⚠ Cannot flush ${req.label}: ${res.error}`)
    } else {
      console.log(`⚠ Cannot flush ${req.label}: API returned ${res.statusCode}`)
    }
  }
}

/**
 * Fetch Clash runtime rules via API.
 */
function fetchClashRules() {
  return clashApiRequest("GET", "/rules").then((res) => {
    try {
      return JSON.parse(res.data || "null")
    } catch {
      return null
    }
  })
}

function resolveMitmdump() {
  if (mitmdumpBin) return mitmdumpBin
  const r = spawnSync(
    platform.PLATFORM === "win32" ? "where" : "bash",
    platform.PLATFORM === "win32"
      ? ["mitmdump"]
      : ["-lc", "command -v mitmdump"],
    { encoding: "utf-8" }
  )
  const p = (r.stdout || "").trim().split("\n")[0]
  if (r.status === 0 && p) {
    mitmdumpBin = p
    return p
  }
  for (const b of platform.mitmdumpCandidates()) {
    if (fs.existsSync(b)) {
      mitmdumpBin = b
      return b
    }
  }
  console.error("mitmdump not found. Install mitmproxy for your platform.")
  process.exit(1)
}

function parseWindowsProcessList(raw) {
  return raw
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const fields = {}
      for (const line of block.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.includes("=")) continue
        const idx = trimmed.indexOf("=")
        fields[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).trim()
      }
      const pid = parseInt(fields.ProcessId, 10)
      if (isNaN(pid)) return null
      return {
        Name: fields.Name || "unknown",
        ProcessId: pid,
      }
    })
    .filter(Boolean)
}

function queryWindowsProcesses(whereClause) {
  if (platform.PLATFORM !== "win32") return []
  const result = runCapture(
    "wmic",
    ["process", "where", whereClause, "get", "ProcessId,Name", "/format:list"],
    true
  )
  if (result.error || result.status !== 0) return []
  return parseWindowsProcessList(result.stdout)
}

function getManagedWindowsMitmdumpProcesses() {
  return queryWindowsProcesses("CommandLine like '%mitmdump%capture-traffic%'")
}

function getManagedUnixMitmdumpProcesses() {
  if (platform.PLATFORM === "win32") return []
  const result = runCapture("ps", ["-axo", "pid=,command="], true)
  if (result.error || result.status !== 0 || !result.stdout) return []

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        line.includes("mitmdump") &&
        line.includes("capture-traffic") &&
        !line.includes("pgrep") &&
        !line.includes("rg ")
    )
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) return { Name: line, ProcessId: null }
      return {
        Name: match[2],
        ProcessId: parseInt(match[1], 10),
      }
    })
}

function getManagedMitmdumpProcesses() {
  return platform.PLATFORM === "win32"
    ? getManagedWindowsMitmdumpProcesses()
    : getManagedUnixMitmdumpProcesses()
}

function printProcessStatus(label, processes) {
  if (processes.length === 0) {
    console.log(`  ${label}: not running`)
    return
  }

  console.log(`  ${label}:`)
  for (const proc of processes) {
    const pidSuffix =
      proc.ProcessId == null || Number.isNaN(proc.ProcessId)
        ? ""
        : ` (pid ${proc.ProcessId})`
    console.log(`    ${proc.Name}${pidSuffix}`)
  }
}

function readClashRuntimeConfig() {
  if (!fs.existsSync(CLASH_RUNTIME_CONFIG)) {
    throw new Error("Cannot find clash-verge.yaml")
  }
  return fs.readFileSync(CLASH_RUNTIME_CONFIG, "utf-8")
}

function writeClashRuntimeConfig(content) {
  try {
    fs.writeFileSync(CLASH_RUNTIME_CONFIG, content)
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "EPERM") throw err
    // clash-verge.yaml is owned by root in some setups. Elevate only this
    // single write via sudo so the rest of capture can run as the normal user
    // (the GUI launch must not run as root). Fails loudly if sudo is missing.
    if (platform.PLATFORM === "win32") throw err
    const tmp = path.join(os.tmpdir(), `agent-vibes-clash-${process.pid}.yaml`)
    fs.writeFileSync(tmp, content)
    try {
      const r = spawnSync("sudo", ["cp", tmp, CLASH_RUNTIME_CONFIG], {
        stdio: "inherit",
      })
      if (r.status !== 0) {
        throw new Error(
          "Failed to write clash-verge.yaml via sudo (exit " + r.status + ")"
        )
      }
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }
}

function stripCaptureBlocks(content) {
  return content
    .replace(
      new RegExp(
        `\\n?${CAPTURE_PROXY_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CAPTURE_PROXY_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
        "g"
      ),
      "\n"
    )
    .replace(
      new RegExp(
        `\\n?${CAPTURE_RULE_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CAPTURE_RULE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
        "g"
      ),
      "\n"
    )
    .replace(/\n{3,}/g, "\n\n")
}

function isCaptureInjected(content) {
  return (
    content.includes(CAPTURE_PROXY_BLOCK_BEGIN) ||
    content.includes(CAPTURE_RULE_BLOCK_BEGIN)
  )
}

function extractNamedEntries(content, sectionName) {
  const lines = content.split(/\r?\n/)
  const names = []
  let inSection = false

  for (const line of lines) {
    if (line === `${sectionName}:`) {
      inSection = true
      continue
    }
    if (
      inSection &&
      /^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(line) &&
      !line.startsWith(" ")
    ) {
      break
    }
    if (!inSection) continue

    const match = line.match(/^- name:\s*(.+)$/)
    if (match) names.push(match[1].trim())
  }

  return names
}

function resolveCaptureUpstream(content) {
  const groupNames = extractNamedEntries(content, "proxy-groups")
  if (groupNames.includes("PROXY")) return "PROXY"
  if (groupNames.length > 0) return groupNames[0]

  const proxyNames = extractNamedEntries(content, "proxies").filter(
    (name) => name !== "capture-mitm"
  )
  if (proxyNames.length > 0) return proxyNames[0]

  throw new Error(
    "Cannot find a usable upstream proxy target in clash-verge.yaml"
  )
}

function buildCaptureProxyBlock() {
  return [
    CAPTURE_PROXY_BLOCK_BEGIN,
    "- name: capture-mitm",
    "  type: http",
    "  server: 127.0.0.1",
    `  port: ${MITM_PORT}`,
    CAPTURE_PROXY_BLOCK_END,
  ].join("\n")
}

function buildCaptureRuleBlock(upstreamTarget) {
  return [
    CAPTURE_RULE_BLOCK_BEGIN,
    `- PROCESS-NAME,mitmdump,${upstreamTarget}`,
    "- DOMAIN-SUFFIX,googleapis.com,capture-mitm",
    CAPTURE_RULE_BLOCK_END,
  ].join("\n")
}

function applyCaptureRuntimePatch() {
  const cleanContent = stripCaptureBlocks(readClashRuntimeConfig())
  const upstreamTarget = resolveCaptureUpstream(cleanContent)

  if (!/^proxies:\s*$/m.test(cleanContent)) {
    throw new Error("Cannot find proxies section in clash-verge.yaml")
  }
  if (!/^rules:\s*$/m.test(cleanContent)) {
    throw new Error("Cannot find rules section in clash-verge.yaml")
  }

  let patched = cleanContent.replace(
    /^proxies:\s*$/m,
    `proxies:\n${buildCaptureProxyBlock()}`
  )
  patched = patched.replace(
    /^rules:\s*$/m,
    `rules:\n${buildCaptureRuleBlock(upstreamTarget)}`
  )
  writeClashRuntimeConfig(patched)

  return upstreamTarget
}

function removeCaptureRuntimePatch() {
  const current = readClashRuntimeConfig()
  const stripped = stripCaptureBlocks(current)
  const changed = stripped !== current
  if (changed) writeClashRuntimeConfig(stripped)
  return changed
}

function isLocalPortListening(port, timeoutMs = 500) {
  const net = require("node:net")
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ host: "127.0.0.1", port })

    function finish(result) {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.on("connect", () => finish(true))
    socket.on("timeout", () => finish(false))
    socket.on("error", () => finish(false))
  })
}

async function inspectCaptureState() {
  const runtimeConfig = readClashRuntimeConfig()
  const runtimePatched = isCaptureInjected(runtimeConfig)
  const managedMitmdumpProcesses = getManagedMitmdumpProcesses()
  const managedMitmdumpRunning = managedMitmdumpProcesses.length > 0
  const mitmPortListening = await isLocalPortListening(MITM_PORT)

  return {
    runtimePatched,
    managedMitmdumpProcesses,
    managedMitmdumpRunning,
    mitmPortListening,
    staleInjection:
      runtimePatched && !managedMitmdumpRunning && !mitmPortListening,
    portOccupiedWithoutManagedMitmdump:
      mitmPortListening && !managedMitmdumpRunning,
  }
}

/**
 * Wait for a TCP port to accept connections.
 */
function waitForPort(port, timeoutMs = 8000) {
  const net = require("node:net")
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`))
      }
      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy()
        resolve()
      })
      sock.on("error", () => {
        setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

/**
 * Restore Clash runtime config (remove capture rules). Safe to call multiple times.
 */
async function restoreClash() {
  let changed = false
  try {
    changed = removeCaptureRuntimePatch()
  } catch {
    return
  }
  if (changed) {
    console.log("\n✓ Removed capture injection from clash-verge.yaml.")
  } else {
    console.log("\n✓ clash-verge.yaml already clean.")
  }
  console.log("Reloading Clash runtime config...")
  await reloadClash()
  await flushClashCaches()
}

async function cmdStart() {
  if (!fs.existsSync(CAPTURE_SCRIPT)) {
    console.error("No capture-google-traffic.py found")
    process.exit(1)
  }
  const mitmdump = resolveMitmdump()
  fs.mkdirSync(LOG_DIR, { recursive: true })

  console.log("Runtime config: " + CLASH_RUNTIME_CONFIG)

  let captureState = await inspectCaptureState()
  if (captureState.staleInjection) {
    console.log("")
    console.log(
      "Detected stale runtime capture injection. Clash still points googleapis.com to capture-mitm," +
        " but mitmdump is no longer running."
    )
    console.log("Repairing Clash before starting a new capture session...")
    await restoreClash()
    captureState = await inspectCaptureState()
  }

  if (captureState.managedMitmdumpRunning && captureState.runtimePatched) {
    console.log("")
    console.log("Capture is already running.")
    console.log(
      "Use `npm run antigravity:capture:stop` before starting a new session."
    )
    return
  }

  if (captureState.managedMitmdumpRunning && !captureState.runtimePatched) {
    console.error(
      "Managed mitmdump is already running, but clash-verge.yaml is not in capture mode."
    )
    console.error("Run `npm run antigravity:capture:repair` before retrying.")
    process.exit(1)
  }

  if (captureState.portOccupiedWithoutManagedMitmdump) {
    console.error(
      "Port " +
        MITM_PORT +
        " is already occupied by another process. Refusing to start capture."
    )
    console.error(
      "Run `npm run antigravity:capture:repair` and free the port before retrying."
    )
    process.exit(1)
  }

  // ── Step 1: Start mitmdump FIRST (before touching Clash) ──
  console.log("")
  console.log("Starting mitmdump on port " + MITM_PORT + "...")

  const mitmProc = spawn(
    mitmdump,
    [
      "--listen-port",
      String(MITM_PORT),
      "--ssl-insecure",
      "-s",
      CAPTURE_SCRIPT,
      "--set",
      "console_eventlog_verbosity=warn",
    ],
    { stdio: "inherit" }
  )

  // ── Step 2: Wait for mitmdump port to be ready ──
  try {
    await waitForPort(MITM_PORT)
    console.log("✓ mitmdump listening on port " + MITM_PORT)
  } catch (e) {
    console.error("✗ mitmdump failed to start: " + e.message)
    mitmProc.kill()
    process.exit(1)
  }

  // ── Step 3: NOW patch runtime config (mitmdump is confirmed ready) ──
  const upstreamTarget = applyCaptureRuntimePatch()
  console.log("Injected capture patch into clash-verge.yaml.")
  console.log("Mitmdump upstream target: " + upstreamTarget)

  console.log("Reloading Clash runtime config...")
  await reloadClash()
  await flushClashCaches()
  await new Promise((r) => setTimeout(r, 1000))

  console.log("")
  console.log(
    "  Flow: Antigravity IDE -> TUN -> Clash -> mitmdump(:" +
      MITM_PORT +
      ") -> Clash(VMess) -> Cloud Code"
  )
  console.log("  Logs:  " + path.join(SCRIPT_DIR, "antigravity_traffic.log"))
  console.log("  Dumps: " + LOG_DIR)
  console.log("")

  // ── Step 4: Relaunch the IDE so its Node TLS layer trusts the capture CA ──
  // Capture now runs as the normal user, so we can start the GUI directly.
  // Skip when AGENT_VIBES_CAPTURE_NO_LAUNCH is set (capture-only sessions).
  if (!process.env.AGENT_VIBES_CAPTURE_NO_LAUNCH) {
    await launchAntigravity()
  } else {
    console.log(
      "Skipping IDE launch (AGENT_VIBES_CAPTURE_NO_LAUNCH set). Start it with `npm run google:capture:launch`."
    )
  }
  console.log("")
  console.log("  Press Ctrl+C to stop capture and restore Clash config.")
  console.log("")

  // ── Step 5: Auto-restore on exit (Ctrl+C, crash, kill) ──
  let cleaned = false
  async function cleanup(code) {
    if (cleaned) return
    cleaned = true
    console.log("\nStopping capture...")
    try {
      mitmProc.kill()
    } catch {}
    await restoreClash()
    process.exit(code ?? 0)
  }

  process.on("SIGINT", () => cleanup(0))
  process.on("SIGTERM", () => cleanup(0))
  mitmProc.on("exit", (code) => {
    if (!cleaned) {
      console.log("\nmitmdump exited (code " + code + "), restoring Clash...")
      cleanup(code ?? 1)
    }
  })
}

async function cmdStop() {
  // Kill mitmdump (cross-platform)
  if (platform.PLATFORM === "win32") {
    const processes = getManagedWindowsMitmdumpProcesses()
    for (const proc of processes) {
      runShell(`taskkill /F /PID ${proc.ProcessId} >nul 2>&1`, true)
    }
  } else {
    runShell('pkill -f "mitmdump.*capture-traffic" 2>/dev/null', true)
  }

  // Remove runtime patch
  if (removeCaptureRuntimePatch()) {
    console.log("Removed capture injection from clash-verge.yaml.")
  } else {
    console.log("clash-verge.yaml already clean, nothing to restore.")
  }

  // Auto-reload Clash runtime config via API
  console.log("")
  console.log("Reloading Clash runtime config...")
  await reloadClash()
  await flushClashCaches()
}

async function cmdRepair() {
  const state = await inspectCaptureState()
  if (
    !state.runtimePatched &&
    !state.managedMitmdumpRunning &&
    !state.mitmPortListening
  ) {
    console.log("Capture state already clean.")
    return
  }

  console.log("Repairing capture state...")
  await cmdStop()

  if (state.portOccupiedWithoutManagedMitmdump) {
    console.log("")
    console.log(
      "Note: port " +
        MITM_PORT +
        " is still occupied by another local process. Clash has been restored,"
    )
    console.log(
      "but you should free that port before the next capture session."
    )
  }
}

async function cmdStatus() {
  const state = await inspectCaptureState()
  const active = state.runtimePatched
  console.log("Clash runtime config: " + (active ? "CAPTURE MODE" : "normal"))
  console.log("  File: " + CLASH_RUNTIME_CONFIG)

  // Check runtime rules via Clash API
  const rulesData = await fetchClashRules()
  if (rulesData && rulesData.rules) {
    const captureRule = rulesData.rules.find(
      (r) => r.payload && r.payload.includes("capture-mitm")
    )
    console.log(
      "Clash runtime:    " +
        (captureRule ? "CAPTURE MODE (live)" : "normal (live)")
    )
  } else {
    console.log("Clash runtime:    (cannot reach API)")
  }

  console.log("\nHealth:")
  if (state.staleInjection) {
    console.log("  stale injection detected")
    console.log(
      "  clash-verge.yaml still routes googleapis.com to capture-mitm, but mitmdump/10444 is gone."
    )
    console.log("  Fix: npm run antigravity:capture:repair")
  } else if (state.runtimePatched && state.managedMitmdumpRunning) {
    console.log("  capture session looks healthy")
  } else if (!state.runtimePatched && !state.managedMitmdumpRunning) {
    console.log("  capture state is clean")
  } else if (state.runtimePatched && state.portOccupiedWithoutManagedMitmdump) {
    console.log(
      "  capture rules are active, but port 10444 belongs to another process"
    )
    console.log("  Fix: npm run antigravity:capture:repair")
  } else if (state.runtimePatched) {
    console.log(
      "  capture runtime patch is active, but managed mitmdump was not found"
    )
    console.log("  Fix: npm run antigravity:capture:repair")
  } else {
    console.log(
      "  managed mitmdump is running while clash-verge.yaml is normal"
    )
    console.log("  Fix: npm run antigravity:capture:repair")
  }

  console.log("\nProcesses:")
  if (platform.PLATFORM === "win32") {
    printProcessStatus("mitmdump", state.managedMitmdumpProcesses)
    printProcessStatus("clash", queryWindowsProcesses("Name like '%mihomo%'"))
  } else {
    printProcessStatus("mitmdump", state.managedMitmdumpProcesses)
    runShell(
      "echo -n '  clash:    '; pgrep -fl 'verge-mihomo|mihomo' | head -1 || echo 'not running'",
      true
    )
  }

  console.log("\nPorts:")
  if (platform.PLATFORM === "win32") {
    runShell(
      "echo   " +
        MITM_PORT +
        ' (mitm):  & (netstat -an | findstr ":' +
        MITM_PORT +
        '.*LISTENING" || echo -)',
      true
    )
  } else {
    runShell(
      "echo -n '  " +
        MITM_PORT +
        " (mitm):  '; lsof -nP -iTCP:" +
        MITM_PORT +
        " -sTCP:LISTEN 2>/dev/null | tail -1 || echo '-'",
      true
    )
  }
}

function isAntigravityRunning() {
  if (platform.PLATFORM === "win32") {
    return (
      queryWindowsProcesses("Name like '%Antigravity%'").filter(
        (p) => p.ProcessId !== process.pid
      ).length > 0
    )
  }
  const r = runCapture("pgrep", ["-f", "Antigravity IDE.app"], true)
  return r.status === 0 && (r.stdout || "").trim().length > 0
}

function quitAntigravity() {
  if (platform.PLATFORM === "darwin") {
    // Graceful quit first so the IDE flushes state, then force-kill leftovers.
    runShell(`osascript -e 'quit app "Antigravity IDE"' 2>/dev/null`, true)
  } else if (platform.PLATFORM === "win32") {
    for (const proc of queryWindowsProcesses("Name like '%Antigravity%'")) {
      if (proc.ProcessId === process.pid) continue
      runShell(`taskkill /F /PID ${proc.ProcessId} >nul 2>&1`, true)
    }
  } else {
    runShell('pkill -f "Antigravity IDE" 2>/dev/null', true)
  }
}

async function waitForAntigravityExit(timeoutMs = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isAntigravityRunning()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return !isAntigravityRunning()
}

/**
 * Launch Antigravity IDE with NODE_EXTRA_CA_CERTS pointing at the mitmproxy CA
 * so its Node TLS layer (the @connectrpc/connect-node client to
 * cloudcode-pa.googleapis.com and the google-auth-library token refresh) trusts
 * the capture proxy. Node does NOT read the macOS System Keychain, so the
 * keychain-installed CA alone does not cover the IDE login flow.
 *
 * Returns true if the IDE was launched, false otherwise (reason logged). Never
 * calls process.exit so callers like cmdStart can keep the capture running.
 */
async function launchAntigravity() {
  // A GUI app started as root creates root-owned files in the user profile and
  // cannot attach to the desktop session. Skip rather than break it.
  if (
    platform.PLATFORM !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() === 0
  ) {
    console.error(
      "Cannot launch the IDE as root. Run capture without sudo so the IDE inherits a normal-user session."
    )
    return false
  }

  const caCert = platform.mitmproxyCaCertPath()
  if (!fs.existsSync(caCert)) {
    console.error("mitmproxy CA certificate not found at: " + caCert)
    console.error(
      "Run a capture session once so mitmproxy generates its CA, then retry."
    )
    return false
  }

  const binary = platform.antigravityIdeBinaryPath()
  if (!fs.existsSync(binary)) {
    console.error("Antigravity IDE executable not found at: " + binary)
    console.error(
      "Set AGENT_VIBES_ANTIGRAVITY_IDE_BINARY_PATH to override the path."
    )
    return false
  }

  // Electron enforces a single-instance lock: a second launch only focuses the
  // existing process, which was started WITHOUT our env. Quit it first.
  if (isAntigravityRunning()) {
    console.log("Antigravity IDE is already running. Quitting it first...")
    quitAntigravity()
    const exited = await waitForAntigravityExit()
    if (!exited) {
      console.error(
        "Antigravity IDE did not exit. Quit it manually, then launch again."
      )
      return false
    }
  }

  console.log("Launching Antigravity IDE with NODE_EXTRA_CA_CERTS=" + caCert)
  const child = spawn(binary, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
  })
  child.unref()

  console.log(
    "✓ IDE launched. Its Node TLS layer now trusts the capture proxy CA."
  )
  console.log(
    "  Sign in again; the OAuth + cloudcode-pa traffic will be captured."
  )
  return true
}

/**
 * `capture launch` — relaunch the IDE only. Use when capture is already running
 * but the IDE was opened normally (Dock/Finder) without the CA env.
 */
async function cmdLaunch() {
  // Heads-up if capture is not active; launching trusts the CA either way.
  try {
    const state = await inspectCaptureState()
    if (!state.runtimePatched || !state.managedMitmdumpRunning) {
      console.log(
        "Note: capture does not appear to be active. Start it with `npm run google:capture:start` to record traffic."
      )
    }
  } catch {
    // status check is best-effort
  }

  const ok = await launchAntigravity()
  if (!ok) process.exit(1)
}

switch (process.argv[2]) {
  case "launch":
  case "open":
    cmdLaunch().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "start":
  case "run":
    cmdStart().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "stop":
  case "restore":
    cmdStop().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "status":
  case "info":
    cmdStatus().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "repair":
  case "heal":
    cmdRepair().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  default:
    console.log(
      "Usage: node capture-google.js [start|stop|status|repair|launch]"
    )
    process.exit(1)
}

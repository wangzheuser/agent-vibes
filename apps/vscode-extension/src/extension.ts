import * as vscode from "vscode"
import { registerCommands } from "./commands"
import { CMD, STATE, type ServerState } from "./constants"
import { BridgeManager } from "./services/bridge-manager"
import { CertManager } from "./services/cert-manager"
import { ConfigManager } from "./services/config-manager"
import { CursorPatchManagerService } from "./services/cursor-patch-manager"
import { CursorShellAutoRunPatchService } from "./services/cursor-shell-autorun-patch"
import { ExtensionUpdateService } from "./services/extension-update"
import { NetworkManager } from "./services/network-manager"
import { logger } from "./utils/logger"
import { getCursorInstallFingerprint } from "./utils/platform"
import { executePrivileged } from "./utils/terminal"
import { StatusIndicator } from "./views/status-indicator"

// Singleton references for cleanup
let bridge: BridgeManager | null = null
let network: NetworkManager | null = null
let statusIndicator: StatusIndicator | null = null

/**
 * Extension entry point — called on startup (onStartupFinished).
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize logger
  logger.initialize()
  logger.info("Agent Vibes extension activating...")

  // Create core services
  const config = new ConfigManager()
  bridge = new BridgeManager(config, context.extensionPath)
  network = new NetworkManager()
  network.setExtensionPath(context.extensionPath)
  network.setPort(config.port)
  const cert = new CertManager(config)
  const updater = new ExtensionUpdateService(context)
  const cursorPatchManager = new CursorPatchManagerService()
  const cursorShellAutoRunPatch = new CursorShellAutoRunPatchService()

  // Create UI
  statusIndicator = new StatusIndicator()

  // Update status bar when server state changes
  bridge.on("stateChanged", (state: ServerState) => {
    statusIndicator?.update(state)
  })

  // Register all commands
  registerCommands(context, bridge, config, cert, network, updater)

  const promptRestartAfterShellPatch = async (
    message: string
  ): Promise<void> => {
    const action = await vscode.window.showInformationMessage(
      message,
      "Quit Cursor Now",
      "Later"
    )
    if (action === "Quit Cursor Now") {
      await vscode.commands.executeCommand("workbench.action.quit")
    }
  }

  const currentCursorBuild = getCursorInstallFingerprint()
  const storedShellPatchPreference = context.globalState.get<boolean>(
    STATE.CURSOR_SHELL_AUTORUN_PATCH_PREFERRED
  )
  if (storedShellPatchPreference === undefined) {
    const shellStatus = cursorShellAutoRunPatch.getStatus()
    const inferredPreference = shellStatus.isPatched && shellStatus.hasBaseline
    await context.globalState.update(
      STATE.CURSOR_SHELL_AUTORUN_PATCH_PREFERRED,
      inferredPreference
    )
    if (inferredPreference && currentCursorBuild) {
      await context.globalState.update(
        STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD,
        currentCursorBuild
      )
    }
  }

  const ensurePreferredShellAutoRunPatch = async (): Promise<void> => {
    const preferred =
      context.globalState.get<boolean>(
        STATE.CURSOR_SHELL_AUTORUN_PATCH_PREFERRED
      ) ?? false
    if (!preferred) return

    const lastPatchedBuild = context.globalState.get<string>(
      STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD
    )
    const buildChanged =
      Boolean(currentCursorBuild) && currentCursorBuild !== lastPatchedBuild
    const shellStatus = cursorShellAutoRunPatch.getStatus()

    if (shellStatus.isPatched) {
      if (currentCursorBuild && currentCursorBuild !== lastPatchedBuild) {
        await context.globalState.update(
          STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD,
          currentCursorBuild ?? undefined
        )
      }
      return
    }

    if (!shellStatus.fileExists) {
      logger.warn(
        "Skipping preferred shell auto-run patch because the Cursor workbench file was not found"
      )
      return
    }

    if (!shellStatus.canPatch) {
      logger.warn(
        "Skipping preferred shell auto-run patch because this Cursor build does not match the known patch target"
      )
      if (buildChanged) {
        await context.globalState.update(
          STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD,
          currentCursorBuild ?? undefined
        )
        void vscode.window.showWarningMessage(
          "Cursor updated, but Agent Vibes could not re-apply Shell Auto-Run Expanded because this build no longer matches the known patch target."
        )
      }
      return
    }

    const result = cursorPatchManager.applyShellAutoRunPatch()
    if (!result.success) {
      logger.warn(
        `Failed to auto-apply preferred shell auto-run patch: ${result.errors.join("; ") || "Unknown error"}`
      )
      if (buildChanged) {
        await context.globalState.update(
          STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD,
          currentCursorBuild ?? undefined
        )
        void vscode.window.showWarningMessage(
          `Cursor updated, but Agent Vibes failed to re-apply Shell Auto-Run Expanded automatically: ${result.errors.join("; ") || "Unknown error"}`
        )
      }
      return
    }

    await context.globalState.update(
      STATE.CURSOR_SHELL_AUTORUN_PATCH_BUILD,
      currentCursorBuild ?? undefined
    )

    if (result.updated) {
      logger.info("Automatically re-applied preferred shell auto-run patch")
      await promptRestartAfterShellPatch(
        result.checksumUpdated > 0
          ? "Cursor updated and Agent Vibes automatically re-applied Shell Auto-Run Expanded. Fully restart Cursor once more to activate the patch."
          : "Cursor updated and Agent Vibes confirmed Shell Auto-Run Expanded for this build. Fully restart Cursor once more to activate the patch."
      )
    }
  }

  await ensurePreferredShellAutoRunPatch()

  let currentPort = config.port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const portChanged = event.affectsConfiguration("agentVibes.port")
      if (!portChanged) return

      const nextPort = config.port
      if (nextPort === currentPort) return

      const previousPort = currentPort
      currentPort = nextPort
      network?.setPort(nextPort)

      logger.info(`Agent Vibes port changed: ${previousPort} → ${nextPort}`)

      const bridgeRunning = bridge?.isRunning ?? false
      const forwardingActive = network?.isForwardingActive() ?? false

      try {
        if (bridgeRunning) {
          statusIndicator?.showBusy(
            "Restarting…",
            `Agent Vibes — Restarting bridge on port ${nextPort}`
          )
          await bridge?.restart()
          logger.info(`Bridge restarted on new port ${nextPort}`)
        }
      } catch (error) {
        statusIndicator?.clearBusy()
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Failed to restart bridge after port change`, error)
        void vscode.window.showErrorMessage(
          `Agent Vibes failed to restart on port ${nextPort}: ${message}`
        )
        return
      }

      if (forwardingActive && network) {
        statusIndicator?.showBusy(
          "Reconfiguring…",
          `Agent Vibes — Reconfiguring forwarding for port ${nextPort}`
        )
        executePrivileged(
          network.getReconfigureCommand(previousPort),
          "Agent Vibes — Reconfigure Forwarding"
        )
        setTimeout(() => statusIndicator?.clearBusy(), 8000)
      } else {
        statusIndicator?.clearBusy()
      }
    })
  )

  // Push disposables
  context.subscriptions.push({
    dispose: () => {
      statusIndicator?.dispose()
      bridge?.dispose()
      network?.dispose()
      logger.dispose()
    },
  })

  // ── First-run onboarding ──────────────────────────────────────────
  const needsCerts = !config.hasCertificates()
  const hasAnyAccounts =
    config.getAccountCount(config.antigravityAccountsPath) > 0 ||
    config.getAccountCount(config.claudeApiAccountsPath) > 0 ||
    config.getAccountCount(config.codexAccountsPath) > 0 ||
    config.getAccountCount(config.openaiCompatAccountsPath) > 0

  if (needsCerts || !hasAnyAccounts) {
    const missing: string[] = []
    if (needsCerts) missing.push("SSL certificates")
    if (!hasAnyAccounts) missing.push("backend accounts")

    const action = await vscode.window.showInformationMessage(
      `Agent Vibes needs setup: ${missing.join(" and ")} not configured.`,
      "Setup Now",
      "Later"
    )

    if (action === "Setup Now") {
      if (needsCerts) {
        await vscode.commands.executeCommand(CMD.GENERATE_CERT)
      }
      if (!hasAnyAccounts) {
        await vscode.commands.executeCommand(CMD.OPEN_DASHBOARD)
        vscode.window.showInformationMessage(
          "Add at least one backend account from the Agent Vibes Dashboard."
        )
      }
    }
  }

  const promptReloadAfterForwardingEnabled = async (): Promise<void> => {
    if (!network) return
    if (context.globalState.get<boolean>(STATE.FORWARDING_RELOAD_PROMPTED)) {
      return
    }

    const becameActive = await network.waitForForwardingActive()
    if (!becameActive) return

    await context.globalState.update(STATE.FORWARDING_RELOAD_PROMPTED, true)

    const action = await vscode.window.showInformationMessage(
      "Forwarding is enabled. Fully restart Cursor to apply DNS/hosts changes.",
      "Quit Cursor Now",
      "Later"
    )

    if (action === "Quit Cursor Now") {
      await vscode.commands.executeCommand("workbench.action.quit")
    }
  }

  // Auto-start if configured
  if (config.autoStart) {
    logger.info("Auto-start enabled, starting server...")
    bridge
      .start()
      .then(async () => {
        if (bridge!.state === "running") {
          logger.info("Bridge auto-started successfully")
          // Check if forwarding is already active (from previous session)
          if (network!.isForwardingActive()) {
            logger.info("Forwarding already active from previous session")
          } else {
            // Prompt user to enable forwarding via sudo terminal
            const action = await vscode.window.showInformationMessage(
              "Bridge is running! Enable network forwarding? (requires sudo)",
              "Enable",
              "Later"
            )
            if (action === "Enable") {
              executePrivileged(
                network!.getEnableCommand(),
                "Agent Vibes — Enable Forwarding"
              )
              void promptReloadAfterForwardingEnabled()
            }
          }
        }
      })
      .catch((err) => {
        logger.warn(
          `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  void updater.checkForUpdatesOnStartup()

  logger.info("Agent Vibes extension activated")
}

/**
 * Extension deactivation — clean up all resources.
 */
export function deactivate(): void {
  bridge?.dispose()
  network?.dispose()
  statusIndicator?.dispose()
  logger.info("Agent Vibes extension deactivated")
  logger.dispose()
}

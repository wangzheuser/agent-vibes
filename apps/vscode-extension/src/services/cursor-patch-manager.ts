import { getCursorProductJsonPath } from "../utils/platform"
import { CursorChecksumsService } from "./cursor-checksums"
import {
  CursorPatchBaselineService,
  type CursorPatchResetResult,
} from "./cursor-patch-baseline"
import { CursorShellAutoRunPatchService } from "./cursor-shell-autorun-patch"

export interface CursorPatchResetState {
  canReset: boolean
  hint: string
  managedFileCount: number
  hasUnmanagedAppliedPatches: boolean
}

export interface CursorShellAutoRunTransactionResult {
  success: boolean
  updated: boolean
  checksumUpdated: number
  rolledBack: boolean
  errors: string[]
}

export class CursorPatchManagerService {
  private readonly baseline = new CursorPatchBaselineService()
  private readonly checksums = new CursorChecksumsService()
  private readonly shellAutoRunPatch = new CursorShellAutoRunPatchService()

  getResetState(): CursorPatchResetState {
    const baselineStatus = this.baseline.getStatus()
    const checksumsStatus = this.checksums.getStatus()
    const shellStatus = this.shellAutoRunPatch.getStatus()
    const checksumPatched =
      checksumsStatus.differsFromBaseline === true ||
      (shellStatus.isPatched && checksumsStatus.allMatched)
    const hasUnmanagedAppliedPatches =
      (shellStatus.isPatched && !shellStatus.hasBaseline) ||
      (checksumPatched && !checksumsStatus.hasBaseline)
    const managedFileCount = baselineStatus.trackedFiles.length
    const canReset =
      baselineStatus.manifestExists &&
      managedFileCount > 0 &&
      !hasUnmanagedAppliedPatches

    const hint = !baselineStatus.manifestExists
      ? "No original baseline has been captured yet. Apply a patch through Agent Vibes first."
      : hasUnmanagedAppliedPatches
        ? "Some active patches were applied before Agent Vibes captured the original baseline, so one-click reset is currently unsafe."
        : `Restore ${managedFileCount} managed Cursor file(s) to the captured original baseline, then re-apply the patches you still want.`

    return {
      canReset,
      hint,
      managedFileCount,
      hasUnmanagedAppliedPatches,
    }
  }

  applyShellAutoRunPatch(): CursorShellAutoRunTransactionResult {
    const filePaths = this.getManagedFilePaths()
    if ("errors" in filePaths) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: filePaths.errors,
      }
    }

    const shellStatus = this.shellAutoRunPatch.getStatus()
    if (shellStatus.isPatched && !shellStatus.hasBaseline) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: [
          "Shell auto-run patch is already present without an Agent Vibes baseline. Refusing to capture the patched file as the original baseline.",
        ],
      }
    }

    try {
      this.baseline.ensureOriginals([
        filePaths.workbenchPath,
        filePaths.productPath,
      ])
    } catch (error) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }

    const shellResult = this.shellAutoRunPatch.apply()
    if (!shellResult.success) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: shellResult.errors,
      }
    }

    const checksumResult = this.checksums.apply()
    if (!checksumResult.success) {
      if (!shellResult.updated) {
        return {
          success: false,
          updated: false,
          checksumUpdated: 0,
          rolledBack: false,
          errors: checksumResult.errors,
        }
      }

      const rollbackResult = this.baseline.restoreFiles([
        filePaths.workbenchPath,
      ])
      const rollbackChecksumResult = rollbackResult.success
        ? this.checksums.apply()
        : null
      const rollbackErrors = rollbackResult.success
        ? rollbackChecksumResult?.success
          ? []
          : [
              `Rollback checksum sync failed: ${
                rollbackChecksumResult?.errors.join("; ") ||
                "unknown checksum restore error"
              }`,
            ]
        : [
            `Rollback failed: ${
              rollbackResult.errors.join("; ") || "unknown restore error"
            }`,
          ]
      return {
        success: false,
        updated: true,
        checksumUpdated:
          rollbackResult.success && rollbackChecksumResult?.success
            ? rollbackChecksumResult.updated
            : 0,
        rolledBack: Boolean(
          rollbackResult.success && rollbackChecksumResult?.success
        ),
        errors: [...checksumResult.errors, ...rollbackErrors],
      }
    }

    return {
      success: true,
      updated: shellResult.updated,
      checksumUpdated: checksumResult.updated,
      rolledBack: false,
      errors: [],
    }
  }

  restoreShellAutoRunPatch(): CursorShellAutoRunTransactionResult {
    const filePaths = this.getManagedFilePaths()
    if ("errors" in filePaths) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: filePaths.errors,
      }
    }

    const shellStatus = this.shellAutoRunPatch.getStatus()
    if (!shellStatus.fileExists || !shellStatus.filePath) {
      return {
        success: false,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: ["Cursor workbench file not found"],
      }
    }

    if (!shellStatus.isPatched) {
      return {
        success: true,
        updated: false,
        checksumUpdated: 0,
        rolledBack: false,
        errors: [],
      }
    }

    const restoreResult = this.baseline.restoreFiles([
      filePaths.workbenchPath,
      filePaths.productPath,
    ])
    return {
      success: restoreResult.success,
      updated: restoreResult.restored > 0,
      checksumUpdated: restoreResult.success ? 1 : 0,
      rolledBack: false,
      errors: restoreResult.errors,
    }
  }

  resetAllPatches(): CursorPatchResetResult {
    const resetState = this.getResetState()
    if (!resetState.canReset) {
      return {
        success: false,
        restored: 0,
        errors: [resetState.hint],
      }
    }

    return this.baseline.resetAll()
  }

  private getManagedFilePaths():
    | { workbenchPath: string; productPath: string }
    | { errors: string[] } {
    const shellStatus = this.shellAutoRunPatch.getStatus()
    const workbenchPath =
      shellStatus.fileExists && shellStatus.filePath
        ? shellStatus.filePath
        : null
    const productPath = getCursorProductJsonPath()
    const errors: string[] = []

    if (!workbenchPath) {
      errors.push("Cursor workbench file not found")
    }
    if (!productPath) {
      errors.push("Cursor product.json not found")
    }

    if (errors.length > 0 || !workbenchPath || !productPath) {
      return { errors }
    }

    return {
      workbenchPath,
      productPath,
    }
  }
}

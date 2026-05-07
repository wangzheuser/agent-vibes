import * as fs from "fs"
import { CursorPatchBaselineService } from "./cursor-patch-baseline"
import { getCursorWorkbenchPath } from "../utils/platform"

const PATCH_TARGETS = [
  {
    original: "O=s===void 0?!1:s,U=h===void 0?200:h,",
    patched: "O=s===void 0?!0:s,U=h===void 0?200:h,",
  },
  {
    original:
      "defaultExpanded:s,callId:o,startedAtMs:a,approval:l,description:u,commandSummary:d,collapsedHeight:h,showBackgroundNudge:f,backgroundNudgeDelayMs:g,onSendToBackground:y,approvalKeybindingRunLabel:w,approvalKeybindingAllowlistLabel:C,shellBubbleId:x,running:A,onStopRunning:R,canOpenExternalTerminal:P,onOpenExternalTerminal:M,enableAllowlistToggleMenu:B}=n,O=r===void 0?!1:r,q=s===void 0?!1:s,W=h===void 0?200:h,",
    patched:
      "defaultExpanded:s,callId:o,startedAtMs:a,approval:l,description:u,commandSummary:d,collapsedHeight:h,showBackgroundNudge:f,backgroundNudgeDelayMs:g,onSendToBackground:y,approvalKeybindingRunLabel:w,approvalKeybindingAllowlistLabel:C,shellBubbleId:x,running:A,onStopRunning:R,canOpenExternalTerminal:P,onOpenExternalTerminal:M,enableAllowlistToggleMenu:B}=n,O=r===void 0?!1:r,q=s===void 0?!0:s,W=h===void 0?200:h,",
  },
] as const

export interface CursorShellAutoRunPatchStatus {
  filePath: string | null
  fileExists: boolean
  hasBaseline: boolean
  isPatched: boolean
  canPatch: boolean
}

export interface CursorShellAutoRunPatchResult {
  success: boolean
  updated: boolean
  errors: string[]
}

export class CursorShellAutoRunPatchService {
  private readonly baseline = new CursorPatchBaselineService()

  getStatus(): CursorShellAutoRunPatchStatus {
    const filePath = getCursorWorkbenchPath()
    const status: CursorShellAutoRunPatchStatus = {
      filePath,
      fileExists: Boolean(filePath && fs.existsSync(filePath)),
      hasBaseline: Boolean(filePath && this.baseline.hasOriginal(filePath)),
      isPatched: false,
      canPatch: false,
    }

    if (!filePath || !status.fileExists) {
      return status
    }

    const content = fs.readFileSync(filePath, "utf-8")
    status.isPatched = PATCH_TARGETS.some(({ patched }) =>
      content.includes(patched)
    )
    status.canPatch =
      PATCH_TARGETS.some(({ original }) => content.includes(original)) ||
      status.isPatched

    return status
  }

  apply(): CursorShellAutoRunPatchResult {
    try {
      const status = this.getStatus()
      if (!status.filePath || !status.fileExists) {
        return {
          success: false,
          updated: false,
          errors: ["Cursor workbench file not found"],
        }
      }

      const content = fs.readFileSync(status.filePath, "utf-8")
      if (PATCH_TARGETS.some(({ patched }) => content.includes(patched))) {
        return {
          success: true,
          updated: false,
          errors: [],
        }
      }

      const target = PATCH_TARGETS.find(({ original }) =>
        content.includes(original)
      )
      if (!target) {
        return {
          success: false,
          updated: false,
          errors: ["Shell auto-run patch target not found in workbench file"],
        }
      }

      this.baseline.ensureOriginals([status.filePath])

      fs.writeFileSync(
        status.filePath,
        content.replace(target.original, target.patched),
        "utf-8"
      )

      return {
        success: true,
        updated: true,
        errors: [],
      }
    } catch (error) {
      return {
        success: false,
        updated: false,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  restore(): CursorShellAutoRunPatchResult {
    try {
      const status = this.getStatus()
      if (!status.filePath || !status.fileExists) {
        return {
          success: false,
          updated: false,
          errors: ["Cursor workbench file not found"],
        }
      }

      if (!status.isPatched) {
        return {
          success: true,
          updated: false,
          errors: [],
        }
      }

      const result = this.baseline.restoreFiles([status.filePath])
      return {
        success: result.success,
        updated: result.restored > 0,
        errors: result.errors,
      }
    } catch (error) {
      return {
        success: false,
        updated: false,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }
}

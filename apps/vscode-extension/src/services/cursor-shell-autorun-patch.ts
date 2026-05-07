import * as fs from "fs"
import { CursorPatchBaselineService } from "./cursor-patch-baseline"
import { getCursorWorkbenchPath } from "../utils/platform"

const ORIGINAL_SNIPPET = "O=s===void 0?!1:s,U=h===void 0?200:h,"
const PATCHED_SNIPPET = "O=s===void 0?!0:s,U=h===void 0?200:h,"

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
    status.isPatched = content.includes(PATCHED_SNIPPET)
    status.canPatch = content.includes(ORIGINAL_SNIPPET) || status.isPatched

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
      if (content.includes(PATCHED_SNIPPET)) {
        return {
          success: true,
          updated: false,
          errors: [],
        }
      }

      if (!content.includes(ORIGINAL_SNIPPET)) {
        return {
          success: false,
          updated: false,
          errors: ["Shell auto-run patch target not found in workbench file"],
        }
      }

      this.baseline.ensureOriginals([status.filePath])

      fs.writeFileSync(
        status.filePath,
        content.replace(ORIGINAL_SNIPPET, PATCHED_SNIPPET),
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

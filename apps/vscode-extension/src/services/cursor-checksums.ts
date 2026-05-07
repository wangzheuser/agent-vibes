import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { CursorPatchBaselineService } from "./cursor-patch-baseline"
import {
  getCursorAppRootPath,
  getCursorProductJsonPath,
} from "../utils/platform"

type ProductJson = {
  checksums?: Record<string, string>
  [key: string]: unknown
}

export interface CursorChecksumsEntryStatus {
  relativePath: string
  filePath: string
  fileExists: boolean
  expected: string | null
  actual: string | null
  matches: boolean
}

export interface CursorChecksumsStatus {
  appRootPath: string | null
  productPath: string | null
  productExists: boolean
  hasBaseline: boolean
  differsFromBaseline: boolean | null
  hasChecksums: boolean
  entries: CursorChecksumsEntryStatus[]
  mismatchCount: number
  allMatched: boolean
}

export interface CursorChecksumsApplyResult {
  success: boolean
  updated: number
  errors: string[]
}

export class CursorChecksumsService {
  private readonly baseline = new CursorPatchBaselineService()

  getStatus(): CursorChecksumsStatus {
    const appRootPath = getCursorAppRootPath()
    const productPath = getCursorProductJsonPath()
    const status: CursorChecksumsStatus = {
      appRootPath,
      productPath,
      productExists: Boolean(productPath && fs.existsSync(productPath)),
      hasBaseline: Boolean(
        productPath && this.baseline.hasOriginal(productPath)
      ),
      differsFromBaseline: null,
      hasChecksums: false,
      entries: [],
      mismatchCount: 0,
      allMatched: false,
    }

    if (!appRootPath || !productPath) {
      return status
    }

    const product = this.readProductJson(productPath)
    if (!product?.checksums) {
      return status
    }

    status.hasChecksums = true
    status.entries = Object.entries(product.checksums).map(
      ([relativePath, expected]) => {
        const filePath = path.join(appRootPath, "out", relativePath)
        const fileExists = fs.existsSync(filePath)
        const actual = fileExists ? this.computeChecksum(filePath) : null
        return {
          relativePath,
          filePath,
          fileExists,
          expected,
          actual,
          matches: fileExists && actual === expected,
        }
      }
    )
    status.mismatchCount = status.entries.filter(
      (entry) => !entry.matches
    ).length
    status.allMatched = status.entries.length > 0 && status.mismatchCount === 0
    if (status.hasBaseline) {
      const currentRaw = fs.readFileSync(productPath, "utf-8")
      const baselineRaw = this.readBaselineRaw(productPath)
      status.differsFromBaseline =
        baselineRaw === null ? null : currentRaw !== baselineRaw
    }

    return status
  }

  apply(): CursorChecksumsApplyResult {
    try {
      const appRootPath = getCursorAppRootPath()
      const productPath = getCursorProductJsonPath()
      const errors: string[] = []

      if (!appRootPath || !productPath) {
        return {
          success: false,
          updated: 0,
          errors: ["Cursor installation not found"],
        }
      }

      const product = this.readProductJson(productPath)
      if (!product?.checksums) {
        return {
          success: false,
          updated: 0,
          errors: ["product.json does not contain a checksums map"],
        }
      }

      this.baseline.ensureOriginals([productPath])

      const nextChecksums = { ...product.checksums }
      const relativePaths = Object.keys(nextChecksums)
      for (const relativePath of relativePaths) {
        const filePath = path.join(appRootPath, "out", relativePath)
        if (!fs.existsSync(filePath)) {
          errors.push(`Core file not found: ${relativePath}`)
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          updated: 0,
          errors,
        }
      }

      let updated = 0
      for (const relativePath of relativePaths) {
        const filePath = path.join(appRootPath, "out", relativePath)
        const nextChecksum = this.computeChecksum(filePath)
        if (nextChecksums[relativePath] !== nextChecksum) {
          nextChecksums[relativePath] = nextChecksum
          updated += 1
        }
      }

      fs.writeFileSync(
        productPath,
        JSON.stringify({ ...product, checksums: nextChecksums }, null, 2) +
          "\n",
        "utf-8"
      )

      return {
        success: true,
        updated,
        errors: [],
      }
    } catch (error) {
      return {
        success: false,
        updated: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  restore(): CursorChecksumsApplyResult {
    try {
      const productPath = getCursorProductJsonPath()
      if (!productPath || !fs.existsSync(productPath)) {
        return {
          success: false,
          updated: 0,
          errors: ["Cursor product.json not found"],
        }
      }

      const result = this.baseline.restoreFiles([productPath])
      return {
        success: result.success,
        updated: result.restored,
        errors: result.errors,
      }
    } catch (error) {
      return {
        success: false,
        updated: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  private readProductJson(productPath: string): ProductJson | null {
    try {
      return JSON.parse(fs.readFileSync(productPath, "utf-8")) as ProductJson
    } catch {
      return null
    }
  }

  private computeChecksum(filePath: string): string {
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("base64")
    return digest.replace(/=+$/u, "")
  }

  private readBaselineRaw(productPath: string): string | null {
    const appRootPath = getCursorAppRootPath()
    if (!appRootPath) return null

    const relativePath = path.relative(appRootPath, productPath)
    const status = this.baseline.getStatus()
    if (!status.backupRootPath) return null

    const baselinePath = path.join(status.backupRootPath, "files", relativePath)
    try {
      return fs.readFileSync(baselinePath, "utf-8")
    } catch {
      return null
    }
  }
}

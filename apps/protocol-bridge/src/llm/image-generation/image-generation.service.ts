import { Injectable, Logger } from "@nestjs/common"
import * as fs from "fs/promises"
import * as path from "path"
import { GoogleService } from "../google/google.service"
import { CodexService } from "../openai/codex.service"

export type ImageGenerationProvider = "codex" | "gemini"

export interface ImageGenerationReference {
  path: string
  mimeType: string
  data: string
}

export interface ImageGenerationInput {
  prompt: string
  model?: string
  conversationId?: string
  outputFormat?: string
  referenceImagePaths?: string[]
  projectRoot?: string
}

export interface ImageGenerationResult {
  imageData: string
  revisedPrompt?: string
  status?: string
  provider: ImageGenerationProvider
  mimeType?: string
}

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name)

  constructor(
    private readonly codexService: CodexService,
    private readonly googleService: GoogleService
  ) {}

  async generateImage(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }

    const errors: string[] = []
    for (const provider of this.resolveProviderOrder(input.model)) {
      try {
        return provider === "gemini"
          ? await this.generateWithGemini({ ...input, prompt })
          : await this.generateWithCodex({ ...input, prompt })
      } catch (error) {
        const normalized = this.toError(error)
        errors.push(`${provider}: ${normalized.message}`)
        this.logger.warn(
          `${provider} image generation failed${
            provider === "codex" ? "; trying next provider" : ""
          }: ${normalized.message}`
        )
      }
    }

    throw new Error(`Image generation failed: ${errors.join("; ")}`)
  }

  private resolveProviderOrder(model?: string): ImageGenerationProvider[] {
    const normalized = model?.trim().toLowerCase() || ""
    if (normalized.includes("gemini")) {
      return ["gemini", "codex"]
    }
    return ["codex", "gemini"]
  }

  private async generateWithCodex(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const result = await this.codexService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      outputFormat: input.outputFormat,
    })
    return {
      ...result,
      provider: "codex",
      mimeType: this.inferOutputMimeType(input.outputFormat),
    }
  }

  private async generateWithGemini(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const references = await this.loadReferenceImages(
      input.referenceImagePaths || [],
      input.projectRoot
    )
    const result = await this.googleService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      outputFormat: input.outputFormat,
      referenceImages: references,
    })
    return {
      ...result,
      provider: "gemini",
    }
  }

  private async loadReferenceImages(
    referenceImagePaths: string[],
    projectRoot?: string
  ): Promise<ImageGenerationReference[]> {
    const normalized = referenceImagePaths
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 3)

    const references: ImageGenerationReference[] = []
    for (const referencePath of normalized) {
      const absolutePath = path.isAbsolute(referencePath)
        ? referencePath
        : path.resolve(projectRoot || process.cwd(), referencePath)
      const data = await fs.readFile(absolutePath)
      references.push({
        path: absolutePath,
        mimeType: this.inferMimeType(absolutePath),
        data: data.toString("base64"),
      })
    }
    return references
  }

  private inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg"
      case ".webp":
        return "image/webp"
      case ".gif":
        return "image/gif"
      case ".png":
      default:
        return "image/png"
    }
  }

  private inferOutputMimeType(outputFormat?: string): string {
    const format = outputFormat?.trim().toLowerCase()
    if (format === "jpg" || format === "jpeg") return "image/jpeg"
    if (format === "webp") return "image/webp"
    return "image/png"
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}

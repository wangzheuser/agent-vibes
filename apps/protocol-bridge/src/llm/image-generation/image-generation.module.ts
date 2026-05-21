import { Module } from "@nestjs/common"
import { GoogleModule } from "../google/google.module"
import { CodexModule } from "../openai/codex.module"
import { ImageGenerationService } from "./image-generation.service"

@Module({
  imports: [CodexModule, GoogleModule],
  providers: [ImageGenerationService],
  exports: [ImageGenerationService],
})
export class ImageGenerationModule {}

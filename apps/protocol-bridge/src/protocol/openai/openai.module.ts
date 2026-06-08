import { Module } from "@nestjs/common"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { ChatCompletionsController } from "./chat-completions.controller"
import { ChatCompletionsService } from "./chat-completions.service"

/**
 * OpenAiModule — inbound OpenAI-compatible protocol surface.
 *
 * Reuses AnthropicModule's MessagesService (the canonical backend router)
 * so model routing, account pooling, error taxonomy, and usage accounting
 * are shared across the Anthropic and OpenAI surfaces. Only the wire
 * translation lives here.
 */
@Module({
  imports: [AnthropicModule],
  controllers: [ChatCompletionsController],
  providers: [ChatCompletionsService],
})
export class OpenaiModule {}

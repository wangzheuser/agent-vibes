import { Module } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { AnthropicApiModule } from "../../llm/anthropic/anthropic-api.module"
import { GoogleModule } from "../../llm/google/google.module"
import { KiroModule } from "../../llm/aws/kiro.module"
import { CodexModule } from "../../llm/openai/codex.module"
import { OpenaiCompatModule } from "../../llm/openai/openai-compat.module"
import { ModelModule } from "../../llm/shared/model.module"
import { MessagesController } from "./messages.controller"
import { MessagesService } from "./messages.service"
import { TokenizerService } from "./tokenizer.service"

@Module({
  imports: [
    AnthropicApiModule,
    CodexModule,
    GoogleModule,
    KiroModule,
    ContextModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, TokenizerService],
  exports: [
    AnthropicApiModule,
    CodexModule,
    GoogleModule,
    KiroModule,
    MessagesService,
    OpenaiCompatModule,
  ],
})
export class AnthropicModule {}

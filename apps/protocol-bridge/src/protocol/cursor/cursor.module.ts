import { Module } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { GoogleModule } from "../../llm/google/google.module"
import { KiroModule } from "../../llm/aws/kiro.module"
import { CodexModule } from "../../llm/openai/codex.module"
import { OpenaiCompatModule } from "../../llm/openai/openai-compat.module"
import { ModelModule } from "../../llm/shared/model.module"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { AntigravityIdeSyncService } from "./antigravity-ide-sync.service"
import { AiserverMockController } from "./controllers/aiserver-mock.controller"
import { AuthController } from "./controllers/auth.controller"
import { CursorAdapterController } from "./controllers/cursor-adapter.controller"
import { CursorAuthService } from "./cursor-auth.service"
import { CursorConnectStreamService } from "./cursor-connect-stream.service"
import { CursorGrpcService } from "./cursor-grpc.service"
import { KnowledgeBaseService } from "./knowledge-base.service"
import { KvStorageService } from "./kv-storage.service"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"
import { ChatSessionManager } from "./session/chat-session.service"
import { CursorSkillsManager } from "./skills"
import { ClientSideToolV2ExecutorService } from "./tools/client-side-tool-v2-executor.service"

@Module({
  imports: [
    AnthropicModule,
    CodexModule,
    GoogleModule,
    KiroModule,
    ContextModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [
    CursorAdapterController,
    AuthController,
    AiserverMockController,
  ],
  providers: [
    ChatSessionManager,
    ClientSideToolV2ExecutorService,
    AntigravityIdeSyncService,
    CursorAuthService,
    CursorConnectStreamService,
    CursorGrpcService,
    CursorSkillsManager,
    KvStorageService,
    SemanticSearchProviderService,
    KnowledgeBaseService,
  ],
  exports: [CursorAuthService, CursorConnectStreamService, ChatSessionManager],
})
export class CursorModule {}

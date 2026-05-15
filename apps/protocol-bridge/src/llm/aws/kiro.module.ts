import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { KiroService } from "./kiro.service"

@Module({
  imports: [UsageStatsModule],
  providers: [KiroService],
  exports: [KiroService],
})
export class KiroModule {}

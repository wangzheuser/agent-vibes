import { Body, Controller, Get, Logger, Post } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash, randomUUID } from "crypto"
import { KiroService } from "../../../llm/aws/kiro.service"
import { AntigravityIdeSyncService } from "../antigravity-ide-sync.service"
import { CursorAuthService } from "../cursor-auth.service"

interface CursorGainRequest {
  token?: string
  [key: string]: unknown
}

interface CursorIdentity {
  id: string
  email: string
  membershipType: string
  subscriptionStatus: string
}

@Controller("api")
export class AuthController {
  private readonly logger = new Logger(AuthController.name)
  private readonly tokenSalt = randomUUID()

  constructor(
    private readonly configService: ConfigService,
    private readonly cursorAuthService: CursorAuthService,
    private readonly antigravityIdeSyncService: AntigravityIdeSyncService,
    private readonly kiroService: KiroService
  ) {}

  private getCursorIdentity(): CursorIdentity {
    const configuredId =
      this.configService.get<string>("CURSOR_AUTH_USER_ID") || ""
    const configuredEmail =
      this.configService.get<string>("CURSOR_AUTH_EMAIL") || ""
    const configuredMembership =
      this.configService.get<string>("CURSOR_AUTH_MEMBERSHIP") || ""

    const localAuth = this.cursorAuthService.getAuthTokens()
    const localUserId =
      localAuth.accessToken &&
      this.cursorAuthService.getUserIdFromToken(localAuth.accessToken)

    return {
      id: configuredId || localUserId || "protocol-bridge",
      email: configuredEmail || localAuth.email || "protocol-bridge@local",
      membershipType:
        configuredMembership || localAuth.membershipType || "ultra",
      subscriptionStatus: localAuth.subscriptionStatus || "active",
    }
  }

  private issueProxyToken(scope: "gain" | "gain-new", inputToken?: string) {
    const seed = `${scope}:${inputToken || ""}:${this.tokenSalt}`
    const digest = createHash("sha256").update(seed).digest("hex")
    return `proxy_${scope}_${digest.slice(0, 40)}`
  }

  @Get("users/whoami")
  whoami() {
    const identity = this.getCursorIdentity()
    return {
      id: identity.id,
      email: identity.email,
      plan: identity.membershipType,
      emailVerified: true,
      membershipType: identity.membershipType,
      subscription: {
        status: identity.subscriptionStatus,
        plan: identity.membershipType,
      },
      usage: {
        requests: 0,
        maxRequests: 999999,
      },
    }
  }

  @Post("cursor/gain")
  gain(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(`Cursor gain request received (hasToken=${hasInputToken})`)
    return {
      token: this.issueProxyToken(
        "gain",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      globalRateLimit: 999999,
      issuedAt: new Date().toISOString(),
    }
  }

  @Post("cursor/gain-new")
  gainNew(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(
      `Cursor gain-new request received (hasToken=${hasInputToken})`
    )
    return {
      token: this.issueProxyToken(
        "gain-new",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      issuedAt: new Date().toISOString(),
    }
  }

  // Cursor clients also check this endpoint in startup flow.
  @Get("auth/me")
  me() {
    return this.whoami()
  }

  @Post("antigravity/sync-ide")
  syncAntigravityIdeCredentials() {
    return {
      synced: true,
      ...this.antigravityIdeSyncService.syncCredentialsFromIde(),
    }
  }

  // ── Kiro: one-click sync from local AWS SSO / Kiro IDE caches ──────────

  @Post("kiro/sync-local")
  async syncKiroFromLocalCaches() {
    try {
      const result = await this.kiroService.syncFromLocalCaches()
      this.logger.log(
        `Kiro local sync: imported=${result.imported}, skipped=${result.skipped}, total=${result.accountCount}`
      )
      return result
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Kiro local sync failed"
      this.logger.error(`Kiro local sync error: ${message}`)
      return {
        synced: false,
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        sources: [],
        error: message,
      }
    }
  }

  // ── Kiro: AWS Builder ID OAuth device flow ─────────────────────────────

  @Post("kiro/login/start")
  async startKiroBuilderIdLogin(
    @Body() body: { region?: string; proxyUrl?: string } = {}
  ) {
    const session = await this.kiroService.startBuilderIdLogin({
      region: body.region,
      proxyUrl: body.proxyUrl,
    })
    return session
  }

  @Post("kiro/login/poll")
  async pollKiroBuilderIdLogin(
    @Body() body: { sessionId?: string; proxyUrl?: string } = {}
  ) {
    const sessionId = (body.sessionId || "").trim()
    if (!sessionId) {
      return { status: "expired" as const, message: "missing sessionId" }
    }
    return this.kiroService.pollBuilderIdLogin(sessionId, {
      proxyUrl: body.proxyUrl,
    })
  }

  @Post("kiro/login/cancel")
  cancelKiroBuilderIdLogin(@Body() body: { sessionId?: string } = {}) {
    const sessionId = (body.sessionId || "").trim()
    return {
      cancelled: sessionId
        ? this.kiroService.cancelBuilderIdLogin(sessionId)
        : false,
    }
  }

  // ── Kiro: manual JSON paste fallback ───────────────────────────────────

  @Post("kiro/import")
  importKiroFromJson(@Body() body: { raw?: string } = {}) {
    const raw = (body.raw || "").trim()
    if (!raw) {
      return {
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        error: "empty payload",
      }
    }
    try {
      return this.kiroService.importFromRawJson(raw)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Kiro import failed"
      return {
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        error: message,
      }
    }
  }
}

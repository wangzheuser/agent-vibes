import {
  appendLanguageDirectiveToAnthropicSystem,
  appendLanguageDirectiveToText,
  buildLanguageDirective,
  buildTerseLanguageAnchor,
} from "./language-directive"

const CHINESE_MESSAGES = [
  { role: "user", content: "帮我修复这个登录页面的报错，谢谢。" },
]

describe("language-directive Claude Code skip", () => {
  const originalForced = process.env.AGENT_VIBES_FORCED_LANGUAGE

  afterEach(() => {
    if (originalForced === undefined) {
      delete process.env.AGENT_VIBES_FORCED_LANGUAGE
    } else {
      process.env.AGENT_VIBES_FORCED_LANGUAGE = originalForced
    }
  })

  describe("buildLanguageDirective", () => {
    it("injects a named directive for Chinese input by default", () => {
      const directive = buildLanguageDirective(CHINESE_MESSAGES)
      expect(directive).toContain("Chinese")
      expect(directive.length).toBeGreaterThan(0)
    })

    it("returns empty string when skip is true (Claude Code frontend)", () => {
      expect(buildLanguageDirective(CHINESE_MESSAGES, { skip: true })).toBe("")
    })

    it("skips even when a forced language is configured", () => {
      process.env.AGENT_VIBES_FORCED_LANGUAGE = "中文"
      expect(buildLanguageDirective(CHINESE_MESSAGES, { skip: true })).toBe("")
    })
  })

  describe("buildTerseLanguageAnchor", () => {
    it("emits a reminder for Chinese input by default", () => {
      expect(buildTerseLanguageAnchor(CHINESE_MESSAGES)).toContain("Reminder")
    })

    it("returns empty string when skip is true", () => {
      expect(buildTerseLanguageAnchor(CHINESE_MESSAGES, { skip: true })).toBe(
        ""
      )
    })
  })

  describe("appendLanguageDirectiveToText", () => {
    it("appends the directive by default", () => {
      const out = appendLanguageDirectiveToText("BASE", CHINESE_MESSAGES)
      expect(out.startsWith("BASE")).toBe(true)
      expect(out).toContain("Chinese")
    })

    it("returns the base untouched when skip is true", () => {
      expect(
        appendLanguageDirectiveToText("BASE", CHINESE_MESSAGES, { skip: true })
      ).toBe("BASE")
    })

    it("returns empty string for empty base when skip is true", () => {
      expect(
        appendLanguageDirectiveToText("", CHINESE_MESSAGES, { skip: true })
      ).toBe("")
    })
  })

  describe("appendLanguageDirectiveToAnthropicSystem", () => {
    it("appends a directive block to an array system by default", () => {
      const result = appendLanguageDirectiveToAnthropicSystem(
        [{ type: "text", text: "SYS" }],
        CHINESE_MESSAGES
      )
      expect(Array.isArray(result)).toBe(true)
      expect((result as Array<Record<string, unknown>>).length).toBe(2)
    })

    it("leaves an array system unchanged when skip is true", () => {
      const system = [{ type: "text", text: "SYS" }]
      const result = appendLanguageDirectiveToAnthropicSystem(
        system,
        CHINESE_MESSAGES,
        { skip: true }
      )
      expect(result).toEqual(system)
    })

    it("returns the string system unchanged when skip is true", () => {
      expect(
        appendLanguageDirectiveToAnthropicSystem("SYS", CHINESE_MESSAGES, {
          skip: true,
        })
      ).toBe("SYS")
    })
  })
})

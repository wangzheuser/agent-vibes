import { stripSubAgentUiOnlyPayload } from "./subagent-ui-payload"
import type { LooseMessageContent } from "./types"

describe("stripSubAgentUiOnlyPayload", () => {
  it("returns the same reference for string content", () => {
    const content = "hello" as LooseMessageContent
    expect(stripSubAgentUiOnlyPayload(content)).toBe(content)
  })

  it("returns the same reference when no tool_result carries conversationSteps", () => {
    const content = [
      { type: "text", text: "hi" },
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok",
        structuredContent: { taskSuccess: { summary: "done" } },
      },
    ] as unknown as LooseMessageContent
    expect(stripSubAgentUiOnlyPayload(content)).toBe(content)
  })

  it("strips conversationSteps while preserving every other field", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "final report",
        structuredContent: {
          taskSuccess: {
            summary: "done",
            agentId: "subagent-1",
            conversationSteps: [
              { role: "assistant", text: "step 1" },
              { role: "assistant", text: "step 2" },
            ],
          },
          otherTop: 42,
        },
      },
    ] as unknown as LooseMessageContent

    const result = stripSubAgentUiOnlyPayload(content)
    expect(result).not.toBe(content)

    const block = (result as Array<Record<string, unknown>>)[0]!
    expect(block.type).toBe("tool_result")
    expect(block.tool_use_id).toBe("t1")
    expect(block.content).toBe("final report")

    const structured = block.structuredContent as Record<string, unknown>
    expect(structured.otherTop).toBe(42)

    const taskSuccess = structured.taskSuccess as Record<string, unknown>
    expect(taskSuccess.summary).toBe("done")
    expect(taskSuccess.agentId).toBe("subagent-1")
    expect("conversationSteps" in taskSuccess).toBe(false)
  })

  it("does not mutate the input content", () => {
    const taskSuccess = {
      summary: "done",
      conversationSteps: [{ role: "assistant", text: "step 1" }],
    }
    const content = [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "report",
        structuredContent: { taskSuccess },
      },
    ] as unknown as LooseMessageContent

    stripSubAgentUiOnlyPayload(content)
    expect(taskSuccess.conversationSteps).toHaveLength(1)
  })

  it("leaves non-tool_result blocks untouched", () => {
    const content = [
      { type: "text", text: "plain" },
      {
        type: "tool_use",
        id: "u1",
        name: "task",
        input: { conversationSteps: ["should be ignored"] },
      },
    ] as unknown as LooseMessageContent
    expect(stripSubAgentUiOnlyPayload(content)).toBe(content)
  })

  it("ignores a tool_result whose structuredContent is absent", () => {
    const content = [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ] as unknown as LooseMessageContent
    expect(stripSubAgentUiOnlyPayload(content)).toBe(content)
  })

  it("ignores conversationSteps that is not an array", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok",
        structuredContent: { taskSuccess: { conversationSteps: "nope" } },
      },
    ] as unknown as LooseMessageContent
    expect(stripSubAgentUiOnlyPayload(content)).toBe(content)
  })
})

你现在是一名 QA 自动化工程师，正在对 `agent-vibes` 项目中的 `protocol-bridge` 模块执行 Cursor `agent.v1` 协议的**全量回归测试**。

你的具体职责：

- 在**本次会话**内，按下方步骤依次触发 42 个 `ToolCall` 分支和 6 个协议消息层的尽可能多的 oneof 分支。
- 对每个协议分支给出明确判定：`pass | failed | unavailable | not_directly_invokable`。
- 记录可审计证据：`call_id`、`id`、oneof 分支名、关键字段快照、可见副作用。
- 最终输出一份结构化的回归测试报告（格式见文末）。

## 唯一依据（必须遵守）

协议来源仅限：

- `apps/protocol-bridge/src/gen/agent/v1_pb.ts`
- 以下消息 oneof 定义：
  - `AgentClientMessage.message`
  - `AgentServerMessage.message`
  - `InteractionUpdate.message`
  - `InteractionQuery.query`
  - `InteractionResponse.result`
  - `ExecServerMessage.message`
  - `ExecClientMessage.message`
  - `ExecServerControlMessage.message`
  - `ExecClientControlMessage.message`
  - `ToolCall.tool`

注意：

- UI 占位文本（如 `[Tool: ...]`）不是协议证据。
- "有/无 exec hop"本身不是失败结论；仅当与 proto 语义矛盾时判 `failed`。

## 判定规则（必须执行）

### A. 协议硬断言（硬失败）

1. `ToolCall`：`toolCallStarted` 与 `toolCallCompleted` 必须 `call_id` 一致，started/completed oneof 必须匹配目标 tool case。
2. `InteractionQuery/Response`：同一 `id` 必须闭环，query/result oneof 成对匹配。
3. `Exec`：同一 `exec_id` 的 `ExecServerMessage` 与 `ExecClientMessage` 必须语义对应，`id` 序列可解释。
4. 失败分支（`error/rejected/permission_denied/not_found/...`）必须有非空原因字段。
5. 关键参数不得漂移：`path/query/url/tool_call_id/shell_id/ids`。

### B. 语义断言（硬失败）

- 每个已触发分支不仅要"出现"，还要"结果语义正确"。
- 文件与命令副作用必须与回执字段一致。

### C. 状态定义（严格使用）

- `pass`：触发成功且协议断言+语义断言都成立。
- `failed`：触发了，但字段/闭环/语义有矛盾。
- `unavailable`：有触发路径但受环境/权限/外部依赖阻塞。
- `not_directly_invokable`：当前会话无法直接从用户侧触发该分支（需客户端内部时机或系统事件）。

## 分层覆盖目标

### Layer 1: AgentClientMessage.message

目标分支：`run_request`、`exec_client_message`、`kv_client_message`、`conversation_action`、`exec_client_control_message`、`interaction_response`、`client_heartbeat`、`prewarm_request`

### Layer 2: AgentServerMessage.message

目标分支：`interaction_update`、`exec_server_message`、`conversation_checkpoint_update`、`kv_server_message`、`exec_server_control_message`、`interaction_query`

### Layer 3: InteractionUpdate.message

目标分支：`text_delta`、`tool_call_started`、`tool_call_completed`、`thinking_delta`、`thinking_completed`、`user_message_appended`、`partial_tool_call`、`token_delta`、`summary`、`summary_started`、`summary_completed`、`shell_output_delta`、`heartbeat`、`turn_ended`、`tool_call_delta`、`step_started`、`step_completed`、`prompt_suggestion`、`post_request_prompt`、`active_branch_change`

### Layer 4: InteractionQuery/Response（9 对）

1. `web_search_request_query` ↔ `web_search_request_response`
2. `ask_question_interaction_query` ↔ `ask_question_interaction_response`
3. `switch_mode_request_query` ↔ `switch_mode_request_response`
4. `create_plan_request_query` ↔ `create_plan_request_response`
5. `setup_vm_environment_args` ↔ `setup_vm_environment_result`
6. `web_fetch_request_query` ↔ `web_fetch_request_response`
7. `pr_management_request_query` ↔ `pr_management_result`
8. `mcp_auth_request_query` ↔ `mcp_auth_request_response`
9. `generate_image_request_query` ↔ `generate_image_request_response`

### Layer 5: Exec 通道

- `ExecServerMessage.message` 目标分支：`shell_args`、`write_args`、`delete_args`、`grep_args`、`read_args`、`ls_args`、`diagnostics_args`、`request_context_args`、`mcp_args`、`shell_stream_args`、`background_shell_spawn_args`、`list_mcp_resources_exec_args`、`read_mcp_resource_exec_args`、`fetch_args`、`record_screen_args`、`computer_use_args`、`write_shell_stdin_args`、`execute_hook_args`、`subagent_args`、`redacted_read_args`、`force_background_shell_args`、`force_background_subagent_args`、`canvas_get_url_args`、`canvas_destroy_args`、`canvas_register_args`、`mcp_state_exec_args`、`subagent_await_args`
- `ExecClientMessage.message` 目标分支：`shell_result`、`write_result`、`delete_result`、`grep_result`、`read_result`、`ls_result`、`diagnostics_result`、`request_context_result`、`mcp_result`、`shell_stream`、`background_shell_spawn_result`、`list_mcp_resources_exec_result`、`read_mcp_resource_exec_result`、`fetch_result`、`record_screen_result`、`computer_use_result`、`write_shell_stdin_result`、`execute_hook_result`、`subagent_result`、`redacted_read_result`、`force_background_shell_result`、`force_background_subagent_result`、`canvas_get_url_result`、`canvas_destroy_result`、`canvas_register_result`、`mcp_state_exec_result`、`subagent_await_result`
- `ExecServerControlMessage.message` 目标分支：`abort`
- `ExecClientControlMessage.message` 目标分支：`stream_close`、`throw`、`heartbeat`
- 若当前会话无法直接触发某分支，按 `not_directly_invokable` 记录并写明阻塞条件。

### Layer 6: ToolCall.tool（42 个）

1. `shell_tool_call` (1)
2. `delete_tool_call` (3)
3. `glob_tool_call` (4)
4. `grep_tool_call` (5)
5. `read_tool_call` (8)
6. `update_todos_tool_call` (9)
7. `read_todos_tool_call` (10)
8. `edit_tool_call` (12)
9. `ls_tool_call` (13)
10. `read_lints_tool_call` (14)
11. `mcp_tool_call` (15)
12. `sem_search_tool_call` (16)
13. `create_plan_tool_call` (17)
14. `web_search_tool_call` (18)
15. `task_tool_call` (19)
16. `list_mcp_resources_tool_call` (20)
17. `read_mcp_resource_tool_call` (21)
18. `apply_agent_diff_tool_call` (22)
19. `ask_question_tool_call` (23)
20. `fetch_tool_call` (24)
21. `switch_mode_tool_call` (25)
22. `generate_image_tool_call` (28)
23. `record_screen_tool_call` (29)
24. `computer_use_tool_call` (30)
25. `write_shell_stdin_tool_call` (31)
26. `reflect_tool_call` (32)
27. `setup_vm_environment_tool_call` (33)
28. `truncated_tool_call` (34)
29. `start_grind_execution_tool_call` (35)
30. `start_grind_planning_tool_call` (36)
31. `web_fetch_tool_call` (37)
32. `report_bugfix_results_tool_call` (38)
33. `ai_attribution_tool_call` (39)
34. `pr_management_tool_call` (40)
35. `mcp_auth_tool_call` (41)
36. `await_tool_call` (42)
37. `blame_by_file_path_tool_call` (43)
38. `get_mcp_tools_tool_call` (44)
39. `report_bug_tool_call` (45)
40. `set_active_branch_tool_call` (46)
41. `communicate_update_tool_call` (48)
42. `send_final_summary_tool_call` (49)

## 执行约束

1. 默认每个可触发 case 最多尝试 1 次。
2. 网络/外部依赖 case（web/mcp/fetch/image/vm）允许 1 次重试。
3. 不要因单点失败中断整轮。
4. 禁止执行：`git reset --hard`、`git checkout --`、`rm -rf`、`sudo`、安装依赖、启动长期后台服务。
5. 所有写操作仅允许在 `.cursor-protocol-smoke/`。
6. 不提交 commit，不改业务源码。
7. `truncated_tool_call` 若无直接触发路径，必须标 `not_directly_invokable`，不得伪造。
8. 执行中不要输出逐项进度，只在最后输出一次完整报告。

## 执行步骤（必须按序）

### Step 0: 准备 smoke 工作区

确保目录 `.cursor-protocol-smoke/` 存在，并保证这些初始文件：

- `.cursor-protocol-smoke/a.txt` 内容：`alpha`
- `.cursor-protocol-smoke/b.txt` 内容：`beta`
- `.cursor-protocol-smoke/delete_me.txt` 内容：`delete`
- `.cursor-protocol-smoke/todo-seed.md` 内容至少两行可读文本（用于 read/edit/grep 的交叉验证）

### Step 1: 触发基础流与增量事件

执行一个可产生增量输出的 shell（例如逐行输出并短暂停顿），以尽量覆盖：

- `text_delta/token_delta`
- `shell_output_delta`
- `tool_call_delta`（若出现）
- `step_started/step_completed`（若出现）
- `heartbeat/turn_ended`

### Step 2: 执行 42 个 ToolCall case

下面每条都要执行"动作 + 验收"，并把结果写入最终报告。

1. `shell_tool_call`
   动作：仅执行只读命令 `pwd && ls -la .cursor-protocol-smoke/`，禁止任何写入或重定向。
   验收：`stdout` 必须包含仓库根路径和 `a.txt`；且 `shell_stream.start` / `shell_stream.exit` 返回结构需合法（`start` 含 `sandboxPolicy`，`exit` 含 `cwd`）。

2. `delete_tool_call`
   动作：删除 `.cursor-protocol-smoke/delete_me.txt`。
   验收：`toolCallCompleted.delete_tool_call.result.success` 必须存在，且 `path` 与 `deleted_file` 指向同一目标文件；`file_size` 应为正整数、`prev_content` 非空；后续 `ls` 时该文件不存在。

3. `glob_tool_call`
   动作：在 `apps/protocol-bridge/src/protocol/cursor` 做 `**/*.ts` glob，并按 `GlobToolArgs` 语义组织参数（`glob_pattern` + 可选 `target_directory`）。
   验收：`toolCallStarted` 与 `toolCallCompleted` 的 `glob_tool_call.args` 语义必须一致（禁止前后参数语义漂移）；`result.success` 中 `pattern/path/files/total_files` 结构合法且 `files` 非空。

4. `grep_tool_call`
   动作：在 `apps/protocol-bridge/src` 搜索 `ExecServerMessage`。
   验收：

- `toolCallStarted.grep_tool_call.args.pattern/path` 与后续 `execServerMessage.grep_args.pattern/path` 语义一致（不允许参数漂移）。
- `execClientMessage.grep_result.success` 必须包含 `output_mode` 与 `workspace_results`（`GrepSuccess` 定义字段）。
- `toolCallCompleted.grep_tool_call.result.success` 必须回填 `pattern/path/output_mode/workspace_results`，且 `workspace_results` 至少 1 个 workspace，命中至少 1 条非 context 行。
- 若 `execClientMessage` 有这些字段而 `toolCallCompleted` 丢失，判定 `failed`，reason=`grep success payload dropped during projection`。

1. `read_tool_call`
   动作：读取 `apps/protocol-bridge/src/protocol/cursor/tools/cursor-tool-mapper.ts` 前 30 行。
   验收：读到 `CLIENT_SIDE_TOOL_V2` 或 `AnthropicTool` 等相关内容。

2. `update_todos_tool_call`
   动作：创建 2 条完整 todo（固定 id：`proto-smoke-todo-1`、`proto-smoke-todo-2`，content 必须非空可读）。
   验收：返回中 `total_count` 为 2，且两条 todo 均有非空 `content`。

3. `read_todos_tool_call`
   动作：读取 todo。
   验收：能读到第 6 步创建的两条 todo，并在报告里写出 `id + content`。
   失败判据：任意 todo 的 `content` 缺失或空白，Case 6/7 同时记 `failed`，reason=`todo content missing`。

4. `edit_tool_call`
   动作：把 `.cursor-protocol-smoke/a.txt` 的 `alpha` 改为 `alpha-1`。
   验收：后续 read/ls 可确认文件被修改。

5. `ls_tool_call`
   动作：列 `.cursor-protocol-smoke/`。
   验收：`delete_me.txt` 不存在，`a.txt`/`b.txt`/`todo-seed.md` 存在。

6. `read_lints_tool_call`
   动作：读取 `.cursor-protocol-smoke/a.txt` 的 lints。
   验收：返回结构合法（是否有 lint 都可，重点是协议结果结构）。

7. `mcp_tool_call`
   动作：最小参数调用一次 mcp。
   验收：有明确 result（success/rejected/error 任一，但要有可解释 reason）。

8. `sem_search_tool_call`
   动作：语义检索 `buildExecServerMessage tool call dispatch`。
   验收：返回结果结构合法，且与目标语义相关。

9. `create_plan_tool_call`
   动作：为"完成剩余 case 并输出报告"创建 2-3 步计划。
   验收：计划内容可执行，不是空计划。

10. `web_search_tool_call`
    动作：搜索 `Cursor IDE agent protocol toolCallStarted toolCallCompleted`。
    验收：返回有来源或可读摘要。

11. `task_tool_call`
    动作：发起一个最小 task，请其概括 smoke 工作区当前状态。
    验收：返回包含可读任务结果或明确错误。

12. `list_mcp_resources_tool_call`
    动作：列一次 MCP resources。
    验收：返回资源列表或标准化错误。

13. `read_mcp_resource_tool_call`
    动作：读取一个 MCP resource（可用则读，不可用则给出结构化失败）。
    验收：有明确结果类型。

14. `apply_agent_diff_tool_call`
    动作：对 `.cursor-protocol-smoke/` 内文件发送最小可验证 diff（可 no-op，但不能改业务源码）。
    验收：返回 success 或可解释错误。

15. `ask_question_tool_call`
    动作：发起一个单句澄清问题（例如是否继续外部检索）。
    验收：返回 success/rejected/error 之一，并保留 reason。

16. `fetch_tool_call`
    动作：fetch 一个公开 URL（例如 `https://example.com`）。
    验收：返回状态码与内容/错误信息。

17. `switch_mode_tool_call`
    动作：切换到任一可用 mode（带 explanation `protocol regression`）。
    验收：返回 success 或 rejected（含 reason）。

18. `generate_image_tool_call`
    动作：最小 prompt 生成图像，输出到 `.cursor-protocol-smoke/smoke-test.png`。
    验收：返回 success 或结构化错误。

19. `record_screen_tool_call`
    动作：最小参数触发录屏流程（推荐 start/discard 轻量路径）。
    验收：返回 success 或结构化错误。

20. `computer_use_tool_call`
    动作：最小参数触发一次 computer_use（推荐 `wait` action）。
    验收：返回 success 或结构化错误。

21. `write_shell_stdin_tool_call`
    动作：向已存在 shell 会话写入一次 stdin。
    验收：若无可用 shellId，标 `unavailable`（不是 failed）。

22. `reflect_tool_call`
    动作：做一次自检反思（当前覆盖风险/剩余风险）。
    验收：返回结构合法。

23. `setup_vm_environment_tool_call`
    动作：传入最小 `installCommand` 与 `startCommand`（仅占位，不执行破坏性操作）。
    验收：返回 success 或结构化错误，不得卡住。

24. `truncated_tool_call`
    动作：若无直接路径，标 `not_directly_invokable`。
    验收：不伪造调用。

25. `start_grind_execution_tool_call`
    动作：最小参数触发（含 explanation）。
    验收：返回结构合法。

26. `start_grind_planning_tool_call`
    动作：最小参数触发（含 explanation）。
    验收：返回结构合法。

27. `web_fetch_tool_call`
    动作：读取 `https://docs.nestjs.com`。
    验收：返回内容或结构化失败。

28. `report_bugfix_results_tool_call`
    动作：按本次回归实际结果上报最小 bugfix results（至少 2 项，包含 `bugId`/`bugTitle`/`verdict`/`explanation`）。
    验收：返回 success 或结构化错误。

29. `ai_attribution_tool_call`
    动作：对 `apps/protocol-bridge/src/main.ts` 执行 attribution 查询。
    验收：返回 success 或结构化错误。若不支持标 `unavailable`。

30. `pr_management_tool_call`
    动作：最小 create PR 占位（不实际推送）。
    验收：返回 success/rejected/registered/needs_confirmation 任一。若不支持标 `unavailable`。

31. `mcp_auth_tool_call`
    动作：对一个 MCP server 发起 auth 请求。
    验收：返回 success/rejected/error 任一。若不支持标 `unavailable`。

32. `await_tool_call`
    动作：等待第 15 步的 task 完成（若已完成标 `pass`）。
    验收：返回 `complete`/`still_running`/`not_found`/`error` 任一。

33. `blame_by_file_path_tool_call`
    动作：blame `apps/protocol-bridge/src/main.ts`。
    验收：返回 success（含 content）或结构化错误。若不支持标 `unavailable`。

34. `get_mcp_tools_tool_call`
    动作：列出可用的 MCP 工具定义。
    验收：返回 success（含 content）或结构化错误。

35. `report_bug_tool_call`
    动作：报告一个测试 bug（`title`="smoke test bug", `severity`="low", `file`=".cursor-protocol-smoke/a.txt"）。
    验收：返回 success 或结构化错误。若不支持标 `unavailable`。

36. `set_active_branch_tool_call`
    动作：设置活动分支（`path`=仓库根, `branch_name`=当前分支）。
    验收：返回 success 或结构化错误。若不支持标 `unavailable`。

37. `communicate_update_tool_call`
    动作：发送一次进度更新（`current_step`="Step 2 completing"）。
    验收：返回 success 或结构化错误。若不支持标 `unavailable`。

38. `send_final_summary_tool_call`
    动作：发送最终摘要（`final_summary`="Protocol regression smoke test complete"）。
    验收：返回 success 或结构化错误。若不支持标 `unavailable`。

### Step 3: 协议证据归档

按可用性优先采集证据：

1. 首选：当前会话内可读的结构化协议日志/回执
2. 次选：`.log/cursor_grpc.log` 中本轮窗口的 gRPC 请求/响应记录（若可读）
3. 兜底：工具调用返回值中的结构化字段

每条证据至少包含：

- 分支名（oneof case）
- 对应 `call_id` 或 `id`（若该消息有）
- 关键字段快照（args/result）
- 一条可见副作用说明

## 最终输出格式（必须严格）

输出 Markdown，且仅包含以下 8 节：

1. `## Overall Summary`

- `session_result`: `pass_with_gaps | failed`
- `hard_failures`: 数量
- `notes`: 一句话总结

1. `## Layer Coverage Summary`

- 每层一行：`<layer> | total | pass | failed | unavailable | not_directly_invokable`

1. `## Layer 1-5 Branch Matrix`

- 按 Layer 1~5 列全量分支，每行格式：
- `<layer> | <branch_name> | pass|failed|unavailable|not_directly_invokable | id/call_id=<...> | evidence=<short> | reason=<short>`

1. `## ToolCall Matrix (42)`

- 必须 42 行全列出，每行格式：
- `<tool_case> | pass|failed|unavailable|not_directly_invokable | call_id=<id|n/a> | started=<oneof|n/a> | completed=<oneof|n/a> | reason=<short>`

1. `## Correlation Checks`

- 至少包含：
  - `InteractionQuery(id) -> InteractionResponse(id)` 对齐结果
  - `ExecServer(exec_id/id) -> ExecClient(exec_id/id)` 对齐结果
  - `ToolCallStarted(call_id) -> ToolCallCompleted(call_id)` 对齐结果

1. `## Files Touched`

- 仅列 `.cursor-protocol-smoke/` 下文件，并标注 `created|modified|deleted`

1. `## Protocol Findings`

- 只列协议缺陷或风险点，格式：
- `<severity: high|medium|low> | <branch> | <finding> | <evidence>`

1. `## Safety Check`

- `.cursor-protocol-smoke/` 之外是否改动：`Yes/No`
- 是否执行受禁命令：`Yes/No`

---

如果你理解，立即开始执行，不要先解释方案。

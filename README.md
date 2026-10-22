# Codex Foreman

让 Codex 负责规划与验收，把任务交给 pi、opencode 等本机 CLI。基于 [DaydayupV/claude-foreman](https://github.com/DaydayupV/claude-foreman) 的 MIT 执行器移植，保留执行、续接、讨论、审查、状态、实时日志及取消能力。

## 安装

需要 Node.js 18+、Git，以及已经安装并登录的 pi 或 opencode。

```powershell
git clone https://github.com/luzhouchao/codex-foreman.git
cd codex-foreman
node .\tools\install.mjs
```

同时安装 Codex 原生钩子：`node .\tools\install.mjs --hooks`。安装器合并到 Codex home 下的 `hooks.json`，保留已有定义并备份原文件。之后在 Codex 的 `/hooks` 中审阅、信任新增定义。安装成功不代表已信任或当前会话已加载。

- `SessionStart`：启动、恢复、压缩后提醒使用调度技能。
- `PreToolUse`：识别直接调用 pi/opencode/Codex 模型的 shell 命令，要求通过调度器；放行版本查询、模型列表和登录管理。

Windows 钩子显式使用 PowerShell 和 Node 绝对路径，兼容路径空格。钩子不递归解析任意包装脚本，也不拦截终端手工输入；它是工作流约束，不是安全沙箱。事件和信任流程见 [Codex 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)。

安装器复制技能到 `$CODEX_HOME/skills/codex-foreman`，默认 `~/.codex/skills/codex-foreman`；已有目录时默认拒绝覆盖，显式更新使用 `--update`。重新打开 Codex 会话后使用 `$codex-foreman`，例如“用 pi 实现这个功能，完成后你检查 diff 并运行测试”。

也可不安装，直接调用：

```powershell
node .\skills\codex-foreman\scripts\cli.mjs config --cwd E:\your-project
node .\skills\codex-foreman\scripts\cli.mjs models
```

首次配置默认由当前 Codex 自行处理，不自动选择外部模型。将 `examples/config.pi.json` 中的模型替换为 `models` 返回的真实 `provider/model`，再合并到配置输出标明的用户配置文件。使用 `--agent pi-worker` 可明确指定 pi。opencode 类型写作 `opencode cli`，模型同样使用工具实际返回的标识。

```powershell
node .\skills\codex-foreman\scripts\cli.mjs run --cwd E:\your-project --brief E:\task.md --title 实现功能 --level normal --agent pi-worker --workspace "E:\your-workspace"
node .\skills\codex-foreman\scripts\cli.mjs status --workspace "E:\your-workspace"
```

配置与运行记录独立于 Claude，位于 Codex home 下的 `foreman`。环境变量使用 `CODEX_FOREMAN_CONFIG`、`CODEX_FOREMAN_RUNS_DIR`。主控标识为 `codex host`，可与名为 codex 的外部协作方区分。

要把运行记录保存在主对话工作区，将 `dispatch.runs_dir` 设为 `.codex/foreman/runs`，并在所有 CLI 命令上加 `--workspace "主工作区绝对路径"`（或设置 `CODEX_FOREMAN_WORKSPACE`）。执行任务的 `--cwd` 可以是其他目录。未指定 workspace 时采用 CLI 启动目录。记录包括任务说明、事件、报告、diff 和查看器状态；建议将运行目录加入项目本地 Git 排除规则，避免提交日志。

## 权限与兼容边界

- pi/opencode 的 edit 模式只开放文件工具，主控负责运行测试；shell 模式没有系统沙箱。
- 讨论与审查使用只读工具；pi 通过随包守卫限制路径，不能把它当作操作系统隔离。
- 本版从 Codex skill 调用执行器，并提供可选的 Codex 原生 hooks。
- 保留 Codex CLI 与兼容 API 适配器，但首版验证重点是 pi/opencode。真实模型认证、额度和 CLI 版本需在目标环境验证。
- `check` 可能发送小型模型请求；测试套件使用模拟 CLI，不需要真实凭据。

## 测试

日常验收以本机 `npm test` 为准；GitHub Actions 测试仅手动触发。

```powershell
npm test
```

上游快照：`eabe4cd5b8e981a6abcd80cf88e4d73c3a0386f8`。保留上游 LICENSE；本项目是独立移植，并非上游或 OpenAI 官方发行。

## pi web 接入

如果已经安装 `@agegr/pi-web`，可将 `agents.pi-worker.bin` 指向其安装目录下的 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，复用 `~/.pi/agent` 的模型与认证配置，无需复制 API key。模型标识应使用该 pi 实际返回的清单。本版已使用 pi 1.2.0 验证。

调度器启动独立 pi 会话，不向浏览器当前聊天注入消息。pi web 更新后若路径改变，修改 `agents.pi-worker.bin`。通过 `check --agent pi-worker` 验证版本、模型清单与实际连通性。

## 自动实时终端

将用户配置的 `dispatch.watch` 设为 `"auto"`，Windows 上每次执行、讨论、审查或续接会自动打开独立终端窗口（优先 PowerShell 7，未安装时回退 Windows PowerShell），显示模型、进度、工具活动和结果。同一 Codex 会话、同一个 `--group` 的并发参与方合用一个窗口。默认关闭，按需在用户配置中开启。

按 q 或关闭查看窗口不会取消任务，需停止任务时使用 `cancel --run <id> --workspace "<主对话工作区绝对路径>"`。自动打开的讨论窗口（含讨论续接）会等待同会话同组已登记任务全部正常完成，并经过 5 秒登记稳定期后自动关闭；任一参与方失败、超时、取消或需要输入时保留窗口显示原因，由用户关闭。执行和审查窗口仍保留结果。手动 watch 不会关闭用户终端。已打开的旧版窗口不受更新影响。恢复手动展示只需设为 `"off"`。窗口启动失败不影响任务；错误写入日志，可用 watch 手动查看。

此功能由执行器直接触发，不依赖钩子是否已信任。目前自动窗口支持 Windows；Codex 内置终端的自动执行入口尚未接入，其他系统使用手动 watch。

## 内置 Sol 执行与主控记录

当用户选择内置执行时，主控直接使用 Codex 提供的内置子智能体工具创建 `gpt-6.1-sol` 任务，并记录工具实际返回的 agent id。`levels.run = "codex host"` 只把执行交回主控，CLI 不会自动创建内置子智能体。内置任务由主控使用宿主工具等待、验收或取消；本 CLI 不能驱动、取消或实时监测内置 agent。

主控把下列 JSON 保存为 `E:\task.json`，一条命令即可保存或更新同一 `task_id`：

```json
{
  "task_id": "implement-parser",
  "agent_id": "替换为宿主工具返回的真实 agent id",
  "model": "gpt-6.1-sol",
  "scope": ["src/parser.mjs"],
  "artifacts": [],
  "tests": [],
  "acceptance": ["主控检查 diff 并验证解析边界"],
  "status": "assigned",
  "status_source": "主控依据宿主派发工具返回结果明确报告"
}
```

```powershell
node "<cli>" native-record --workspace "E:\your-workspace" --input "E:\task.json"
```

`<cli>` 为 `skills/codex-foreman/scripts/cli.mjs` 的绝对路径。记录写入主工作区 `.codex/foreman/native-tasks/<task_id>.json`，独立于外部 CLI 的 runs。更新时重新提交完整 JSON；完成后填写实际产物、测试结果、验收标准及状态依据。`status` 允许 assigned、running、completed、failed、cancelled、blocked；所有状态均由主控明确报告，时间戳只是记录时间。不会把本地记录当作实时状态，也不推算内置任务 token 或费用。输入校验、临时文件原子替换和目录链接检查用于防止损坏或路径穿越；不提供并发合并，同任务同时更新以最后一次成功替换为准。

## 记录保留范围

新建 pi 原生会话随对应 run 保存到主工作区；旧全局 pi 会话保留，续接兼容旧记录，不自动搬迁或删除认证配置。删除主工作区 `.codex/foreman` 只清理该目录中的 Foreman 日志和任务记录，不包含 Codex 原生主会话、子会话，也不代表卸载技能或钩子。清理命令只按用户明确选择操作，不会自动定期删除。

讨论可采用主控独立意见加外部中立评议；材料集中给出、按任务选择参与人数、有实质分歧才开第二轮。例如可配置 DeepSeek max、GLM max、MiMo high 参与讨论，并由主控调用内置 gpt-6.1-sol 执行；发行默认仍由主控处理，安装不代表后续外部调用授权。

## 显式更新与回退

在源码仓库内运行以下命令；每个操作沿用当前 CODEX_HOME：

```powershell
node .\tools\install.mjs --version
node .\tools\install.mjs --update
node .\tools\install.mjs --update --hooks
node .\tools\install.mjs --hooks-only
node .\tools\install.mjs --rollback <备份ID>
node .\skills\codex-foreman\scripts\cli.mjs version --workspace "E:\your-workspace"
```

更新先暂存并备份技能，保留用户配置及日志；失败尝试自动恢复，恢复失败会报告备份位置。返回的 backup 是显式回退所需 ID。无版本标记的既有安装显示 legacy；CLI version 从安装版本标记读取版本，源码调用回退到 package.json。更新自身钩子时保留其他钩子；安装器不写信任记录，仍需用户在 /hooks 审阅。回退时若 hooks.json 在更新后又有改动，会拒绝覆盖，需手动合并。技能目录中的托管程序文件会被替换，修改前应保存自己的程序补丁。

## 讨论范围与用量

讨论默认最多 2 轮。pi 的文件数量由主控每次根据任务指定，默认不设数量上限；工具调用默认最多 24 次，可按本次任务调整。主控使用 `--max-files N` 指定文件数、`--max-tool-calls N` 指定工具预算，使用 `--scope <路径>` 或 `--file <文件>` 指定与议题有关的范围，可以重复传入。未指定范围时只分析提供的任务材料；越界或超限暂停为 `needs_input`，由主控决定调整范围或预算后是否继续，不自动放宽。pi 自行预载的上下文及历史会话不属于文件工具计数范围，这些限制不等于完整 token 上限。

用量由实际返回值统计：未返回的 token、缓存和费用显示“暂无数据”，明确返回的 0 显示为 0。上游自身把缺失数据补成 0 时，Foreman 无法进一步区分。失败或取消不会清零已经收到的用量。

## 安全清理运行记录

清理仅操作主工作区 `.codex/foreman/runs` 内的运行记录，默认预览。按讨论组或 UTC 日期选择（严格早于该日零点），追加 `--apply` 才删除：

```powershell
node .\skills\codex-foreman\scripts\cli.mjs cleanup --workspace "E:\your-workspace" --group "discussion-name"
node .\skills\codex-foreman\scripts\cli.mjs cleanup --workspace "E:\your-workspace" --before 2026-10-01
node .\skills\codex-foreman\scripts\cli.mjs cleanup --workspace "E:\your-workspace" --group "discussion-name" --apply
```

存在活跃任务、查看器或无法确认安全的记录时拒绝清理。删除后相应日志和 pi 会话不可再查询或续接；命令不清理 `native-tasks`、讨论汇总、更新验收材料、用户配置或 Codex 原生对话。

---
name: codex-foreman
description: 由 Codex 主控调度 pi、opencode 等 CLI 完成编码、独立审查和方案讨论，记录结果并由 Codex 验收。用户要求外部模型协作、派活或使用 foreman 时使用。
---

# Codex Foreman

Codex 负责拆解、决策和验收，外部协作方通过本技能的 `scripts/cli.mjs` 执行。下文 `<cli>` 指该文件的绝对路径，不能使用 Claude 插件变量。

## 运行记录位置

将用户配置 `dispatch.runs_dir` 设为 `.codex/foreman/runs`，记录就保存在主对话工作区内。每次调用 CLI（包括 status、watch、resume、cancel）都追加 `--workspace "<主对话工作区绝对路径>"`，不要用子任务的执行目录替代；也可统一设置 CODEX_FOREMAN_WORKSPACE。未显式指定时以启动 CLI 的工作目录为准，`--cwd` 只决定协作方执行位置。

运行目录保存任务说明、事件、报告、diff 和查看器记录。若该目录位于被审查的 Git 项目中，把对应路径加入该项目的 `.git/info/exclude`，避免日志混入代码审查或提交；保留用户现有排除项。快照追踪器本身也会排除运行记录目录。

首次使用运行 `node "<cli>" config --cwd "<项目>"`，读取配置、可用协作方和偏好。用户配置位于 `${CODEX_HOME}/foreman/config.json`（未设置时为 `~/.codex/foreman/config.json`），项目配置为 `.codex/foreman.json`。项目配置只能收紧权限。默认各等级是 `"codex host"`，由当前 Codex 自己完成；不要自动选模型或启用外部调用。

## 配置和派活

根据用户要用的工具运行 `models`，使用实际列出的模型标识，配置 `agents` 与 `levels`。pi 和 opencode 的执行需配置 `run_access: "edit"` 或 `"shell"`；edit 允许编辑但不运行命令，shell 无系统沙箱，只在用户授权的范围内启用。模型、费用及权限不能由项目文件自行提升。`check` 会对部分适配器发出实际模型请求，可能消耗额度。

三类工作各自定级：`simple` 为做法确定，`normal` 为需要局部判断，`complex` 为复杂方案或高风险改动。很小的工作由 Codex 直接完成。用户点名派活时用 `--agent`；否则遵循配置等级。`dispatch.auto` 只表达用户的调度偏好，不能覆盖当前会话权限及更高优先级指令；默认关闭，用户明确要求的外部调用可直接执行。

将目标、允许修改的路径、约束、验收标准写到任务说明文件，再执行：

```text
node "<cli>" run --cwd "<项目>" --brief "<任务.md>" --title "<标题>" --level normal --agent <代号> --workspace "<主对话工作区绝对路径>"
node "<cli>" discuss --cwd "<项目>" --brief "<议题.md>" --title "<标题>" --level normal --agent <代号> --workspace "<主对话工作区绝对路径>"
node "<cli>" review --cwd "<项目>" --uncommitted --brief "<审查要求.md>" --level normal --agent <代号> --workspace "<主对话工作区绝对路径>"
node "<cli>" resume --run <run_id> --brief "<返工.md>" --level normal --workspace "<主对话工作区绝对路径>"
node "<cli>" status --run <run_id> --workspace "<主对话工作区绝对路径>"
node "<cli>" watch --run <run_id> --workspace "<主对话工作区绝对路径>"
node "<cli>" cancel --run <run_id> --workspace "<主对话工作区绝对路径>"
```

审查也可用 `--base <分支>` 或 `--commit <sha>`。讨论多个参与方时分别调用并指定 `--agent`，最终由 Codex 按证据裁决。并行写入必须使用互不重叠的目录或独立 worktree。只有用户或当前规则授权时才启动协作方，不把安装本技能视为无限授权。

## 结果与验收

保存 run_id，通过 status 查看状态。
0.6.2 删除了自动弹出终端运行时。
配置项 `dispatch.watch` 保留 `off` 与 `auto`。
两者仅用于兼容旧配置，均不再自动开窗。

任务进度以网页工作台为主要查看入口。
随用启动不自动打开浏览器。
历史管理页可手动刷新。
星图看板每 2 秒自动轮询一次。
主控与用户仍可选使用手动 `watch` 查看进度。

关闭终端查看不会取消任务。
停止任务请使用 `cancel --run <run_id> --workspace "<主对话工作区绝对路径>"`。

完成后读取 `report`、`last_message`、`changes`、`warnings` 和 `run_dir/diff.patch`，逐项检查实际 diff，并亲自运行必要验证。edit 模式的测试由主控执行，不能只采信协作方的通过声明。审查使用新会话，逐条核实发现；讨论意见不按多数票决定。

允许在原任务范围内返工一次，再失败由 Codex 接手或报告具体阻碍。出现需要输入、额度耗尽、权限拒绝时报告原因，不提升权限、不无限重试。汇报实际协作方、模型、验证结果及可用的用量信息，未返回费用不能当作零费用。

排查参数与结果字段时读 [CLI 参考](references/cli.md)，详细配置读 [配置参考](references/config.md)。可选 Codex 原生钩子需在 `/hooks` 信任；未信任时不会执行。它只识别常见直接 shell 调用，不覆盖手工终端或任意包装脚本。

## 讨论与执行选择

用户选择独立讨论流程时，主控独立形成意见并单独记录，不把该意见发给其他 AI；给外部参与者提供统一、中立的文件目录、范围和约束，减少重复材料。按任务规模选择人数，只在实质分歧时开展第二轮。例如可配置 DeepSeek max、GLM max、MiMo high 参与讨论，并选择内置 gpt-6.1-sol 执行；具体参与者、模型和推理强度遵循用户配置，不是发行默认。没有授权时不新增外部调用或内置并行任务。

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

## 讨论预算与记录清理

主控为 pi 讨论显式指定 `--scope <相关路径>` 或 `--file <文件>`，可重复使用；未指定范围只分析任务材料。主控每次用 `--max-files N` 指定文件数、`--max-tool-calls N` 指定工具预算；文件数默认不限，工具调用默认 24 次，讨论默认最多 2 轮。续接不传新值时沿用上次预算。预算超限或访问范围外路径时暂停交主控决定，不自动扩大范围或无限重试。pi 预载上下文和历史不在工具读取计数内，不能把该预算当作 token 上限。

结果中的未知用量与费用应报告“暂无数据”，不能视为零；已经返回的部分用量在失败或取消后仍有意义，上游填充的零值无法与真实零值再区分。

用户要求清理时先运行 `cleanup --workspace "<主工作区>" --group <组名>` 或 `--before YYYY-MM-DD` 查看候选，已获删除授权后再加 `--apply`。只清理工作区 `.codex/foreman/runs`；活跃任务、查看器或不明状态阻止清理，不绕过检查。此命令不删除内置对话、native-tasks、讨论汇总、更新材料或配置，也不清理所有原生聊天；它和全局界面的记录删除是两套范围。

## 全局历史与界面（history / history-ui）

索引在 `CODEX_HOME/foreman/history`（未设置时 `~/.codex/foreman/history`）。实际调用任务时才登记，各记录独立原子文件，保存来源、工作区、原 run 目录等定位信息。列表读取时打开原 run 的 `meta.json`，展示模型、状态和 native session id，聊天全文不进索引。`history`、`check` 只读不写，不产生登记。主控无需为登记做额外操作。

```text
node "<cli>" history
node "<cli>" history --refresh --workspace "<旧工作区绝对路径>"
node "<cli>" history --refresh
node "<cli>" history --legacy-global
node "<cli>" history --run <索引id>
node "<cli>" history --search "<文字>" --provider "pi cli"
node "<cli>" history-ui [--background] [--status] [--stop] [--port <端口>] [--workspace "<旧工作区>"] [--legacy-global] [--no-open]
```

约定：`history` 默认输出 JSON 列表，在任意启动目录都能看到所有已登记工作区，不逐个切文件夹，也不扫描磁盘。导入旧工作区只用 CLI，`--refresh --workspace` 导入指定旧工作区并刷新已知目录，`--refresh` 刷新全部已知目录，`--legacy-global` 导入旧 `CODEX_HOME/foreman/runs`。`--run <索引id>` 单独预览一条记录，索引 id 不是原 run_id，从列表返回值取。预览各截前 12000 字符，按字节读取可能更短。敏感模式和思考标签尽力遮盖，不是完整过滤，材料仍需核对。`--search` 和 `--provider` 是另一组列表筛选示例，只筛列表，不参与单条预览。`history-ui` 默认在 127.0.0.1:50418 启动。
可用 `--port 0` 随机分配端口。
服务已在运行时核验身份并复用实例。
新建前台服务按 Ctrl+C 退出。
加 `--background` 或复用服务会直接返回。
`--status` 查询运行状态。
`--stop` 校验身份后停止服务。
`--no-open` 只输出 URL，不打开浏览器。
启动 URL 包含访问令牌，不得共享。

可在用户配置中设置随用启动。
文件为 `CODEX_HOME/foreman/history-ui-settings.json`。
未设 `CODEX_HOME` 时默认为 `~/.codex`。
内容设为 `{"schema_version":1,"on_use":true,"port":50418}`。
实际调用任务 CLI 时并行拉起隐藏服务。
排除 help、version 与 history-ui 管理命令。
Codex 启动或 SessionStart 钩子均不拉起。
首次拉起向 stderr 输出 URL。
启动时无有效宿主则跳过拉起。
运行中宿主未知则保守保持服务。
Windows 下多个关联宿主全退出才自然关闭。

删除边界：界面默认不删除任何记录，需筛选、预览、勾选、预览删除范围并明确确认，按精确选中项跨工作区删除，不按模糊名称批量删。活跃任务、查看器、登记锁、异常路径、符号链接、不明状态都会阻止删除，删除前重新验证，范围变了就重新预览。只清理 Foreman 本地记录，保护认证、用户配置、个人聊天、native-tasks 和源码等非选中内容。run 内 pi-sessions 随 run 一并清理。旧全局 pi 原生会话已在删除预览前提供可选开关，勾选才纳入。只处理授权 pi sessions 目录内的 `.jsonl`，首行 `type` 为 `session` 且 id 精确匹配。未匹配、越界或被共享的会话保留，符号链接和活动 pi 任务阻止删除。Foreman 之外手动续接过同一 pi ID 的活动无法核实，主控应让用户先关闭该 pi 会话再删除，不声称所有进程均已核查。范围以删除预览列出的为准。Antigravity、opencode、Codex 等外部原应用聊天缺少已验证删除接口，界面明确保留原生聊天，不把本地清理当作原应用聊天删除成功。

界面移植上游 MIT 仓库 DaydayupV/claude-foreman 的 31 个渲染 JS 模块、11 个头像、星图、相机、飞入看板交互和样式，取自网页快照 commit `a1e52825b42e4137188ef0d7d2ecaf689147556c`（2026-10-30），管理页带“星图看板”入口。它不是上游 Claude 桌面会话发现功能的完整移植。未采集的终端事件、用量、费用、速度和并发名额不展示，或标为未采集/—，不含上游回放和演示数据。详细说明读 [全局历史说明](references/history.md)。

## Antigravity 桌面协作

实验性桌面适配支持 discuss、review 和 discuss 续接。先启动并登录官方桌面，再配置精确模型 ID 和 experimental: true。暂不支持 run；请求禁用工具，并核验工作区前后快照，不提供系统级只读隔离。用法见 [桌面接入说明](references/antigravity.md)。

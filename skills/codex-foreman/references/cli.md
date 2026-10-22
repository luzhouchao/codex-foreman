# 脚本参考：check、models 和结果字段

SKILL.md 里只留了决策流程和常用命令。排查环境、帮用户选模型、看结果 JSON 里某个字段的意思时，读这里。

## check
检查环境能不能用：Node.js、Git，以及配置里的每个协作方，结果在 `agents.<代号>` 里。
- **Codex CLI**：能否启动、是否已登录；再按 Codex 自带的模型清单核对各等级配置的推理强度（不发请求），结果列在 `efforts` 里；按各类任务实际用的沙箱模式，用 `codex sandbox` 在沙箱里跑一条 echo（不调模型），结果列在 `sandbox` 里，`danger-full-access` 不进沙箱、不测。Windows 上沙箱起不来时，会顺带试 unelevated 沙箱，能用时写在 `fix` 里。
- **API**：key 是否设置，并发一个很小的请求确认能连通。
- **opencode**：能否启动、`opencode models` 里有没有这个模型，并发一个很小的请求确认能用；各等级给它配置了推理强度（variant）的，先按 opencode 的模型清单核对，清单里没有的直接判不通过，其余每个档位再各发一个小请求，结果列在 `variants` 里。
- **pi**：能否启动、模型清单里有没有这个模型，并发一个很小的请求确认能用；推理强度只按清单核对（pi 遇到模型不支持的档位不报错，会悄悄换成最接近的一档，发请求试不出来），结果列在 `efforts` 里。

总体 `ok` 只看 Node.js 和被等级引用到的协作方；没被引用的不通过只是报告出来，不影响使用。每项不通过时，结果里的 `fix` 写明该怎么处理，转告用户即可。

结果里的 `summary` 是总配置情况：`levels` 是每一格交给谁、什么模型和推理强度、检查是否通过（不通过的写了 `problem`），`agents` 是每个协作方用在哪几格，`warnings` 是值得注意的地方（没用到的协作方、明文写在配置里的 key、shell 权限用于执行、失效的旧代号）。跑完 `check` 后，用一张等级表和一份提醒把它告诉用户，写法同 `$codex-foreman 配置` 的最后一步。`config` 的输出里也有 `summary`，只是不带检查结果。

## models
列出本机 Codex、opencode、pi 自带的模型清单（含每个模型支持的推理强度），以及每个 API 协作方的接口列出的模型名（不含推理强度），并核对配置里的模型在不在清单里、不在时给出最接近的写法。只读，不发模型请求。用户问有哪些模型可选、或者要换模型和推理强度时用。

## 结果字段
`run`、`resume`、`discuss`、`review` 的结果以 JSON 打印到 stdout，主要字段：
- `report`：协作方的结构化报告。审查没有结构化报告：`report` 为 `null`，审查意见是 `last_message` 里的文字。执行和讨论的报告不是合法 JSON 时，也只有 `last_message`。
- `last_message`：没有 `report` 时，协作方最后一条回复的原文，只保留前 8000 字，全文在 `run_dir/last-message.txt`。
- `changes`：脚本追踪到的工作目录内改动。每个文件标有 `by`：`agent` 表示有工具事件证明是执行的协作方改的（改名前的记录里写作 `codex`）；`reported` 表示只有它在报告里自称改过，常见于用命令或脚本写的文件；`unknown` 表示两样都没有。标了 `group_run` 的落在同组另一个任务的写入范围里。
- `notes`：提示信息，比如归属未知的改动、协作方报告了但没追踪到的文件、Codex 的沙箱启动不了命令。
- `warnings`：要注意的问题，比如讨论或审查时文件被改了、审查期间改动又变了。
- `questions` 和 `needs_decision`：协作方要人回答的事，见 SKILL.md 的"协作方要人回答时"。
- `session_id`、`run_dir`：完整 diff 在 `run_dir/diff.patch`，审查的补丁在 `run_dir/review.patch`。
- token 消耗：`usage` 是本次调用的输入、缓存、输出 token（`usage_scope` 为 `session_total` 时是整个会话的累计量）；`last_request` 是最近一次请求的用量和模型上下文窗口；`rate_limit` 是 Codex 额度的已用比例；`quota_resets_at` 是额度预计恢复的时间。
- `agent`、`model_shown`、`effort`：这次交给了哪个协作方、实际用的模型和推理强度。API、opencode 和 pi 协作方的讨论结果没有改动追踪（`changes.available` 为 `false`）；API 协作方的 `files` 列出附带了哪些文件，opencode 和 pi 协作方多一个 `cost_usd`。
- `isolation`、`run_access`：opencode 和 pi 做执行时，写明没有系统沙箱（`tools`）和这次的权限档位。
- `generated_images`：这一轮生成的图片原文件。
- `review_scope`：审查的范围、文件数和指纹。

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

## version

`node "<cli>" version --workspace "<主工作区>"` 输出版本与来源 JSON。安装副本读取 `.foreman-install.json`，源码调用读取 package.json；config 输出也包含 version。它不联网检查更新。

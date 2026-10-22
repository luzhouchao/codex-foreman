---
name: codex-foreman
description: 由 Codex 主控调度 pi、opencode 等 CLI 完成编码、独立审查和方案讨论，记录结果并由 Codex 验收。用户要求外部模型协作、派活或使用 foreman 时使用。
---

# Codex Foreman

Codex 负责拆解、决策和验收，协作方通过本技能的 `scripts/cli.mjs` 执行。下文 `<cli>` 指该文件的绝对路径，不能使用 Claude 插件变量。

首次使用运行 `node "<cli>" config --cwd "<项目>"`，读取配置、可用协作方和偏好。用户配置位于 `${CODEX_HOME}/foreman/config.json`（未设置时为 `~/.codex/foreman/config.json`），项目配置为 `.codex/foreman.json`。项目配置只能收紧权限。默认各等级是 `"codex host"`，由当前 Codex 自己完成；不要自动选模型或启用外部调用。

## 配置和派活

根据用户要用的工具运行 `models`，使用实际列出的模型标识，配置 `agents` 与 `levels`。pi 和 opencode 的执行需配置 `run_access: "edit"` 或 `"shell"`；edit 允许编辑但不运行命令，shell 无系统沙箱，只在用户授权的范围内启用。模型、费用及权限不能由项目文件自行提升。`check` 会对部分适配器发出实际模型请求，可能消耗额度。

三类工作各自定级：`simple` 为做法确定，`normal` 为需要局部判断，`complex` 为复杂方案或高风险改动。很小的工作由 Codex 直接完成。用户点名派活时用 `--agent`；否则遵循配置等级。`dispatch.auto` 只表达用户的调度偏好，不能覆盖当前会话权限及更高优先级指令；默认关闭，用户明确要求的外部调用可直接执行。

将目标、允许修改的路径、约束、验收标准写到任务说明文件，再执行：

```text
node "<cli>" run --cwd "<项目>" --brief "<任务.md>" --title "<标题>" --level normal --agent <代号>
node "<cli>" discuss --cwd "<项目>" --brief "<议题.md>" --title "<标题>" --level normal --agent <代号>
node "<cli>" review --cwd "<项目>" --uncommitted --brief "<审查要求.md>" --level normal --agent <代号>
node "<cli>" resume --run <run_id> --brief "<返工.md>" --level normal
node "<cli>" status --run <run_id>
node "<cli>" watch --run <run_id>
node "<cli>" cancel --run <run_id>
```

审查也可用 `--base <分支>` 或 `--commit <sha>`。讨论多个参与方时分别调用并指定 `--agent`，最终由 Codex 按证据裁决。并行写入必须使用互不重叠的目录或独立 worktree。只有用户或当前规则授权时才启动协作方，不把安装本技能视为无限授权。

## 结果与验收

保存 run_id，通过 status 查看状态。`dispatch.watch: "auto"` 时，Windows 执行器会在任务登记后自动打开实时终端；同一 Codex 会话的同组任务共用窗口，主控无需另外开窗。将参与同一场讨论的调用传入相同的 `--group`。窗口关闭或按 q 只结束查看，任务继续；完成后窗口保留结果。设为 `"off"` 可关闭自动展示。其他系统目前手动运行 watch。

此实现使用独立 Windows PowerShell 窗口，尚未连接 Codex 内置终端。`meta.json` 中的 viewer 记录启动请求或错误，`viewer-ready.json` 表示查看器已真正启动。开窗失败时继续任务，并提供手动 watch 命令。可重新运行 watch 查看记录。

完成后读取 `report`、`last_message`、`changes`、`warnings` 和 `run_dir/diff.patch`，逐项检查实际 diff，并亲自运行必要验证。edit 模式的测试由主控执行，不能只采信协作方的通过声明。审查使用新会话，逐条核实发现；讨论意见不按多数票决定。

允许在原任务范围内返工一次，再失败由 Codex 接手或报告具体阻碍。出现需要输入、额度耗尽、权限拒绝时报告原因，不提升权限、不无限重试。汇报实际协作方、模型、验证结果及可用的用量信息，未返回费用不能当作零费用。

排查参数与结果字段时读 [CLI 参考](references/cli.md)，详细配置读 [配置参考](references/config.md)。可选 Codex 原生钩子需在 `/hooks` 信任；未信任时不会执行。它只识别常见直接 shell 调用，不覆盖手工终端或任意包装脚本。

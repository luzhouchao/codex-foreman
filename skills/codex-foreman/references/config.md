# 配置参考

用户配置：CODEX_HOME/foreman/config.json，未设置 CODEX_HOME 时为 ~/.codex/foreman/config.json。CODEX_FOREMAN_CONFIG 可覆盖路径。项目 .codex/foreman.json 只能收紧权限。

## agents

- type：pi cli、opencode cli、codex cli 或 api。
- model：pi/opencode 使用 models 返回的 provider/model。
- bin：CLI 绝对路径；JS 入口由当前 Node 执行。pi web 指向其 node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js。
- run_access：pi/opencode 执行需配置 edit（文件工具）或 shell（含命令，无系统沙箱）。未配置时只能讨论、审查。
- max_parallel：同一协作方并发上限。
- API 仅参与讨论，使用 base_url、model、api_key_env，不应在可提交文件里写密钥。

pi 继承自身认证，不复制密钥；关闭用户扩展、skills、MCP，只加载本调度器路径守卫。

## levels

run、review、discuss 各有 simple、normal、complex。值为 "codex host" 时由当前主控完成；否则 run/review 为 { "agent": "代号" }，discuss 为该对象的数组。effort 可选，以 models 返回值为准。CLI 必须指定 --level，--agent 可覆盖目标。

## dispatch

- auto 默认 false，不主动派活；用户点名的调用按请求执行。不能覆盖会话权限。
- watch 默认 off；设 auto 时 Windows 任务登记后自动打开实时终端（优先 PowerShell 7），同组共用窗口。关闭查看不取消任务，其他系统手动 watch。intro 默认 false，不播放动画。
- discuss_max_rounds 默认 2，限制讨论轮数。
- timeout_min 默认 480，stall_min 默认 40，busy_ask_min 默认 2，单位为分钟。
- runs_dir 默认 CODEX_HOME/foreman/runs；CODEX_FOREMAN_RUNS_DIR 可覆盖。

将 runs_dir 设为 `.codex/foreman/runs` 可保存到主对话工作区。相对路径锚定 `--workspace`，其次 CODEX_FOREMAN_WORKSPACE，最后 CLI 启动目录；不会跟随协作方的 --cwd。所有查询、续接和取消命令都应传同一个 --workspace。绝对 runs_dir 仍按原位置使用，自动查看器和生成的 watch.mjs 会固定所需记录目录。

首次仅生成主控处理的空配置，不自动选模型。编辑后用 config --cwd <项目> 检查 resolved_levels。check 会对部分适配器发送小型模型请求。

## 内置任务与会话边界

`codex host` 表示交回主控，不代表 CLI 调度内置 agent；用户选择内置 Sol 时由主控直接调用宿主工具，使用 native-record 保存明确报告的状态。该命令记录固定在主工作区 `.codex/foreman/native-tasks`，不跟随 dispatch.runs_dir 的绝对路径覆盖。

主控遵循用户的讨论与执行偏好。例如可配置 DeepSeek max、GLM max、MiMo high 参与讨论，并选择内置 gpt-6.1-sol 执行；不将示例硬编码为通用发行默认。旧全局运行目录和 pi 原生会话不会自动迁移或删除；认证仍由原 CLI 管理。Windows 自动查看器是独立窗口，优先 PowerShell 7、回退 Windows PowerShell，不是 Codex 内置终端，也不监测内置子智能体。

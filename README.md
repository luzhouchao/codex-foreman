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

安装器复制技能到 `$CODEX_HOME/skills/codex-foreman`，默认 `~/.codex/skills/codex-foreman`；已有目录时拒绝覆盖。重新打开 Codex 会话后使用 `$codex-foreman`，例如“用 pi 实现这个功能，完成后你检查 diff 并运行测试”。

也可不安装，直接调用：

```powershell
node .\skills\codex-foreman\scripts\cli.mjs config --cwd E:\your-project
node .\skills\codex-foreman\scripts\cli.mjs models
```

首次配置默认由当前 Codex 自行处理，不自动选择外部模型。将 `examples/config.pi.json` 中的模型替换为 `models` 返回的真实 `provider/model`，再合并到配置输出标明的用户配置文件。使用 `--agent pi-worker` 可明确指定 pi。opencode 类型写作 `opencode cli`，模型同样使用工具实际返回的标识。

```powershell
node .\skills\codex-foreman\scripts\cli.mjs run --cwd E:\your-project --brief E:\task.md --title 实现功能 --level normal --agent pi-worker
node .\skills\codex-foreman\scripts\cli.mjs status
```

配置与运行记录独立于 Claude，位于 Codex home 下的 `foreman`。环境变量使用 `CODEX_FOREMAN_CONFIG`、`CODEX_FOREMAN_RUNS_DIR`。主控标识为 `codex host`，可与名为 codex 的外部协作方区分。

## 权限与兼容边界

- pi/opencode 的 edit 模式只开放文件工具，主控负责运行测试；shell 模式没有系统沙箱。
- 讨论与审查使用只读工具；pi 通过随包守卫限制路径，不能把它当作操作系统隔离。
- 本版从 Codex skill 调用执行器，并提供可选的 Codex 原生 hooks。
- 保留 Codex CLI 与兼容 API 适配器，但首版验证重点是 pi/opencode。真实模型认证、额度和 CLI 版本需在目标环境验证。
- `check` 可能发送小型模型请求；测试套件使用模拟 CLI，不需要真实凭据。

## 测试

```powershell
npm test
```

上游快照：`eabe4cd5b8e981a6abcd80cf88e4d73c3a0386f8`。保留上游 LICENSE；本项目是独立移植，并非上游或 OpenAI 官方发行。

## pi web 接入

如果已经安装 `@agegr/pi-web`，可将 `agents.pi-worker.bin` 指向其安装目录下的 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，复用 `~/.pi/agent` 的模型与认证配置，无需复制 API key。模型标识应使用该 pi 实际返回的清单。本版已使用 pi 1.2.0 验证。

调度器启动独立 pi 会话，不向浏览器当前聊天注入消息。pi web 更新后若路径改变，修改 `agents.pi-worker.bin`。通过 `check --agent pi-worker` 验证版本、模型清单与实际连通性。

## 自动实时终端

将用户配置的 `dispatch.watch` 设为 `"auto"`，Windows 上每次执行、讨论、审查或续接会自动打开独立终端窗口（优先 PowerShell 7，未安装时回退 Windows PowerShell），显示模型、进度、工具活动和结果。同一 Codex 会话、同一个 `--group` 的并发参与方合用一个窗口。默认关闭，按需在用户配置中开启。

按 q 或关闭查看窗口不会取消任务，需停止任务时使用 `cancel --run <id>`。任务结束后窗口保留结果，可直接关闭。恢复手动展示只需设为 `"off"`。窗口启动失败不影响任务；错误写入日志，可用 watch 手动查看。

此功能由执行器直接触发，不依赖钩子是否已信任。目前自动窗口支持 Windows；Codex 内置终端的自动执行入口尚未接入，其他系统使用手动 watch。

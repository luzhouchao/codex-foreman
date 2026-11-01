# 全局历史：history 与 history-ui

两个命令解决同一件事。从任意启动目录看所有已登记工作区的运行记录，需要时按选中项删除。

## 索引在哪

位置是 `CODEX_HOME/foreman/history`，未设置 `CODEX_HOME` 时为 `~/.codex/foreman/history`。`roots/` 存来源目录和工作区的登记，`entries/` 存每条记录。每条记录一个独立 JSON 文件，写入走原子替换，并发写互不覆盖。

索引保存来源、工作区、原 run 目录等定位信息。模型、状态和 native session id 由列表读取时打开原 run 的 `meta.json` 展示，聊天全文不进索引。登记只发生在实际调用，`history`、`check` 这类查询只读，不产生记录。新任务启动时自动登记，主控不用另跑命令。索引只读已登记目录，不扫描磁盘，也不读原应用的聊天数据库。

## history

```text
node "<cli>" history
node "<cli>" history --refresh --workspace "<旧工作区绝对路径>"
node "<cli>" history --refresh
node "<cli>" history --legacy-global
node "<cli>" history --run <索引id>
node "<cli>" history --search "<文字>" --provider "pi cli"
```

`history` 默认输出 JSON，含 `roots`（已登记目录）、`records`（记录列表）和 `imports`（本次导入结果）。换启动目录执行，读到的是同一份索引。

`--refresh --workspace` 显式导入该旧工作区，同时刷新已登记目录。`--refresh` 不带 workspace 时刷新所有已登记目录。`--legacy-global` 显式导入旧的 `CODEX_HOME/foreman/runs`。

`--run` 预览单条记录，返回 `brief`（任务材料）和 `answer`（公开回答）。各截前 12000 字符，按字节读取，可能更短。这里的索引 id 不是原 run_id，它由路径摘要生成，取 `history` 列表的返回值为准。对敏感模式和思考标签尽力遮盖，这不是完整安全过滤，材料仍需自己核对。

`--search` 对列表字段做大小写不敏感的匹配。`--provider` 按协作方或类型精确筛，例如 `"pi cli"`、`"codex cli"`、`"api"`。这两项只筛列表，和 `--run` 是两个独立用法，`--run` 不做筛选。

## history-ui

```text
node "<cli>" history-ui
node "<cli>" history-ui --background
node "<cli>" history-ui --status
node "<cli>" history-ui --stop
node "<cli>" history-ui --port <端口>
node "<cli>" history-ui --workspace "<旧工作区>"
node "<cli>" history-ui --legacy-global
node "<cli>" history-ui --no-open
```

服务默认在 127.0.0.1:50418 启动，不再默认随机端口。
可用 `--port 0` 随机分配端口。
服务仅接受本机访问，默认汇总所有已登记工作区。

任务进度以网页工作台为主要查看入口。
随用启动不自动打开浏览器。
历史管理页可手动刷新。
星图看板每 2 秒轮询一次。

新建前台服务按 Ctrl+C 停止。
`--background` 转入后台运行并返回。
复用已运行服务的 CLI 命令也会直接返回。
`--status` 查询运行状态与可用 URL。
`--stop` 校验 Origin、CSRF 与实例身份后安全停止。
`--no-open` 只输出 URL，不打开浏览器。

服务已在运行时核验 Bearer 令牌、实例 ID、PID 与启动时间并复用。
端口被未知进程占用时不接管。
URL 片段包含访问令牌，不得共享。

随用启动配置保存在用户级文件：
`CODEX_HOME/foreman/history-ui-settings.json`。
未设置 `CODEX_HOME` 时默认为 `~/.codex`。

```json
{
  "schema_version": 1,
  "on_use": true,
  "port": 50418
}
```

默认文件不存在，等效于 `on_use: false`。
只从用户级读取，项目配置不生效。
自动启动不导入随意工作目录，仅读取已登记全局索引。
显式 `--workspace` 与 `--legacy-global` 手动导入行为保留。

开启后，实际调用任务 CLI 时并行拉起隐藏后台服务。
此调用排除 help、version 与 history-ui 管理命令。
Codex 启动或 SessionStart 钩子均不拉起服务。
首次新启动向 stderr 输出本机 fragment URL。
启动失败不影响原任务执行。

Windows 下依据祖先进程路径、PID 与创建时间确认宿主。
启动时若无有效宿主则跳过自动启动。
运行中宿主查询返回未知时，保守保持服务。
多个关联宿主全部确认退出后才自然关闭。
跨平台手动服务需显式停止，不承诺各系统均随 Codex 退出。

页面上的刷新按钮只能刷新已登记目录。注册新旧工作区要走 CLI，用 `--workspace` 或 `--legacy-global`。

界面移植上游 MIT 仓库 [DaydayupV/claude-foreman](https://github.com/DaydayupV/claude-foreman) 的 31 个渲染 JS 模块、11 个头像、星图、相机、飞入看板交互和样式，取自网页快照 commit `a1e52825b42e4137188ef0d7d2ecaf689147556c`（2026-10-30），管理页带“星图看板”入口。它不是上游 Claude 桌面会话发现功能的完整移植。未采集的终端事件、用量、费用、速度和并发名额不展示，或标为未采集/—，不包含上游回放和演示数据。

## 删除

界面默认不删除任何记录。流程是筛选、预览、勾选记录、预览删除范围、明确确认，然后按精确选中项跨工作区删除。不按模糊名称批量删。

删除前会重新验证。
活跃任务、所选记录关联的活跃查看器、登记锁、异常路径、符号链接和不明状态都会阻止删除。
无关组或工作区的查看器不再全局阻止删除。
预览到确认之间状态变了，要重新预览。
保护认证、用户配置、个人聊天、`native-tasks` 和源码等非选中内容。

清理范围按记录区分：

- Foreman 本地记录：选中才删，run 目录里的 pi-sessions 随 run 一并清理。
- 旧全局 pi 原生会话：删除预览前的可选开关，勾选才纳入。只处理授权 pi sessions 目录内的 `.jsonl`，要求首行 `type` 为 `session` 且 id 精确匹配。未匹配、越界或被共享的会话保留，符号链接和活动 pi 任务阻止删除。范围以删除预览列出的为准，预览没列的不删。Foreman 之外手动续接过同一 pi ID 的活动无法核实，删除前先关闭该 pi 会话，不声称所有进程都已核查。
- Antigravity、opencode、Codex 等外部原应用聊天：缺少已验证的删除接口，界面明确标注原生聊天保留，只清理 Foreman 本地记录。本地记录被删不代表原应用聊天已删除。

## 与 cleanup 的关系

`cleanup --group <组名>` 或 `--before YYYY-MM-DD` 加 `--apply` 的老命令保留兼容。它只操作 `--workspace` 指定工作区的 runs。它不碰全局索引的其他工作区，也不清理所有原生聊天。

# Codex Foreman

Codex Foreman 为 Codex 提供多协作方任务调度能力。当前版本为 0.6.6。

Codex 负责任务拆解与验收。pi、opencode 等外部工具负责执行、讨论或独立审查。默认由主控处理各级任务，不会自动选择模型或向外派活。

## 准备工作

开始前需要具备以下环境：

- Node.js 18 或更高版本
- Git 客户端
- 至少一种可用的协作通道，例如本地工具程序或网络接口

协作通道所需的本地程序、账号登录与模型调用额度需由用户自行准备。

| 协作通道 | 执行 (`run`) | 讨论 (`discuss`) | 审查 (`review`) | 依赖条件 |
| :--- | :--- | :--- | :--- | :--- |
| **pi** | 支持 | 支持 | 支持 | 本地安装 pi 命令并配置可用模型 |
| **opencode** | 支持 | 支持 | 支持 | 本地安装 opencode 命令并完成认证 |
| **Codex CLI** | 支持 | 支持 | 支持 | 本地安装 codex 命令并可调用 |
| **兼容 API** | 不支持 | 支持 | 不支持 | 提供兼容 API 端点地址与访问密钥 |
| **Antigravity Desktop**（实验） | 不支持 | 支持 | 支持 | Windows 平台，且桌面应用已登录运行 |

注：Antigravity Desktop 仅支持读取材料讨论与审查，支持讨论续接。该功能依托提示词约束与前后快照核验，不提供操作系统级硬隔离沙箱。

## 安装步骤

克隆仓库并运行安装脚本：

```powershell
git clone https://github.com/luzhouchao/codex-foreman.git
cd codex-foreman
node .\tools\install.mjs
```

脚本会优先将文件复制到 `$env:CODEX_HOME\skills\codex-foreman`。如果未设置该环境变量，则安装至用户目录下的 `~/.codex/skills/codex-foreman`。目标位置若已存在安装，脚本默认拒绝覆盖。

首次安装要同时安装 Hooks，请把上面的安装命令换成：

```powershell
node .\tools\install.mjs --hooks
```

已完成基础安装的用户若需补装 Hooks，请执行：

```powershell
node .\tools\install.mjs --hooks-only
```

启用 Hooks 后需在 Codex 中输入 `/hooks` 审阅并确认信任。Hooks 用于拦截常见直接 Shell 调用，不属于安全沙箱，无法覆盖在外部独立终端中手工执行的命令。

重新打开 Codex 会话即可加载本技能。初次使用可向 Codex 发送指令：

```text
使用 codex-foreman，先读取可用工具和模型，帮我配置 pi 协作方。
```

## 配置协作方

推荐在 PowerShell 中通过固定变量定位 CLI 脚本路径：

```powershell
$foremanHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$cli = Join-Path $foremanHome 'skills/codex-foreman/scripts/cli.mjs'
```

在项目目录下生成默认配置并列出可用模型：

```powershell
node "$cli" config --cwd "E:\your-project" --workspace "E:\your-project"
node "$cli" models --workspace "E:\your-project"
```

初次生成的配置仅包含主控默认项，不会自动挑选模型。请根据 `models` 返回的真实服务商与模型标识，参考 [配置样例](examples/config.pi.json) 手动将对应字段合并到生成的配置文件中，避免整份覆盖已有配置。

pi 或 opencode 执行任务需要配置 `run_access`：

- 设置为 `edit` 时仅授权文件编辑工具，测试与验证由主控进行。
- 设置为 `shell` 时允许运行终端命令，系统不提供独立沙箱。

部分适配器的 `check` 检查会实际请求模型并消耗调用额度。

完整参数定义请参考 [配置手册](skills/codex-foreman/references/config.md)。

## 日常使用

任务调用统一通过 `--workspace` 指定主工作区目录。`--cwd` 仅作为协作方执行具体命令的目录。任务需提前准备好任务说明文件。

发起执行任务（命令在前台阻塞等待执行结束）：

```powershell
node "$cli" run --workspace "E:\your-project" --cwd "E:\your-project" --level normal --agent pi-worker --brief "E:\task.md"
```

查询任务运行状态：

```powershell
node "$cli" status --workspace "E:\your-project" --run "你的run_id"
```

续接历史任务：

```powershell
node "$cli" resume --workspace "E:\your-project" --run "你的run_id" --level normal --agent pi-worker --brief "E:\revision.md"
```

取消正在执行的任务：

```powershell
node "$cli" cancel --workspace "E:\your-project" --run "你的run_id"
```

如果配置了 `dispatch.runs_dir = ".codex/foreman/runs"`，任务数据将保存在主工作区内。也可以通过环境变量 `CODEX_FOREMAN_WORKSPACE` 代替命令行中的 `--workspace` 参数。更多命令请参考 [CLI 参考](skills/codex-foreman/references/cli.md)。

Codex 内置子智能体由主控直接调度。可用 `native-record` 登记主控明确报告的任务状态；Foreman 不会驱动或实时监控这些任务。

## 历史任务与管理面板

Foreman 在发起外部任务时会自动在全局索引中登记记录。系统不会主动扫描磁盘，也不会收集绕过 Foreman 进行的外部对话。如需导入未记录的旧项目或历史任务，可手动执行：

```powershell
node "$cli" history --refresh --workspace "E:\old-project"
node "$cli" history --legacy-global --workspace "E:\old-project"
```

管理面板的静态网页产物已随仓库内置，无需执行 npm 构建即可直接使用。

启动后台管理服务（默认会自动调起浏览器）：

```powershell
node "$cli" history-ui --background
```

如需在后台静默运行而不打开浏览器，可追加 `--no-open`：

```powershell
node "$cli" history-ui --background --no-open
```

查看面板运行状态与带 Token 的访问地址：

```powershell
node "$cli" history-ui --status
```

停止管理服务：

```powershell
node "$cli" history-ui --stop
```

服务默认绑定 `127.0.0.1:50418`。启动链接包含认证 Token，请勿对外公开或分享。界面支持查看各工作区任务材料与公开回答。删除任务时需经过勾选、预览删除范围与明确确认三步。删除操作清理 Foreman 本地记录及 run 内的 pi 会话。Antigravity、opencode 与 Codex 原应用的聊天保留。旧全局 pi 原生会话默认保留，仅在显式勾选且满足匹配与保护规则时才可清理，具体规则请查阅 [历史记录说明](skills/codex-foreman/references/history.md)。

### 随用启动设置（可选）

随用启动默认处于关闭状态。如需开启，请在配置文件中写入设置。文件路径为 `$foremanHome/foreman/history-ui-settings.json`；若未设置 `$env:CODEX_HOME`，则对应 `~/.codex/foreman/history-ui-settings.json`：

```json
{
  "schema_version": 1,
  "on_use": true,
  "port": 50418
}
```

启用后，在 Windows 系统下核验到受支持的桌面宿主时，执行任意实际调度或查询指令（排除 help、version、history-ui 和 update）均会在后台拉起服务并在此后复用，不会弹窗或新开终端。全部关联宿主确认退出后服务会自动关闭。history-ui 命令本身为显式管理指令，不参与随用启动自动触发。

## 版本更新

0.6.5 及以上版本可在任意目录下执行命令检查并完成更新，无需返回源码目录：

```powershell
node "$cli" update --check
node "$cli" update
```

也可以在 Codex 对话中直接说“更新 Foreman”。

更新程序从官方 GitHub 的 `main` 分支获取最新提交。安装前先备份，再替换程序，保留配置、记忆与历史数据，默认不修改 Hooks。

`--check` 不会替换安装文件，但会产生临时检出与写锁。若本地安装的提交哈希与远端 HEAD 一致，系统提示已是最新版本并跳过安装。

从 0.6.6 起，更新前会通过认证 RPC 停止自有网页服务，等待进程退出后再安装。更新后不会自动拉起网页服务。若已开启随用启动且宿主核验通过，下次实际调用时才会启动。

更新需主动执行，目前不会自动检查或安装。

低于 0.6.5 的版本需在源码仓库根目录下完成一次升级引导：

```powershell
git pull --ff-only origin main
node .\tools\install.mjs --update
```

如需回退到指定备份版本，可使用源码目录下的安装工具：

```powershell
node .\tools\install.mjs --rollback "你的备份ID"
```

查询已安装技能的版本：

```powershell
node .\tools\install.mjs --version
```

## 开发者说明

日常使用预构建页面无需安装前端依赖。修改前端时，请使用 Node.js 22.12 或更高版本安装依赖并重新构建：

```powershell
npm --prefix history-front ci
npm run build:history
```

项目包含模拟 CLI 自动化测试套件，执行测试无需真实凭据：

```powershell
npm test
```

仓库的 GitHub Actions 工作流仅支持手动触发。

## 更多参考与许可

- 技能入口：[SKILL.md](skills/codex-foreman/SKILL.md)
- 配置手册：[config.md](skills/codex-foreman/references/config.md)
- 命令行参考：[cli.md](skills/codex-foreman/references/cli.md)
- 历史记录与服务管理：[history.md](skills/codex-foreman/references/history.md)
- Antigravity 实验接入：[antigravity.md](skills/codex-foreman/references/antigravity.md)
- 版本更新记录：[CHANGELOG.md](CHANGELOG.md)

本项目基于 MIT 协议的 `DaydayupV/claude-foreman` 独立移植开发，非官方发行版。主程序代码遵循 [LICENSE](LICENSE)；前端与内置第三方组件涉及 MIT 及 Apache 等开源许可，详情请查看 [NOTICE](history-front/NOTICE) 与 [组件来源清单](history-front/component-sources.json)。

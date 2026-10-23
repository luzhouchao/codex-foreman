# Antigravity 桌面协作

Codex Foreman 0.5.0 增加实验类型。
类型名称为 antigravity desktop。
另提供 antigravity cli 适配。
本次验证中，CLI 返回账号资格拒绝；桌面调用成功。
使用前需启动并登录官方桌面，已验证 2.25.0。
Windows 仅自动发现运行中的桌面服务进程。
通信走本机 HTTP 与 CSRF。
凭据只保留在内存中，不写入日志文件。
内部接口随桌面升级可能变动，需注意兼容。

首版仅用于材料分析，暂不支持 run。
当前支持 discuss、review 以及 discuss 续接。
主控把 brief、附件或 review 补丁交给模型。
请求中已禁用工具调用，并在运行前后比对快照。
这不属于操作系统级沙箱，不修改桌面全局权限。

用户可配置精确模型目录中的其他模型。
查证目录后需 pin 原生模型，禁止使用别名冒充。
本次仅验证了 gemini-4-argon-medium 与 gemini-3.8-flash-medium。
运行元数据包含 model_verification 与 actual_generated_models。
续接时默认保留上一轮模型，显式传入 --model 可变更。

JSON 配置示例如下。不要设置 bin 和 run_access。

```json
{
  "agents": {
    "gemini-3.8-flash-medium": {
      "type": "antigravity desktop",
      "experimental": true,
      "model": "gemini-3.8-flash-medium",
      "max_parallel": 1
    }
  }
}
```

选模型使用 --agent 与 --effort。
不要使用 --level，避免受已有讨论组白名单限制。
命令示例如下。

```bash
node "<技能目录>/scripts/cli.mjs" discuss --cwd "<任务目录>" --workspace "<主对话工作区>" --agent gemini-3.8-flash-medium --effort medium --brief "<任务.txt>"
```

任务日志写入工作区的 .codex/foreman/runs。
桌面自身会话与缓存仍留在全局目录，不承诺迁移。
日志只记录公开回答与安全元数据，不存 CSRF 与思考文本。

取消时先调用 CancelCascadeInvocation，再轮询 IDLE 确认。
取消操作只停止当前任务，不杀共享桌面进程。
若无法确认，系统会提示远端可能仍在运行。
系统不会把停止等待误判为取消成功。

用量只累计本轮 generatorMetadata，避免与步骤重复计数。
缺失字段记为 null。缓存缺失不计为 0。费用未知。

实测两款已测模型算术成功，续接 5→6 成功，取消确认成功。
未测实际代码执行，不作对应保证。
文档写作流程由 pi DeepSeek 起草、桌面 Gemini4 审改、桌面 3.8 Flash 修订、Codex 验收。
本机代码执行仍由内置 Sol 负责，原讨论组配置保持不变。

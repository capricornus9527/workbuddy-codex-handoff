# WorkBuddy Codex Handoff

**Codex 额度用完了？在 WorkBuddy 对话里选择原聊天，读取需要的上下文，接着做。**

[下载安装包](https://github.com/capricornus9527/workbuddy-codex-handoff/releases/latest) · [测试状态](https://github.com/capricornus9527/workbuddy-codex-handoff/actions/workflows/test.yml)

本地只读提取器 + WorkBuddy Skill，无模型反代、无 API Key、无额外服务、无第三方运行依赖。不要求 Codex 还能回答，也不用事先生成总结。

```text
在 WorkBuddy 输入“接续 Codex”
       ↓
选择聊天（标题 / 时间 / 工作区，支持多条）
       ↓
选择节选、最近记录、消息范围或工具记录
       ↓
WorkBuddy 核对原工作区，整理上下文，继续任务
```

> 第一次发布：v0.1.0。插件只提供 Skill 和读取工具，不修改 WorkBuddy 聊天数据库，不声称无损恢复整个 Codex 运行状态。对话选择使用宿主提问工具或文字列表，**不是独立弹窗**。宿主是否展示交互选项取决于当前 WorkBuddy 版本。

## 安装（Windows 推荐）

先安装并启动过 WorkBuddy，准备已有的 **Node.js 24+**。安装器不下载运行时，不修改 PATH、代理、登录或自启设置。

下载本仓库或 Release 的源码包，在仓库根目录用 PowerShell 执行：

```powershell
./scripts/install.ps1 -NodePath '你的 node.exe 绝对路径'
```

若 PATH 中已经是 Node 24+，可以省略 `-NodePath`。国内版默认安装到当前用户的 `~/.workbuddy/skills/codex-handoff`。自定义配置目录（或国际版）用 `-WorkBuddyHome` 指定实际目录，不能把不同配置目录的登录态混为一谈。

安装后新建 WorkBuddy 对话，必要时重启应用。在对话中输入：

> 使用 codex-handoff，列出我最近的 Codex 聊天，让我选择后接着工作。

也可以直接给出范围：

> 使用 codex-handoff，找“示例项目”的聊天，先给我候选，不要自动选择。
>
> 选择第 2 条，读取最近 30 条消息，结合原工作区继续未完成任务。
>
> 再读取第 1～20 条消息，以及相关工具结果，核对之前失败的原因。

本机直接安装是**用户级 Skill**，调用名为 `codex-handoff`（宿主支持时可输入 `/codex-handoff`）。不必额外添加 MCP 或改写聊天库。

### 插件市场方式

仓库同时包含标准 `.codebuddy-plugin/plugin.json` 与 `marketplace.json`。支持该市场规范的 WorkBuddy/CodeBuddy 客户端可添加市场：

```text
/plugin marketplace add capricornus9527/workbuddy-codex-handoff
/plugin install codex-handoff@codex-handoff-marketplace
```

桌面版也可从插件页面添加此 GitHub 仓库地址。命名空间安装后的技能通常为 `/codex-handoff:codex-handoff`。若桌面版本不接受 GitHub 市场来源，使用上面的本地安装器或上传 Release 的 Skill ZIP（ZIP 根目录为 SKILL.md）。不必同时装两份。

## 读取哪些内容

| 项目 | 行为 |
|---|---|
| 聊天发现 | 实际 CODEX_HOME 下的 `state_*.sqlite`，只读；不可用时回退标题索引和会话文件 |
| 搜索 | 标题、工作区、UUID；分页展示，不默认搜索全部聊天正文 |
| 归档及提供方 | 默认列活动聊天，可包含归档；不按模型提供方过滤 |
| 原始格式 | sessions、archived_sessions 中的 `.jsonl` 和 `.jsonl.zst` |
| 默认节选 brief | 开头两条非环境注入的用户文字 + 最后十二条文字；不是语义总结 |
| 按需扩展 | 最近 N 条、指定消息区间、独立工具调用/结果区间，均报告截断 |
| 可追溯 | 完整聊天 ID、原文件路径、JSONL 行号、消息编号和遗漏数量 |
| 工作区 | 给出原路径及存在性；由 WorkBuddy 核对实际文件、规则和 Git 状态 |
| 不读取 | 登录凭据文件、隐藏推理、系统/开发者消息、全局记忆和图片内容 |

长消息和工具结果有长度上限；多次分页或提高 `--item-chars`/`--max-chars` 可补读。包含图片的消息只显示占位符。暂不解析工具输出里的嵌套媒体、远程会话、只有云端的聊天或分支的隐式父会话。原目录被删时需要用户选择真实工作区。

## 不用 Skill，直接提取

```powershell
node ./skills/codex-handoff/scripts/handoff.mjs doctor
node ./skills/codex-handoff/scripts/handoff.mjs list --query '示例' --limit 12
node ./skills/codex-handoff/scripts/handoff.mjs list --archived --scan
node ./skills/codex-handoff/scripts/handoff.mjs extract --session '完整聊天UUID' --mode recent --count 30
node ./skills/codex-handoff/scripts/handoff.mjs extract --session '完整聊天UUID' --mode range --from 1 --count 20
node ./skills/codex-handoff/scripts/handoff.mjs extract --session '完整聊天UUID' --mode tools --from 1 --count 10
```

`--home` 覆盖 CODEX_HOME；环境变量未设置时默认 `~/.codex`。输出是 JSON，只打印到当前终端，不自动保存。SQLite 不可读时会给出诊断，可用 `--scan` 跳过 SQLite。不要使用管理员权限去绕过宿主的文件授权。

## 升级、卸载与交回

升级时重跑安装器；已有同名 Skill 会先移到 `~/.workbuddy/codex-handoff-backups/`，其他技能和设置不变。

```powershell
./scripts/install.ps1 -Uninstall
```

卸载只将本技能移至备份，保留用户资料。要回滚，可在退出 WorkBuddy 后用备份恢复该技能目录。运行期间无后台常驻进程或计划任务。

额度恢复后可让 WorkBuddy 在你指定的目录写交接说明，再由 Codex 读取。此版本不做双向数据库同步。

## 隐私和验证

插件本身不联网，但**选中内容进入 WorkBuddy 对话后，可能传给其所选模型服务**。常见 Token/密码/私钥做尽力脱敏，不能替代人工检查。详情见 [SECURITY.md](SECURITY.md)。不应将真实聊天提交到本仓库。

```powershell
node --test
node --check ./skills/codex-handoff/scripts/handoff.mjs
```

测试只生成临时合成会话，覆盖只读性、SQLite 回退、归档、Zstd、分页、工具、无效输入、脱敏和越界路径。GitHub Actions 在 Windows 与 Linux 的 Node 24 上运行。安装、宿主发现与实际模型接手属于不同验证层，具体版本记录见 [验证说明](docs/VALIDATION.md)。

## 来源与许可

独立实现，MIT 开源；与腾讯 WorkBuddy、OpenAI Codex 无官方隶属关系。[来源与设计](docs/SOURCES.md)。

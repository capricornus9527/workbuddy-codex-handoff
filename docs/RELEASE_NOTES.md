首个公开版本：选择 Codex 聊天 → 本地只读提取 → WorkBuddy 对话接手。

- 支持标题/工作区/UUID 查找、活动及归档聊天、JSONL 与 Zstd。
- 默认节选、最近消息、指定范围和工具记录；保留来源与截断信息。
- Windows 安装器记录已有 Node 24+ 路径；升级/卸载保留备份，不修改登录或自启。
- 提供标准插件市场结构，以及 SKILL.md 位于根目录的独立 Skill ZIP。

下载 `codex-handoff-skill-0.1.0.zip` 可在 WorkBuddy 添加技能页面导入；Windows 推荐下载完整项目包并使用安装器。`SHA256SUMS` 用于校验下载完整性。

需要已有的 Node.js 24+。导入的 Skill ZIP 不携带用户机器上的 runtime.json；如果 Node 不在 PATH 中，请通过安装器指定已有 node.exe。

提取器不联网；选中记录进入 WorkBuddy 模型上下文后，按其模型服务的数据规则处理。不是无损会话恢复或模型反代。测试和兼容性范围见仓库验证说明。

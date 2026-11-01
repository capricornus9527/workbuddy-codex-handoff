# 来源与设计

本项目提取器和安装脚本为独立实现，未复制其他项目代码。MIT 许可证仅覆盖本仓库代码，不改变宿主服务或模型服务的条款。

- [WorkBuddy 插件系统](https://www.workbuddy.cn/docs/workbuddy/Plugins)：插件市场与 Skill 入口。
- [CodeBuddy 插件参考](https://www.codebuddy.cn/docs/cli/plugins-reference)：`.codebuddy-plugin/plugin.json`、根目录 `skills/` 及市场结构。
- [WorkBuddy 技能](https://open.workbuddy.cn/docs/skill)：`SKILL.md` 与附带可执行脚本。
- [Codex 源码](https://github.com/openai/codex)：本地会话与状态索引格式的上游；这些内部格式可能随版本改变。
- [codex-porter](https://github.com/vino24/codex-porter)：检索时发现的相关迁移工具。本项目采用只读提取与新对话接手，不使用其数据库写入方式。

输出保留聊天 UUID、记录行号和截断信息。brief 是确定性节选，不调用模型；整理目标、识别取舍及后续执行由用户登录的 WorkBuddy 完成。

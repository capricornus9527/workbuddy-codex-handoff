v0.1.1：完成用户 / WorkBuddy 实测后的接回验收。

- 修复带 Windows 扩展长度前缀的索引路径，以及原文件已压缩但索引仍保留 `.jsonl` 名称的读取问题。
- 新增 `extract --mode prompt`，单独提取并去重当时的用户侧 AGENTS.md / 环境指令，过滤界面噪声。
- 接手步骤仅在一次接手开始时执行；交回 Codex 通过本地 ACTIVE 交接单及一句触发语，不改其配置或规则。
- 修复 Windows PowerShell 5.1 编码、短/长路径与 Node 参数引号兼容性，安装版本跟随包版本。
- Windows 19 项测试通过；覆盖 PowerShell 5.1/7 的安装、升级备份和卸载，以及压缩路径回退的越界拒绝。

下载 `codex-handoff-skill-0.1.1.zip` 可在 WorkBuddy 添加技能页面导入；Windows 推荐完整项目包和安装器。需要已有 Node.js 24+，安装器可指定 node.exe，独立 Skill ZIP 不含本机 runtime.json。

提取器不联网；选中内容进入 WorkBuddy 对话后按模型服务的数据规则处理。脱敏是尽力识别，不保证无损恢复。具体覆盖范围见仓库验证说明。

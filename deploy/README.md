# deploy/ — 已退役（2026-11-09）

本目录曾存放 Windows 专属的 `.ps1` / `.vbs` 运维脚本（`start-openqq.ps1`、`watchdog.ps1`、
`launch-hidden.vbs`）。按 `AGENTS.md` 的架构红线，**运行时代码只随插件包分发、只允许 TS/JS**，
这些脚本已删除，能力迁移到包内 TS 产物：

| 旧脚本 | 新入口（包内 `dist/`） |
|---|---|
| `start-openqq.ps1`（日志轮转 + 单实例） | `dist/openqq-bot.js`（自带日志轮转与单实例锁） |
| `watchdog.ps1`（10 分钟巡检） | `dist/openqq-watchdog.js --once`（`openqq service install` 注册） |
| `launch-hidden.vbs`（无窗口宿主） | 不再需要：detached spawn 由 `bot-launcher` 完成 |
| `scripts/safe-restart.ps1` | `dist/openqq-cli.js restart`（等空闲→停→拉） |

自启注册（唯一的平台差异点）：

```bash
openqq service install     # win32=schtasks / linux=systemd user / darwin=launchd
openqq service status
openqq service uninstall
```

运行时数据仍在 `~/.openqq/`（`.env`、台账、日志、`heartbeat`）——那里**不放代码**。

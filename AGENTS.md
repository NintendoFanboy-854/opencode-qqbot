# opencode-qq-bot 项目硬性约束

> 来源：2026-11-09 用户当轮强调（「所有代码都在插件安装目录里面；看门狗用 TS/JS，具备跨平台可迁移特征」）。
> 视为不可协商的架构红线：违反即返工，不得以「临时脚本」「本机能跑」为由例外。

## 1. 运行时代码只存在于插件安装目录

- 所有可执行代码——bot 本体、插件引导器、看门狗、重启/诊断 CLI、自启安装器——必须随 npm 包分发，
  运行位置 = 插件安装目录 `<plugins>/opencode-qqbot/`（`dist/` 为运行产物，`src/` 为 TS 源）。
- 禁止在以下位置放运行时代码：
  - `~/.openqq/`（只允许运行时数据：`.env`、`*.json` 台账、`*.log`、`heartbeat`）
  - 仓库 `scripts/`、`deploy/`、系统临时目录
- 需要按人/机器定制的只有数据（`.env`、配置），不是脚本。

## 2. 看门狗与运维工具一律 TS/JS，跨平台

- 源码 `src/**/*.ts`，产物 `dist/*.js`，运行时只依赖 bun 或 node，不依赖 PowerShell/VBS/Bash。
- 进程存活判定优先用 Node 原生 API（`process.kill(pid, 0)`、锁文件 pid），
  不要求先跑 `tasklist`/`ps` 才能判活；确需 OS 命令时必须有跨平台分支与降级（参照 `src/core/discovery.ts`）。
- 平台差异只允许出现在**自启注册**这一处：
  - win32 → `schtasks`（由 TS 生成命令）
  - linux → systemd user unit
  - darwin → launchd plist
  由 TS 安装器生成/删除，不得引入 `.ps1`/`.vbs`/`.bat` 作为运行时代码。
- 统一入口（全部落在 `dist/`）：
  - `openqq watchdog --once` / `--loop`
  - `openqq restart [--force]`
  - `openqq service install|uninstall|status`

## 3. 迁移清单（2026-11-09 已完成）

- [x] `src/core/watchdog.ts`：判活（锁 mtime + 心跳 + pid 存在）与重启决策，纯函数优先、可测
- [x] `src/cli/watchdog-main.ts` → `dist/openqq-watchdog.js`：单次/循环巡检入口
- [x] `src/core/bot-control.ts` + `src/cli/openqq-main.ts` → `dist/openqq-cli.js`：`safe-restart.ps1` 的 TS 跨平台等价物（等空闲→停→拉）
- [x] `src/cli/service-main.ts`：三平台自启注册/注销/状态
- [x] 插件引导器内联 watchdog 巡检（OpenCode 在线时即看门狗）
- [x] 下线并删除：`~/.openqq/start-openqq.ps1`、`~/.openqq/watchdog.ps1`、`~/.openqq/launch-hidden.vbs`、
      计划任务 `OpenQQ-Bot`、`OpenQQ-Bot-Watchdog`
- [x] 删除仓库 `deploy/*.ps1`、`deploy/launch-hidden.vbs`、`scripts/safe-restart.ps1`
- [x] `README.md` 安装/排障章节同步为 TS 入口

## 4. 已有的跨平台例外（保留，不得扩大）

- `src/core/discovery.ts` 的 `netstat`/`ss` 端口枚举：已有 Windows/Linux/macOS 三分支 + 失败降级，
  属「OS 命令不可完全避免」的既有例外；新增 OS 依赖必须按同一标准给出分支与降级。

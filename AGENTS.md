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
- [x] 监督语义（2026-11-09 重构，`superviseOnce`）：优雅杀（TERM→宽限 8s→KILL）→ 拉起；
      冷却 2 分钟跳过（防互踢）；重启强度 3 次/15 分钟超限 → give-up 并 QQ 告警（不当永动机）；
      监督者认领锁互斥（插件引导器与计划任务不双开）；连续杀不掉则放弃本轮
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

## 5. 进程处置红线（2026-11-09 加固，违反即事故复盘）

背景：2026-11-09 一日 ≥6 次「无声死亡」（无退出日志），排查实证全部非自监控所为——
真凶是**外部裸杀**（另一会话自认「反复在回合进行中 kill 重启 bot」）。自监控侧已加固
（杀前复核 + 审计分家：`主动杀`/`验尸拉新` 在 watchdog.log 一眼可辨），操作侧红线如下：

1. **禁止裸杀**：不得 `taskkill`/`Stop-Process`/任务管理器结束 bot（`bun.exe` 运行
   `openqq-bot.js` 的实例）。Windows 下进程被杀无退出日志、在途审批/回合随之中断，
   事后无法归因。
2. **重启唯一入口**：`node <plugin>/dist/openqq-cli.js restart --force`（走锁交接，
   30s 僵尸锁宽限后由自愈链拉新）。执行前必须查在途：
   `node <plugin>/dist/openqq-cli.js queue` 或读 `~/.openqq/inflight.json`——
   有 inflight 回合时先告知用户「将中断当前回合」或等待其完成。
3. **改码/部署窗口纪律**：部署 bundle 后若需立即生效，优先等回合自然结束或 Heartbeat
   间隙再 restart；禁止在 bot 处理长回合（>5min）时反复 restart（心跳陈旧会触发看门狗
   优雅杀，与人工重启叠加成连环死亡）。
4. **归因义务**：任何 bot 死亡后，先查 `~/.openqq/watchdog.log`——
   `主动杀` = 看门狗合法动刀（附原因）；`验尸拉新` = 死因为外部/系统级，结合
   死亡时刻的操作记录（谁跑了 kill/restart）归因，不得复归为「又掉线了」了事。
5. **多会话协同**：两个 opencode 会话同仓工作时，动手前 `git status` + 查在途 +
   看 watchdog.log 尾部三件套，避免一方重启 bot 打断另一方正在服务的用户回合。

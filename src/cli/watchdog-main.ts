// @input:  argv（--once | --loop | --interval-min N）、~/.openqq 锁/心跳、core/watchdog、core/bot-control
// @output: (side-effect) 巡检并在必要时重启 bot
// @pos:    cli - 跨平台看门狗入口（dist/openqq-watchdog.js）
//
// 用法：
//   node dist/openqq-watchdog.js --once            # 单次巡检（自启项/timer 调这个）
//   node dist/openqq-watchdog.js --loop            # 常驻循环（默认 10 分钟）
//   node dist/openqq-watchdog.js --interval-min 5  # 自定义周期
// 退出码：0=正常（含"健康"）；1=运行时/配置错误。
import {
  botWatchdogPaths,
  healOnce,
  readEnvField,
  appendWatchdogLog,
  HEARTBEAT_STALE_MS,
} from "../core/watchdog.js"
import { readAppId, startBot } from "../core/bot-control.js"
import { join } from "path"
import { homedir } from "os"

const DEFAULT_INTERVAL_MIN = 10

function parseArgs(argv: string[]): { loop: boolean; intervalMin: number } {
  const loop = argv.includes("--loop")
  const idx = argv.indexOf("--interval-min")
  const raw = idx >= 0 ? Number(argv[idx + 1]) : Number.NaN
  const intervalMin = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN
  return { loop, intervalMin }
}

function currentAppId(): string | null {
  return readAppId() ?? readEnvField(join(homedir(), ".openqq", ".env"), "QQ_APP_ID")
}

function tick(appId: string): void {
  const result = healOnce({
    paths: botWatchdogPaths(appId),
    spawn: () => startBot(import.meta.url, (line) => console.log(line)),
    log: (line) => console.log(line),
  })
  const line = `[watchdog] ${result.action === "ok" ? "健康" : "重启"}：${result.reason}` +
    (result.killedPid ? `；已停 pid=${result.killedPid}` : "") +
    (result.spawnedPid ? `；已拉起 pid=${result.spawnedPid}` : "")
  console.log(line)
  // 健康时静默落盘（避免每 10 分钟一行膨胀日志），异常必记
  if (result.action !== "ok") appendWatchdogLog(line)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const appId = currentAppId()
  if (!appId) {
    console.error("[watchdog] 未找到 QQ_APP_ID（~/.openqq/.env），无法定位实例锁")
    process.exit(1)
  }
  console.log(`[watchdog] 阈值=心跳 ${Math.round(HEARTBEAT_STALE_MS / 60_000)} 分钟；模式=${args.loop ? `loop/${args.intervalMin}min` : "once"}`)
  if (!args.loop) {
    tick(appId)
    return
  }
  tick(appId)
  const timer = setInterval(() => tick(appId), args.intervalMin * 60_000)
  const stop = (): void => {
    clearInterval(timer)
    process.exit(0)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

main()

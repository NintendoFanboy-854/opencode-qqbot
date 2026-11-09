// @input:  ~/.openqq 锁文件与心跳文件、process 存活探测、注入的 spawn/kill
// @output: botWatchdogPaths, readBotHealth, isPidAlive, decideWatchdog, healOnce
// @pos:    core - 跨平台看门狗（纯 Node API，无 PowerShell/OS 脚本依赖）
//
// 2026-11-09 架构红线（见 AGENTS.md）：运维代码只随插件包分发、只用 TS/JS，
// 平台差异只允许出现在「自启注册」一处。判活优先级：
//   锁文件 pid（单实例仲裁的唯一真相）+ process.kill(pid,0) + 心跳文件新鲜度。
// 约定：锁 mtime 由 bot 每 10s 刷新（instance-lock）；心跳文件由 bot 每 60s 刷新，
// 且 2026-11-09 起「抢锁后立即写」，因此「进程活但心跳陈旧」= 真僵死，不是启动中。
import { readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/** 心跳超过 5 分钟未刷新 = 事件循环僵死（与既有看门狗阈值一致） */
export const HEARTBEAT_STALE_MS = 5 * 60_000
/** 锁 mtime 超过 30s 未刷新 = 僵尸锁（与 instance-lock 一致） */
export const LOCK_STALE_MS = 30_000
/** 启动宽限：锁刚建立、心跳尚未落盘的窗口 */
export const STARTUP_GRACE_MS = 60_000

export interface BotWatchdogPaths {
  lockPath: string
  heartbeatPath: string
}

export function botWatchdogPaths(appId: string): BotWatchdogPaths {
  const dir = join(homedir(), ".openqq")
  return { lockPath: join(dir, `openqq-${appId}.lock`), heartbeatPath: join(dir, "heartbeat") }
}

export interface BotHealth {
  /** 锁文件里的 pid；无锁/损坏为 null */
  lockPid: number | null
  /** 锁 mtime 距今毫秒；无锁为 null */
  lockAgeMs: number | null
  /** pid 是否存活；pid 未知为 null */
  pidAlive: boolean | null
  /** 心跳文件距今毫秒；缺失为 null */
  heartbeatAgeMs: number | null
}

export interface WatchdogDecision {
  action: "ok" | "restart"
  reason: string
  /** restart 时若进程仍活着，需要先杀掉的 pid */
  killPid: number | null
}

export interface WatchdogOptions {
  heartbeatStaleMs?: number
  startupGraceMs?: number
}

/** 跨平台进程存活探测：ESRCH=不存在；EPERM=存在但无权限（视为存活） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ageOf(path: string, now: number): number | null {
  try {
    return Math.max(0, now - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

export function readBotHealth(paths: BotWatchdogPaths, now = Date.now()): BotHealth {
  const lockAgeMs = ageOf(paths.lockPath, now)
  let lockPid: number | null = null
  if (lockAgeMs !== null) {
    try {
      const raw = JSON.parse(readFileSync(paths.lockPath, "utf-8")) as { pid?: unknown }
      if (typeof raw.pid === "number" && Number.isInteger(raw.pid)) lockPid = raw.pid
    } catch {
      /* 损坏/半写锁 → pid 未知，交给决策当缺失处理 */
    }
  }
  return {
    lockPid,
    lockAgeMs,
    pidAlive: lockPid === null ? null : isPidAlive(lockPid),
    heartbeatAgeMs: ageOf(paths.heartbeatPath, now),
  }
}

/** 纯决策（表驱动，导出供测试）：只回答「要不要重启、要不要先杀谁、为什么」 */
export function decideWatchdog(h: BotHealth, opts?: WatchdogOptions): WatchdogDecision {
  const heartbeatStaleMs = opts?.heartbeatStaleMs ?? HEARTBEAT_STALE_MS
  const startupGraceMs = opts?.startupGraceMs ?? STARTUP_GRACE_MS

  if (h.lockPid === null) {
    return {
      action: "restart",
      reason: h.lockAgeMs === null ? "进程缺失（无锁文件）" : "锁文件无可读 pid",
      killPid: null,
    }
  }
  if (h.pidAlive === false) {
    return { action: "restart", reason: `锁定进程已退出（pid=${h.lockPid}）`, killPid: null }
  }
  if (h.heartbeatAgeMs === null) {
    const lockAge = h.lockAgeMs ?? 0
    if (lockAge < startupGraceMs) {
      return { action: "ok", reason: `启动中（心跳未落盘，锁龄 ${Math.round(lockAge / 1000)}s）`, killPid: null }
    }
    return { action: "restart", reason: "心跳文件缺失（进程存活但无进展）", killPid: h.lockPid }
  }
  if (h.heartbeatAgeMs > heartbeatStaleMs) {
    return {
      action: "restart",
      reason: `心跳陈旧 ${Math.round(h.heartbeatAgeMs / 60_000)} 分钟（进程疑似僵死）`,
      killPid: h.lockPid,
    }
  }
  return { action: "ok", reason: "健康", killPid: null }
}

export interface HealDeps {
  paths: BotWatchdogPaths
  /** 拉起 bot，返回 pid */
  spawn: () => number
  /** 杀掉残留 pid（默认 process.kill） */
  kill?: (pid: number) => void
  now?: () => number
  log?: (line: string) => void
  opts?: WatchdogOptions
}

export interface HealResult {
  action: "ok" | "restart"
  reason: string
  killedPid: number | null
  spawnedPid: number | null
}

const defaultKill = (pid: number): void => {
  try {
    process.kill(pid)
  } catch {
    /* 已退出 */
  }
}

/** 单次巡检：判活 →（必要时）杀残留 → 拉起。副作用全部经注入，便于测试。 */
export function healOnce(deps: HealDeps): HealResult {
  const now = deps.now?.() ?? Date.now()
  const health = readBotHealth(deps.paths, now)
  const decision = decideWatchdog(health, deps.opts)
  if (decision.action === "ok") return { action: "ok", reason: decision.reason, killedPid: null, spawnedPid: null }

  let killedPid: number | null = null
  if (decision.killPid !== null && decision.killPid !== process.pid) {
    ;(deps.kill ?? defaultKill)(decision.killPid)
    killedPid = decision.killPid
  }
  const spawnedPid = deps.spawn()
  return { action: "restart", reason: decision.reason, killedPid, spawnedPid }
}

/** 极简 .env 读取（与 bot-launcher.readDotEnvField 同语义；此处避免循环依赖） */
export function readEnvField(envPath: string, key: string): string | null {
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq < 0) continue
      if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim()
    }
    return null
  } catch {
    return null
  }
}

/** 追加一行巡检日志到 ~/.openqq/watchdog.log（数据目录，不是代码） */
export function appendWatchdogLog(line: string): void {
  try {
    const dir = join(homedir(), ".openqq")
    writeFileSync(join(dir, "watchdog.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  } catch {
    /* 日志失败不阻断巡检 */
  }
}

// @input:  fs/path/os（台账落盘）
// @output: claimInflight, recordInflight, settleInflight, pendingInflight, classifyInflight（纯函数供测试）,
//          resetInflightJournal（测试用）, INFLIGHT_MAX_AGE_MS, REDISPATCH_MAX_AGE_MS
// @pos:    core - 在途台账（重启换代丢消息修复：QQ 消息派发落账、答复送达销账、启动对账）
//
// 事故背景（2026-10-30，用户实证）：bot 重启/网关静默死亡窗口内到达的 QQ 消息
// 丢失无反馈——在途回合状态全在内存，进程换代即蒸发。本模块把"派发→送达"责任
// 落盘到 ~/.openqq/inflight.json，启动时对账恢复（bridge.recoverInflightRounds）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface InflightEntry {
  /** 跟踪键：真实 QQ msgId；重派回合为合成键 redispatch-<sessionId>-<ts> */
  msgId: string
  userId: string
  sessionId: string
  /** 用户消息原文（截 300 字，对账匹配与通知展示用） */
  text: string
  at: number
  state: "inflight" | "settled"
}

// 对账年龄上限：超 24h 的在途账不再追溯（直接清账）。
// 注意：这也是"重派窗口不限时间"的天然上限——重派窗口设得再大，超 24h 的账已清。
export const INFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000
// 丢失消息自动重派窗口（2026-10-30 用户拍板：默认 2 小时，env QQ_REDISPATCH_MAX_AGE_MS
// 可调；0=关闭自动重派一律通知）。窗口内视为"意图仍然新鲜"自动重派；超期只通知请用户
// 重发——防"陈旧意图"在重启时被意外执行。
export function redispatchMaxAgeMs(): number {
  const n = Number(process.env.QQ_REDISPATCH_MAX_AGE_MS ?? "7200000")
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7_200_000
}

// 测试可经 QQ_INFLIGHT_FILE 指向临时文件
function journalPath(): string {
  return process.env.QQ_INFLIGHT_FILE || join(homedir(), ".openqq", "inflight.json")
}

function load(): InflightEntry[] {
  let entries: InflightEntry[] = []
  try {
    if (existsSync(journalPath())) {
      const raw = JSON.parse(readFileSync(journalPath(), "utf-8"))
      if (Array.isArray(raw)) entries = raw
    }
  } catch {
    entries = [] // 损坏即空，不阻塞启动
  }
  // 读取始终走磁盘：多个 bot 执行体可能共享台账，进程内 cache 会看不到彼此的认领。
  return entries.filter((e) => e.state === "inflight" || Date.now() - e.at <= INFLIGHT_MAX_AGE_MS)
}

function save(entries: InflightEntry[]): void {
  const path = journalPath()
  mkdirSync(join(path, ".."), { recursive: true })
  // 临时文件带进程与随机后缀：并发执行体不会互相覆盖对方的 tmp。
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 }) // 台账含用户消息，POSIX 仅本人可读
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 已改名或清理失败 */ }
    throw error
  }
}

// 所有台账 mutation 共用一把短临界区文件锁。仅原子 rename 不够：两个进程仍可能
// 基于各自旧快照互相覆盖。锁内重新读盘，保证跨进程 claim/settle 不丢更新。
const JOURNAL_LOCK_STALE_MS = 30_000
const JOURNAL_LOCK_WAIT_MS = 5_000
const sleepArray = new Int32Array(new SharedArrayBuffer(4))

function withJournalLock<T>(fn: () => T): T {
  const path = journalPath()
  mkdirSync(join(path, ".."), { recursive: true })
  const lockPath = `${path}.lock`
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600)
      try {
        writeFileSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > JOURNAL_LOCK_STALE_MS) unlinkSync(lockPath)
      } catch { /* 锁不存在/另一进程正在接管，下轮重试 */ }
      if (Date.now() >= deadline) {
        throw new Error(`在途台账锁等待超时: ${error instanceof Error ? error.message : error}`)
      }
      Atomics.wait(sleepArray, 0, 0, 10)
    }
  }

  try {
    return fn()
  } finally {
    // 只释放自己持有的锁； stale 接管后，旧持有者不能误删新锁。
    try {
      if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath)
    } catch { /* 已被 stale 清理 */ }
  }
}

function mutate<T>(fn: (entries: InflightEntry[]) => T): T {
  return withJournalLock(() => {
    const entries = load()
    const result = fn(entries)
    save(entries)
    return result
  })
}

/**
 * AI 派发前原子认领。真实 QQ msgId 无论在途或已销账，都拒绝再次执行；
 * 这把网关的进程内 Set 去重提升为跨进程/重启的 durable gate。
 */
export function claimInflight(entry: Omit<InflightEntry, "state">): boolean {
  return mutate((entries) => {
    if (entries.some((e) => e.msgId === entry.msgId)) return false
    entries.push({ ...entry, state: "inflight" })
    return true
  })
}

/** 派发落账：同 msgId 幂等；sessionId 允许后补（入队时未知、drain 时回填） */
export function recordInflight(entry: Omit<InflightEntry, "state">): void {
  mutate((entries) => {
    const existing = entries.find((e) => e.msgId === entry.msgId)
    if (existing) {
      if (!existing.sessionId && entry.sessionId) existing.sessionId = entry.sessionId
      return
    }
    entries.push({ ...entry, state: "inflight" })
  })
}

/** 销账：答复已送达（或已转入有接管的后台等待/已给用户终态反馈） */
export function settleInflight(msgId: string): void {
  mutate((entries) => {
    const entry = entries.find((e) => e.msgId === msgId && e.state === "inflight")
    if (entry) entry.state = "settled"
  })
}

/** 待对账清单（启动恢复用） */
export function pendingInflight(): InflightEntry[] {
  return load().filter((e) => e.state === "inflight")
}

/** 测试用：清空台账文件状态 */
export function resetInflightJournal(): void {
  withJournalLock(() => save([]))
}

// —— 对账分类（纯函数）——
// 与 opencode/mirror.ts buildDigest 同源的消息形状（最小依赖，避免跨层 import）。
interface HistoryMessage {
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
}

export type InflightClass =
  | { kind: "answered"; answer: string }
  | { kind: "running" }
  | { kind: "lost" }

/**
 * 对账分类：台账条目 × 会话历史 → 该回合的真实状态。
 * - answered：找到该用户消息，且其后已有 idle + assistant 正文 → 完整答案在库里没投出，补投
 * - running：找到该用户消息但尚未 idle（无论是否已有流式正文）→ 回合在跑，重挂后台等待
 * - lost：历史里找不到该用户消息 → 消息从未到达 opencode（网关窗口丢失），重派/通知
 * 匹配口径：历史 user 文本包含台账原文前 50 字（prompt 会加引用前缀/附件注记，不能全等）。
 */
export function classifyInflight(
  entry: Pick<InflightEntry, "text">,
  messages: HistoryMessage[],
): InflightClass {
  const ordered = [...messages].reverse()
  const probe = entry.text.trim().slice(0, 50)
  let userIdx = -1
  if (probe === "") {
    // 纯附件没有文本锚，只能沿用最新用户消息，由 idle/答案状态兜底。
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type === "user") {
        userIdx = i
        break
      }
    }
  } else {
    // 长任务期间可能出现更新用户消息；必须按原文找回原回合，不能只查最后一条，
    // 否则会把已到达的旧消息误判为 lost 并再次派发给 LLM。
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].type === "user" && (ordered[i].text ?? "").includes(probe)) {
        userIdx = i
        break
      }
    }
  }
  if (userIdx < 0) return { kind: "lost" }

  // 回合边界 = 原用户消息之后、下一条用户消息之前。后续新回合的 idle/答案
  // 不能拿来给原回合销账。
  let turnEnd = ordered.length
  for (let i = userIdx + 1; i < ordered.length; i++) {
    if (ordered[i].type === "user") {
      turnEnd = i
      break
    }
  }

  // 有 assistant 正文 ≠ 回合完成。必须在该回合边界内看到 idle，才允许补投。
  const completed = ordered.slice(userIdx + 1, turnEnd).some((m) => m.type === "idle")
  if (!completed) return { kind: "running" }

  // 与直答一致：只补投该回合最终 assistant 正文，不拼接阶段前导语。
  for (let i = turnEnd - 1; i > userIdx; i--) {
    const m = ordered[i]
    if (m.type !== "assistant") continue
    const answer = (m.content ?? [])
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n")
      .trim()
    if (answer) return { kind: "answered", answer }
  }
  return { kind: "running" }
}

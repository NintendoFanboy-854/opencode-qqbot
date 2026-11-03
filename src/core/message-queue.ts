// @input:  ../qq/types（MessageContext）
// @output: MessageQueue, QueuedJob, previewText, agoLabel
// @pos:    core - 忙碌消息队列（Q1 学习自 pi-qqbot queue.ts 的 UX 语义）
//
// 旧行为：忙碌时直接拒绝"上一条消息还在处理中"。新行为（学习竞品）：
// 忙时消息 FIFO 排队并回执，当前回合结束自动 drain 下一条；/cancel 清队。
// 控制面（/queue、审批作答、表单作答）永远即时处理，不进队列。
import type { MessageContext } from "../qq/types.js"

export interface QueuedJob {
  id: number
  userId: string
  ctx: MessageContext
  text: string
  enqueuedAt: number
}

const PREVIEW_MAX = 48

/** 忙碌期间的用户意图键：msgId 不同的重复提问/同图重发仍视为同一意图。 */
export function intentKeyOf(ctx: MessageContext): string {
  const text = ctx.content.replace(/\s+/g, " ").trim()
  const attachments = (ctx.attachments ?? []).map((a) => `${a.content_type}:${a.size}:${a.filename}`).join("|")
  return JSON.stringify({ text, referenced: ctx.referencedMsgId ?? "", attachments })
}

export function previewText(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat || "(空消息)"
}

export function agoLabel(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m 前`
  return `${Math.floor(minutes / 60)}h 前`
}

export class MessageQueue {
  private jobs = new Map<string, QueuedJob[]>()
  private nextId = 1

  constructor(private limit = 20) {}

  /** 入队；满员返回 null（调用方回绝并提示） */
  push(userId: string, ctx: MessageContext): { job: QueuedJob; ahead: number } | null {
    const list = this.jobs.get(userId) ?? []
    if (list.length >= this.limit) return null
    const job: QueuedJob = { id: this.nextId++, userId, ctx, text: ctx.content, enqueuedAt: Date.now() }
    list.push(job)
    this.jobs.set(userId, list)
    return { job, ahead: list.length - 1 }
  }

  hasIntent(userId: string, key: string): boolean {
    return (this.jobs.get(userId) ?? []).some((job) => intentKeyOf(job.ctx) === key)
  }

  shift(userId: string): QueuedJob | undefined {
    const list = this.jobs.get(userId)
    const job = list?.shift()
    if (list && list.length === 0) this.jobs.delete(userId)
    return job
  }

  list(userId: string): readonly QueuedJob[] {
    return this.jobs.get(userId) ?? []
  }

  drop(userId: string, id: number): boolean {
    const list = this.jobs.get(userId)
    if (!list) return false
    const idx = list.findIndex((j) => j.id === id)
    if (idx < 0) return false
    list.splice(idx, 1)
    if (list.length === 0) this.jobs.delete(userId)
    return true
  }

  /** 清空该用户队列，返回清掉的条数 */
  clear(userId: string): number {
    const n = this.jobs.get(userId)?.length ?? 0
    this.jobs.delete(userId)
    return n
  }

  size(userId: string): number {
    return this.jobs.get(userId)?.length ?? 0
  }
}

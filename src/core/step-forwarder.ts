// @input: (none)
// @output: StepForwarder, normalizeStepText
// @pos: core - 按 assistant step 收集全部可见文本，供 bridge 逐段转发到 QQ
//
// 2026-11-12：模型一轮里可以任意交错「文本 → 工具 → 文本 → 工具 → 最终输出」。
// OpenCode 每个 assistant step 有独立 assistantMessageID；text.ended 带完整文本与
// ordinal，step.ended 带 finish。这里只做纯状态：收集、去重、判断最终答复是否已发。

export interface ForwardedFinal {
  messageID: string
  /** 归一化后的文本（仅用于最终答复去重） */
  text: string
}

export function normalizeStepText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
}

export class StepForwarder {
  /** sessionID -> assistantMessageID -> ordinal -> text */
  private parts = new Map<string, Map<string, Map<number, string>>>()
  /** sessionID -> assistantMessageID -> finish（tool-calls/stop/...） */
  private ended = new Map<string, Map<string, string>>()
  /** sessionID -> 已实际转发过的 assistantMessageID */
  private forwarded = new Map<string, Set<string>>()
  /** sessionID -> 已转发过的归一化文本（最终答复去重兜底） */
  private forwardedText = new Map<string, Set<string>>()
  /** sessionID -> 最后一次 finish=stop 的已转发内容 */
  private final = new Map<string, ForwardedFinal>()

  /** 新一轮 execution 开始：只清本轮状态，不动调用方已投递的内容。 */
  startTurn(sessionID: string): void {
    this.parts.delete(sessionID)
    this.ended.delete(sessionID)
    this.forwarded.delete(sessionID)
    this.forwardedText.delete(sessionID)
    this.final.delete(sessionID)
  }

  addText(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (!messageID || !text.trim()) return
    if (this.isForwarded(sessionID, messageID)) return
    let byMessage = this.parts.get(sessionID)
    if (!byMessage) {
      byMessage = new Map()
      this.parts.set(sessionID, byMessage)
    }
    let parts = byMessage.get(messageID)
    if (!parts) {
      parts = new Map()
      byMessage.set(messageID, parts)
    }
    parts.set(ordinal, text)
  }

  /** step.ended：记录 finish，返回当前已缓冲的可转发文本（若已转发则 null）。 */
  markEnded(sessionID: string, messageID: string, finish: string): string | null {
    if (!messageID) return null
    let byMessage = this.ended.get(sessionID)
    if (!byMessage) {
      byMessage = new Map()
      this.ended.set(sessionID, byMessage)
    }
    byMessage.set(messageID, finish)
    if (this.isForwarded(sessionID, messageID)) return null
    const text = this.collect(sessionID, messageID)
    return text || null
  }

  collect(sessionID: string, messageID: string): string {
    const parts = this.parts.get(sessionID)?.get(messageID)
    if (!parts) return ""
    return [...parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n")
      .trim()
  }

  /** 记录一条 step 已真正转发；finish=stop 时同时记录最终答复。 */
  markForwarded(sessionID: string, messageID: string, finish: string, text: string): void {
    if (!messageID) return
    let set = this.forwarded.get(sessionID)
    if (!set) {
      set = new Set()
      this.forwarded.set(sessionID, set)
    }
    set.add(messageID)
    const normalized = normalizeStepText(text)
    if (normalized) {
      let texts = this.forwardedText.get(sessionID)
      if (!texts) {
        texts = new Set()
        this.forwardedText.set(sessionID, texts)
      }
      texts.add(normalized)
    }
    if (finish === "stop") this.final.set(sessionID, { messageID, text: normalized })
  }

  isForwarded(sessionID: string, messageID: string): boolean {
    return this.forwarded.get(sessionID)?.has(messageID) ?? false
  }

  isEnded(sessionID: string, messageID: string): boolean {
    return this.ended.get(sessionID)?.has(messageID) ?? false
  }

  finishOf(sessionID: string, messageID: string): string {
    return this.ended.get(sessionID)?.get(messageID) ?? ""
  }

  /** 尚未转发但已有文本的消息（执行失败收尾时兜底）。 */
  pending(sessionID: string): string[] {
    const byMessage = this.parts.get(sessionID)
    if (!byMessage) return []
    const done = this.forwarded.get(sessionID)
    return [...byMessage.keys()].filter((id) => !(done?.has(id) ?? false))
  }

  hasForwarded(sessionID: string): boolean {
    return (this.forwarded.get(sessionID)?.size ?? 0) > 0
  }

  /** 最终答复是否已经由实时 step 转发过（文本归一化比较）。 */
  wasFinalForwarded(sessionID: string, text: string): boolean {
    const normalized = normalizeStepText(text)
    const last = this.final.get(sessionID)
    if (last && last.text === normalized) return true
    return normalized.length > 0 && (this.forwardedText.get(sessionID)?.has(normalized) ?? false)
  }
}

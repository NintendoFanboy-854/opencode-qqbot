// @input: (none)
// @output: StepForwarder, normalizeStepText
// @pos: core - 按 assistant step 的 text part 逐段记账，供 bridge 到一段发一段
//
// 2026-11-12：模型一轮里可以任意交错「文本 → 工具 → 文本 → 工具 → 最终输出」。
// OpenCode 的 session.text.ended 就是「这一段文本已完整」的事件，且早于工具执行结束；
// 因此 bridge 收到一段就发一段，不合并、不等 step.ended。step.ended 只做两件事：
// 记录 finish=stop（最终答复去重）与 text.ended 缺失时的消息详情兜底。

export interface PendingPart {
  messageID: string
  ordinal: number
  text: string
}

export function normalizeStepText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
}

export class StepForwarder {
  /** sessionID -> assistantMessageID -> ordinal -> text */
  private parts = new Map<string, Map<string, Map<number, string>>>()
  /** sessionID -> assistantMessageID -> finish */
  private ended = new Map<string, Map<string, string>>()
  /** sessionID -> 收到过 text.ended 的 assistantMessageID */
  private sawText = new Map<string, Set<string>>()
  /** sessionID -> assistantMessageID -> 已转发的 ordinal */
  private forwardedParts = new Map<string, Map<string, Set<number>>>()
  /** sessionID -> 已用消息详情兜底转发过的 assistantMessageID */
  private fetched = new Map<string, Set<string>>()
  /** sessionID -> assistantMessageID -> 兜底读取到的完整文本 */
  private fetchedText = new Map<string, Map<string, string>>()
  /** sessionID -> 最后一次 finish=stop 的 assistantMessageID */
  private final = new Map<string, string>()

  /** 新一轮 execution 开始：清空本轮状态。 */
  startTurn(sessionID: string): void {
    this.parts.delete(sessionID)
    this.ended.delete(sessionID)
    this.sawText.delete(sessionID)
    this.forwardedParts.delete(sessionID)
    this.fetched.delete(sessionID)
    this.fetchedText.delete(sessionID)
    this.final.delete(sessionID)
  }

  addText(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (!messageID || !text.trim()) return
    let set = this.sawText.get(sessionID)
    if (!set) {
      set = new Set()
      this.sawText.set(sessionID, set)
    }
    set.add(messageID)
    // 已经转发过的 part 不再覆盖，保证最终答复重建时与已发送内容一致
    if (this.isPartForwarded(sessionID, messageID, ordinal) || this.isMessageFetched(sessionID, messageID)) return
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

  markEnded(sessionID: string, messageID: string, finish: string): void {
    if (!messageID) return
    let byMessage = this.ended.get(sessionID)
    if (!byMessage) {
      byMessage = new Map()
      this.ended.set(sessionID, byMessage)
    }
    byMessage.set(messageID, finish)
    if (finish === "stop") this.final.set(sessionID, messageID)
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

  /** 记录一个 text part 已真正转发（ordinal 是该 step 内 text 段的序号）。 */
  markPartForwarded(sessionID: string, messageID: string, ordinal: number, text: string): void {
    if (!messageID) return
    let byMessage = this.forwardedParts.get(sessionID)
    if (!byMessage) {
      byMessage = new Map()
      this.forwardedParts.set(sessionID, byMessage)
    }
    let set = byMessage.get(messageID)
    if (!set) {
      set = new Set()
      byMessage.set(messageID, set)
    }
    set.add(ordinal)
    // 兜底读取的 part 也要补进 parts，最终答复重建才有原文
    if (text.trim()) {
      let partsByMessage = this.parts.get(sessionID)
      if (!partsByMessage) {
        partsByMessage = new Map()
        this.parts.set(sessionID, partsByMessage)
      }
      let parts = partsByMessage.get(messageID)
      if (!parts) {
        parts = new Map()
        partsByMessage.set(messageID, parts)
      }
      if (!parts.has(ordinal)) parts.set(ordinal, text)
    }
  }

  markFetched(sessionID: string, messageID: string, text: string): void {
    if (!messageID) return
    let set = this.fetched.get(sessionID)
    if (!set) {
      set = new Set()
      this.fetched.set(sessionID, set)
    }
    set.add(messageID)
    let byMessage = this.fetchedText.get(sessionID)
    if (!byMessage) {
      byMessage = new Map()
      this.fetchedText.set(sessionID, byMessage)
    }
    byMessage.set(messageID, text)
  }

  isPartForwarded(sessionID: string, messageID: string, ordinal: number): boolean {
    return this.forwardedParts.get(sessionID)?.get(messageID)?.has(ordinal) ?? false
  }

  isMessageFetched(sessionID: string, messageID: string): boolean {
    return this.fetched.get(sessionID)?.has(messageID) ?? false
  }

  hasTextEvents(sessionID: string, messageID: string): boolean {
    return this.sawText.get(sessionID)?.has(messageID) ?? false
  }

  hasForwardedParts(sessionID: string, messageID: string): boolean {
    return (this.forwardedParts.get(sessionID)?.get(messageID)?.size ?? 0) > 0
  }

  isEnded(sessionID: string, messageID: string): boolean {
    return this.ended.get(sessionID)?.has(messageID) ?? false
  }

  finishOf(sessionID: string, messageID: string): string {
    return this.ended.get(sessionID)?.get(messageID) ?? ""
  }

  pendingParts(sessionID: string): PendingPart[] {
    const byMessage = this.parts.get(sessionID)
    if (!byMessage) return []
    const out: PendingPart[] = []
    for (const [messageID, parts] of byMessage) {
      for (const [ordinal, text] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
        if (!this.isPartForwarded(sessionID, messageID, ordinal)) out.push({ messageID, ordinal, text })
      }
    }
    return out
  }

  hasForwarded(sessionID: string): boolean {
    for (const set of this.forwardedParts.get(sessionID)?.values() ?? []) {
      if (set.size > 0) return true
    }
    return (this.fetched.get(sessionID)?.size ?? 0) > 0
  }

  /** 最终答复是否已经由实时 part 转发过。按消息重建 part 文本后比较。 */
  wasFinalForwarded(sessionID: string, text: string): boolean {
    const normalized = normalizeStepText(text)
    const finalMessageID = this.final.get(sessionID)
    if (finalMessageID) {
      const fetched = this.fetchedText.get(sessionID)?.get(finalMessageID)
      const said = fetched ?? this.forwardedTextOf(sessionID, finalMessageID)
      if (normalized.length > 0) return normalizeStepText(said) === normalized
      // 最终 step 只有文件/空文本：只要这个 step 有 part 发出去过，就算已交付
      return this.hasForwardedParts(sessionID, finalMessageID) || fetched !== undefined
    }
    if (normalized.length === 0) return false
    for (const messageID of this.forwardedParts.get(sessionID)?.keys() ?? []) {
      if (normalizeStepText(this.forwardedTextOf(sessionID, messageID)) === normalized) return true
    }
    return false
  }

  private forwardedTextOf(sessionID: string, messageID: string): string {
    const set = this.forwardedParts.get(sessionID)?.get(messageID)
    const parts = this.parts.get(sessionID)?.get(messageID)
    if (!set || !parts || set.size === 0) return ""
    return [...set]
      .sort((a, b) => a - b)
      .map((ordinal) => parts.get(ordinal) ?? "")
      .join("\n")
      .trim()
  }
}

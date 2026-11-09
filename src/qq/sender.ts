// @input:  ./api (sendC2CMessage, sendGroupMessage), ./types (MessageContext)
// @output: replyToQQ, formatForQQ, formatForQQMarkdown, splitMessage
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复)
//
// QQ 机器人自定义 Markdown（msg_type=2）已对单聊/群聊全量开放，无需模板。
// QQ markdown 能完整渲染标准语法: 表格、行内代码/代码块、加粗、标题、列表、链接、引用等。
// 因此主路径直接透传 AI 的 markdown 原文，交给 QQ 渲染；仅在发送失败时回退纯文本。
import { sendC2CMessage, sendGroupMessage, getNextMsgSeq, type MessageResponse } from "./api.js"
import type { MessageContext } from "./types.js"

// Markdown 主路径: QQ 原生渲染标准 markdown（含表格/代码），故基本透传，仅做首尾清理。
export function formatForQQMarkdown(text: string): string {
  return text.trim()
}

// 纯文本兜底: 去除所有 markdown 标记（当 markdown 发送失败时使用）
export function formatForQQ(text: string): string {
  const codeBlocks: string[] = []

  // 保护围栏代码块，用占位符替换；同时去掉 ```lang 语言标签
  let processed = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ""))
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // 处理表格: 转成 "表头 | 表头" 与 "值 | 值" 的纯文本，去掉分隔行 |---|---|
  processed = convertTables(processed)

  // 去除 markdown 标记
  processed = processed
    .replace(/`([^`]+)`/g, "$1")                 // `inline code` -> inline code
    .replace(/\*\*(.+?)\*\*/g, "$1")             // **bold** -> bold
    .replace(/\*(.+?)\*/g, "$1")                 // *italic* -> italic
    .replace(/__(.+?)__/g, "$1")                 // __underline__ -> underline
    .replace(/~~(.+?)~~/g, "$1")                 // ~~strike~~ -> strike
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")  // [text](url) -> text (url)
    .replace(/^#{1,6}\s+/gm, "")                 // ### heading -> heading
    .replace(/^>\s?/gm, "")                      // > quote -> quote
    .replace(/^\s*[-*+]\s+/gm, "• ")             // - item -> • item
    .replace(/^---$/gm, "----------")            // --- -> ----------

  // 还原代码块
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i])
  }

  return processed.trim()
}

// 把 markdown 表格转成 QQ 可读的纯文本（列用 " | " 连接，丢弃 |---| 分隔行）
function convertTables(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // 表格行: 以 | 开头结尾，且含分隔符
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
        rows.push(cells)
        i++
      }
      // 丢弃分隔行（形如 |---|:---:|）
      const realRows = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)))
      for (const r of realRows) {
        out.push(r.join(" | "))
      }
      out.push("") // 表格后空一行
      continue
    }
    out.push(line)
    i++
  }

  return out.join("\n")
}

// 官方未公布消息字节上限（仅 40054007/40054018 错误码）；不预设 60232 这类经验值。
// 先整条发送，超长时由 API 错误触发自适应二分拆分。
const MARKDOWN_MAX_BYTES = Number.POSITIVE_INFINITY
const PLAIN_MAX_BYTES = Number.POSITIVE_INFINITY
const encoder = new TextEncoder()

function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

// —— 结构化分条（2026-10-29 固化：设计吸收自 dsh-qqbot transport/chunker.ts，P0）——
// dsh 语义：GFM 表格聚成原子单元不跨片拆散 + 按行边界打包；
// 我方在 dsh 之上补两件事：① 字节预算（QQ 按 UTF-8 字节限长，dsh 按字符数会
// 踩中文 3 字节坑）② 围栏修补——在代码块中间切断时给前片补闭合 ```、后片补
// 开围栏（带语言），保证每片 markdown 独立可渲染。
const GFM_TABLE_LINE = /^\s*\|.*\|\s*$/
const CODE_FENCE_OPEN = /^\s*```(\S*)/

interface LineUnit {
  /** 行原文（含结尾 \n，全文末行除外） */
  text: string
  bytes: number
  /** 本行是围栏行时记录语言，否则 null */
  fenceLang: string | null
}

function toLineUnits(text: string): LineUnit[] {
  const rawLines = text.split("\n")
  const units: LineUnit[] = []
  let tableBuf: string[] = []
  const flushTable = (isLast: boolean): void => {
    if (tableBuf.length === 0) return
    const body = tableBuf.join("\n") + (isLast ? "" : "\n")
    units.push({ text: body, bytes: utf8Bytes(body), fenceLang: null })
    tableBuf = []
  }

  rawLines.forEach((line, idx) => {
    const isLast = idx === rawLines.length - 1
    if (GFM_TABLE_LINE.test(line)) {
      tableBuf.push(line)
      if (isLast) flushTable(true)
      return
    }
    flushTable(isLast)
    const fence = CODE_FENCE_OPEN.exec(line)
    const body = line + (isLast ? "" : "\n")
    units.push({ text: body, bytes: utf8Bytes(body), fenceLang: fence ? fence[1] : null })
  })
  return units
}

// 超大单元（巨型表格行/无换行长行）的字节级兜底切分：
// 优先段落(\n\n)、其次换行(\n)、最后码点边界硬切（不切多字节字符/代理对）。
function splitOversizeUnit(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  const total = text.length
  let start = 0

  while (start < total) {
    if (utf8Bytes(text.slice(start)) <= maxBytes) {
      chunks.push(text.slice(start))
      break
    }
    let bytes = 0
    let i = start
    let lastParaBreak = -1
    let lastLineBreak = -1
    let hardCut = -1

    while (i < total) {
      const cp = text.codePointAt(i)!
      const cpStr = String.fromCodePoint(cp)
      const cpBytes = utf8Bytes(cpStr)
      if (bytes + cpBytes > maxBytes) break
      bytes += cpBytes
      i += cpStr.length
      hardCut = i
      if (cp === 0x0a) {
        if (i - 2 >= start && text[i - 2] === "\n") lastParaBreak = i
        else lastLineBreak = i
      }
    }

    let splitAt = lastParaBreak > start ? lastParaBreak : lastLineBreak > start ? lastLineBreak : hardCut
    if (splitAt <= start) splitAt = hardCut
    if (splitAt <= start) splitAt = Math.min(start + 1, total)

    const chunk = text.slice(start, splitAt)
    if (chunk.trim()) chunks.push(chunk)
    start = splitAt
  }
  return chunks
}

export function splitMessage(text: string, maxBytes: number = MARKDOWN_MAX_BYTES): string[] {
  if (utf8Bytes(text) <= maxBytes) return [text]

  const units = toLineUnits(text)
  const chunks: string[] = []
  let cur = ""
  let curBytes = 0
  let prefix = "" // 围栏内切断时，下一片需补的开围栏（带语言）
  let openLang: string | null = null // 原文全局围栏状态（跨片跟踪）

  const flush = (): void => {
    const body = cur
    cur = ""
    curBytes = 0
    const inside = openLang !== null
    const out = prefix + body + (inside ? (body.endsWith("\n") ? "```\n" : "\n```\n") : "")
    prefix = inside ? `\`\`\`${openLang}\n` : ""
    if (out.trim()) chunks.push(out)
  }

  for (const u of units) {
    if (u.bytes > maxBytes) {
      // 超大单元：先封当前片，再字节级兜底切（围栏行本身不可能超大，不参与围栏语义）
      if (cur) flush()
      const parts = splitOversizeUnit(u.text, maxBytes)
      for (let k = 0; k < parts.length - 1; k++) chunks.push(parts[k])
      cur = parts[parts.length - 1] ?? ""
      curBytes = utf8Bytes(cur)
      continue
    }
    const prefixBytes = prefix ? utf8Bytes(prefix) : 0
    if (cur && curBytes + prefixBytes + u.bytes > maxBytes) {
      flush()
    }
    cur += u.text
    curBytes += u.bytes
    if (u.fenceLang !== null) {
      openLang = openLang === null ? u.fenceLang : null
    }
  }
  flush()

  return chunks.length > 0 ? chunks : [text]
}

// J-轻（2026-10-30，伪流式固化）：多片错峰发送的延迟计划——片间各睡 staggerMs，
// 单片无延迟。纯函数导出供测试；新发送路径不再人为错峰，保留导出兼容旧测试。
export function staggerDelays(chunkCount: number, staggerMs: number): number[] {
  if (chunkCount <= 1 || staggerMs <= 0) return []
  return Array.from({ length: chunkCount - 1 }, () => staggerMs)
}

class MessageTooLongError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MessageTooLongError"
  }
}

function isLengthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /40054007|40054018|消息长度超限|消息过长/.test(msg)
}

// 发送单个分片: 先尝试 markdown，失败则回退纯文本。返回服务端消息回执（含 id，
// 供上下文缓存登记——引用解析用）。超长由 API 错误码触发自适应拆分。
async function sendChunk(
  accessToken: string,
  ctx: MessageContext,
  mdText: string,
  plainText: string,
): Promise<MessageResponse | null> {
  const isGroup = ctx.type === "group" && ctx.groupId

  try {
    const seq = getNextMsgSeq(ctx.msgId)
    if (isGroup) {
      return await sendGroupMessage(accessToken, ctx.groupId!, mdText, ctx.msgId, seq, true)
    } else {
      return await sendC2CMessage(accessToken, ctx.userId, mdText, ctx.msgId, seq, true)
    }
  } catch (error) {
    if (!isLengthError(error)) {
      // markdown 发送失败（如语法不被接受/内容违规）-> 回退纯文本
      console.error("[qq-sender] markdown 发送失败，回退纯文本:", error)
    }
  }

  try {
    const seq = getNextMsgSeq(ctx.msgId)
    if (isGroup) {
      return await sendGroupMessage(accessToken, ctx.groupId!, plainText, ctx.msgId, seq, false)
    } else {
      return await sendC2CMessage(accessToken, ctx.userId, plainText, ctx.msgId, seq, false)
    }
  } catch (error) {
    if (isLengthError(error)) throw new MessageTooLongError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** 超长消息二分：优先在换行处切，切不动才按字符中点切。 */
function splitInHalf(text: string): [string, string] | null {
  if (text.length < 2) return null
  const mid = Math.floor(text.length / 2)
  let idx = text.lastIndexOf("\n", mid)
  if (idx <= 0) idx = text.indexOf("\n", mid)
  if (idx <= 0 || idx >= text.length) idx = mid
  const left = text.slice(0, idx)
  const right = text.slice(idx)
  if (!left || !right) return null
  return [left, right]
}

export interface ReplyToQQOptions {
  /** 保留参数以兼容调用方；不再人为加片间延迟。 */
  staggerMs?: number
}

export interface ReplyResult {
  chunks: number
  /** 服务端回执的消息 id（引用解析缓存登记用） */
  ids: string[]
}

export async function replyToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  options?: ReplyToQQOptions,
): Promise<ReplyResult> {
  void options
  const mdFormatted = formatForQQMarkdown(text)
  const plainFormatted = formatForQQ(text)
  const mdChunks = splitMessage(mdFormatted, MARKDOWN_MAX_BYTES)
  const plainChunks = splitMessage(plainFormatted, PLAIN_MAX_BYTES)
  const ids: string[] = []
  let chunks = 0

  async function sendPair(md: string, plain: string): Promise<void> {
    try {
      const res = await sendChunk(accessToken, ctx, md, plain)
      chunks += 1
      if (res?.id) ids.push(res.id)
    } catch (error) {
      if (!(error instanceof MessageTooLongError)) throw error
      const mdParts = splitInHalf(md)
      const plainParts = splitInHalf(plain)
      if (!mdParts || !plainParts) throw error
      await sendPair(mdParts[0], plainParts[0])
      await sendPair(mdParts[1], plainParts[1])
    }
  }

  for (let i = 0; i < mdChunks.length; i++) {
    const plainChunk = plainChunks[i] ?? plainChunks[plainChunks.length - 1] ?? mdChunks[i]
    await sendPair(mdChunks[i], plainChunk)
  }
  return { chunks, ids }
}

// @input:  ./api (getAccessToken), ./types (MessageAttachment), node:fs/os/path
// @output: extForImageMime, isAllowedDownloadHost, MAX_IMAGE_BYTES, MAX_FILE_BYTES,
//          imageDir, fileDir, downloadQQAttachment, prepareQQAttachments, groupOutcomes,
//          augmentPromptWithAttachments, purgeOldQQImages
// @pos:    qq层 - QQ 图片/文件下载落盘 + prompt 文本/附件合成（原生附件接入 2026-10-14）
//
// QQ 图片消息到网关只有 URL（MessageAttachment.url）；本模块下载落盘成文件，
// 再转成 prompt body 的 files（{uri, name}，v2 PromptInput schema 内字段）。
// 纯文本桥时代图片被静默丢弃——现在任何失败（下载不通/类型不支持）都转成
// 可见的文字备注，绝不静默。

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { MessageAttachment } from "./types.js"

export interface PromptFile {
  uri: string
  name?: string
}

export interface PreparedAttachments {
  files: PromptFile[]
  notes: string[]
}

/** 下载结果（纯数据，便于单测分组逻辑） */
export type AttachmentOutcome =
  | { path: string; name: string; kind?: "file" }
  | { failed: string }
  | { unsupported: string }
  /** 语音消息：QQ 内置 ASR 免费给 asr_refer_text，零下载零 STT 调用直接转文字（生态观察缺口 2） */
  | { voice: string }

export function extForImageMime(mime: string): string | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim()
  if (m === "image/jpeg") return "jpg"
  for (const x of ["png", "gif", "webp", "bmp"]) if (m === `image/${x}`) return x
  return null
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 普通文件上限（QQ 文件消息下载落盘；比图片宽松，仍做内存熔断） */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
const ALLOWED_HOST_SUFFIXES = [".qpic.cn", ".qq.com", ".qq.com.cn"]

/** 下载域白名单（R2-P1-2）：只信 QQ 自家 CDN 且必须 https——在 fetch 之前
 *  拦截，同时断"access_token 出站"与"SSRF 打内网"两条链；精确匹配或以
 *  . 结尾匹配，防 qq.com.evil.com 后缀伪造。 */
export function isAllowedDownloadHost(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:") return false
    const host = u.hostname.toLowerCase()
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))
  } catch {
    return false
  }
}

export function imageDir(): string {
  return join(tmpdir(), "opencode", "qq-images")
}

/** 普通文件落盘目录：Windows 直接进 Downloads；其它平台回退到 ~/.openqq/files。 */
export function fileDir(): string {
  if (process.platform === "win32") return join(homedir(), "Downloads")
  return join(homedir(), ".openqq", "files")
}

/** 清洗 QQ 提供的文件名：去路径、去 Windows 非法字符、去开头点，保留中文。 */
function sanitizeFileName(name: string | undefined): string {
  const base = (String(name || "").split(/[\\/]/).pop() ?? "").trim()
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim()
  return cleaned || "qq-file.bin"
}

/** 同名文件不覆盖：依次尝试 name-1.ext、name-2.ext…… */
function uniqueFilePath(dir: string, name: string): string {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let full = join(dir, name)
  for (let i = 1; i < 1000; i += 1) {
    try {
      statSync(full)
    } catch {
      return full
    }
    full = join(dir, `${stem}-${i}${ext}`)
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

async function fetchWithTimeout(url: string, ms: number, auth?: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: auth ? { Authorization: `QQBot ${auth}` } : {},
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载 QQ 图片附件到本地。非图片类型返回 unsupported；下载失败返回 failed
 * （脱敏短语，原始 URL/错误只进本机日志）。fetch 前过域白名单（R2-P1-2）；
 * 401/403 时带 access_token 重试一次（此时目标必为 QQ 自家域，token 不出站）；
 * 10MB 流式上限，超限 cancel 熔断。
 */
export async function downloadQQAttachment(
  att: MessageAttachment,
  getAuth?: () => Promise<string>,
): Promise<AttachmentOutcome> {
  // 语音消息：优先用 QQ 内置 ASR 的 asr_refer_text（免费、零下载）；无转写才按附件流程走
  const ctype = (att.content_type || "").toLowerCase()
  // 2026-11-04 修复（UAT 实测 DEF-qqbot-20261104-1）：QQ 语音附件 content_type
  // 实测为 "voice"（非 audio/*），原 audio/ 前缀判断漏接 → 语音被误判为
  //「暂不支持的附件类型」。asr 转写存在即优先消费，与具体 content_type 解耦。
  const isVoice = ctype.startsWith("audio/") || ctype === "voice" || ctype === "amr" || ctype.endsWith("/amr")
  if (isVoice && att.asr_refer_text?.trim()) {
    return { voice: att.asr_refer_text.trim() }
  }
  const ext = extForImageMime(att.content_type || "")
  // 普通文件（2026-11-10）：QQ 文件消息 content_type 为 "file"；部分场景只有 filename。
  // 仍走同一套域白名单/鉴权重试/流式大小熔断，只是落盘目录和上限不同。
  const isFile = !ext && !!att.url && (ctype === "file" || ctype === "application/octet-stream" || !!att.filename)
  if (!ext && !isFile) return { unsupported: att.content_type || att.filename || "未知类型" }
  if (!isAllowedDownloadHost(att.url)) return { failed: "下载域不在白名单" }
  const maxBytes = ext ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
  const limitText = `${Math.floor(maxBytes / 1024 / 1024)}MB`
  try {
    const dir = ext ? imageDir() : fileDir()
    mkdirSync(dir, { recursive: true })
    const originalName = ext ? "" : sanitizeFileName(att.filename)
    const name = ext ? `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}` : originalName
    const full = ext ? join(dir, name) : uniqueFilePath(dir, name)
    const timeoutMs = ext ? 15000 : 30000
    let res = await fetchWithTimeout(att.url, timeoutMs)
    if ((res.status === 401 || res.status === 403) && getAuth) {
      try {
        const tok = await getAuth()
        res = await fetchWithTimeout(att.url, timeoutMs, tok)
      } catch {
        /* 鉴权兜底失败：保持原状态，走下方 !res.ok 归 failed */
      }
    }
    if (!res.ok) {
      console.log("[media] 下载失败:", res.status, att.url) // 原始 URL 只进本机日志（B7 校准）
      return { failed: `HTTP ${res.status}` }
    }
    // 大小上限——Content-Length 预检 + 流式逐块计数熔断
    //（无 Content-Length 的分块响应同样有界；超限即 cancel，内存不涨）
    const len = Number(res.headers.get("content-length") || 0)
    if (len > maxBytes) return { failed: `超过${limitText}` }
    const reader = res.body?.getReader()
    if (!reader) return { failed: "无响应体" }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { failed: `超过${limitText}` }
      }
      chunks.push(value)
    }
    if (total === 0) return { failed: "空响应" }
    writeFileSync(full, Buffer.concat(chunks))
    if (ext) return { path: full, name }
    console.log(`[media] 文件已保存: ${full} (${total} bytes)`)
    return { path: full, name: originalName, kind: "file" }
  } catch (e) {
    // 原始错误只进本机日志；回给用户的备注是脱敏短语（R2-P3）
    console.log("[media] 下载失败:", att.url, e instanceof Error ? e.message : e)
    return { failed: "网络错误或超时" }
  }
}

/** 下载一组附件并汇总（bridge 的唯一入口） */
export async function prepareQQAttachments(
  attachments: MessageAttachment[] | undefined,
  getAuth?: () => Promise<string>,
): Promise<PreparedAttachments> {
  if (!attachments?.length) return { files: [], notes: [] }
  const outcomes: AttachmentOutcome[] = []
  for (const att of attachments) outcomes.push(await downloadQQAttachment(att, getAuth))
  return groupOutcomes(outcomes)
}

/** 下载结果分组（纯函数，供单测） */
export function groupOutcomes(outcomes: AttachmentOutcome[]): PreparedAttachments {
  const files: PromptFile[] = []
  const notes: string[] = []
  for (const o of outcomes) {
    if ("path" in o) {
      // 普通文件不喂 data: URL（会被当图片），只把本地路径写进备注，AI 用读取工具打开。
      if (o.kind === "file") {
        notes.push(`（用户通过 QQ 发来文件「${o.name}」，已保存到本地路径：${o.path}，可直接读取）`)
        continue
      }
      // 桌面 TUI 预览实证通道：≤2MB 的图片用 data: URL（opencode 对 data: 内嵌预览友好）；
      // 大图/非图保留 file:// 路径（避免 base64 膨胀）。
      const dataUrl = tryImageDataUrl(o.path, 2 * 1024 * 1024)
      files.push(dataUrl ? { uri: dataUrl, name: o.name } : { uri: `file:///${o.path.replace(/\\/g, "/")}`, name: o.name })
    } else if ("voice" in o) {
      notes.push(`（语音转写：${o.voice}）`)
    } else if ("failed" in o) {
      notes.push(`（附件下载失败：${o.failed}）`)
    } else {
      notes.push(`（暂不支持的附件类型：${o.unsupported}）`)
    }
  }
  return { files, notes }
}

// 小图转 data: URL（失败回退 null 走 file://），仅用于桌面预览友好化
function tryImageDataUrl(path: string, maxBytes: number): string | null {
  try {
    const st = statSync(path)
    if (st.size > maxBytes) return null
    const b = readFileSync(path)
    return `data:image/png;base64,${b.toString("base64")}`
  } catch {
    return null
  }
}

/**
 * 把附件合成进 prompt（纯函数，供单测）：
 * - 有文字：文字保留，失败/不支持备注附在其后
 * - 纯图（无文字）：占位文字，模型经 files 直接看到图
 * - 纯文件/纯失败（无文字）：备注即正文，QQ 端可见而不是静默
 */
export function augmentPromptWithAttachments(
  rawContent: string,
  prepared: PreparedAttachments,
): { text: string; files: PromptFile[] } {
  const base = rawContent.trim()
  const { files, notes } = prepared
  let text = base
  if (!text && files.length > 0) text = "（用户通过 QQ 发来了图片，未附文字）"
  if (!text && notes.length > 0) text = "（用户通过 QQ 发来了附件，未附文字）"
  if (notes.length > 0) text = text ? `${text}\n\n${notes.join("\n")}` : notes.join("\n")
  return { text, files }
}

/** 启动清理：删掉 7 天前的落盘图片（只在自己的子目录内操作） */
export function purgeOldQQImages(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  try {
    const dir = imageDir()
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      const full = join(dir, f)
      try {
        if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full)
      } catch {
        /* 单文件失败忽略 */
      }
    }
  } catch {
    /* 目录不存在等忽略 */
  }
}

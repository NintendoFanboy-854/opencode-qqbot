// @input:  ../opencode/client (FormInfo/FormField/FormOption), ../qq/types (MessageContext), ./form-journal
// @output: renderFormPrompt, parseFormAnswer, createFormBridge, FORM_PROMPT_TTL_MS
// @pos:    core - 表单桥接：QQ 同步、作答回传、跨重启恢复与服务端对账。
//
// MVP 边界：单交互字段完整支持（选择/多选/布尔/自由文本）；多字段表单提示回桌面。
// 所有服务端成功状态才允许清槽；点击 ACK、submitting 与取消失败均同步落盘，重启后可续交。
import type { FormInfo, OpencodeClient } from "../opencode/client.js"
import type { MessageContext } from "../qq/types.js"
import type { InlineKeyboard, KeyboardButton } from "../qq/api.js"
import { redactSecrets } from "../opencode/history.js"
import {
  createFormJournal,
  minimalFormContext,
  type FormJournal,
  type FormJournalEntry,
  type FormLifecycleState,
} from "./form-journal.js"

export const FORM_PROMPT_TTL_MS = 0 // 0=不自动取消；交给用户/OpenCode 侧决定
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const BUTTON_LABEL_MAX = 10
const BUTTONS_PER_ROW = 5
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

// 宽松字段视图：V2 字段类型可能扩展（external 等），运行时用宽类型读取可选属性，
// 未知类型走自由文本兜底而不是报错。
interface WhenCondition {
  key: string
  op: "eq" | "neq"
  value: unknown
}

interface FieldLike {
  key: string
  type: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  options?: Array<{ value: string; label: string; description?: string }>
  minimum?: number | string
  maximum?: number | string
  minItems?: number
  maxItems?: number
  format?: string
  minLength?: number
  maxLength?: number
  pattern?: string
  placeholder?: string
  default?: unknown
  custom?: boolean
  when?: WhenCondition[]
  url?: string
}

function whenMatches(when: WhenCondition[] | undefined, answers: Record<string, unknown>): boolean {
  if (!when?.length) return true
  return when.every((cond) => {
    const actual = answers[cond.key]
    const eq = Array.isArray(actual) ? actual.some((v) => v === cond.value) : actual === cond.value
    return cond.op === "eq" ? eq : !eq
  })
}

function fieldAt(form: FormInfo, index: number): FieldLike | undefined {
  const field = form.fields[index] as FieldLike | undefined
  if (!field || field.hidden) return undefined
  return field
}

/** 按 form.fields 顺序返回当前可见字段（hidden/when 过滤）。 */
export function visibleFields(form: FormInfo, answers: Record<string, unknown> = {}): Array<{ field: FieldLike; index: number }> {
  const out: Array<{ field: FieldLike; index: number }> = []
  form.fields.forEach((raw, index) => {
    const field = raw as FieldLike
    if (field.hidden || !whenMatches(field.when, answers)) return
    out.push({ field, index })
  })
  return out
}

function firstFieldIndex(form: FormInfo, answers: Record<string, unknown>, from = 0): number {
  for (let i = from; i < form.fields.length; i += 1) {
    const field = fieldAt(form, i)
    if (field && whenMatches(field.when, answers)) return i
  }
  return -1
}

function nextFieldIndex(form: FormInfo, answers: Record<string, unknown>, after: number): number {
  return firstFieldIndex(form, answers, after + 1)
}

// 找第一个可交互字段
export function primaryField(form: FormInfo): FieldLike | undefined {
  return visibleFields(form)[0]?.field
}

function formatDefault(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ")
  if (value === true) return "是"
  if (value === false) return "否"
  return String(value)
}

function fieldHint(field: FieldLike): string {
  if (field.type === "multiselect") return "点按钮多选，选完点「完成」；也可回复字母（多选用逗号）"
  if (field.type === "boolean") return "回复 是 / 否"
  if (field.type === "number" || field.type === "integer") {
    const min = typeof field.minimum === "number" ? `最小 ${field.minimum}` : ""
    const max = typeof field.maximum === "number" ? `最大 ${field.maximum}` : ""
    const range = [min, max].filter(Boolean).join("，")
    return range ? `请回复数字（${range}）` : "请回复数字"
  }
  if (field.type === "string" && field.options?.length) {
    return field.custom ? "回复字母/序号/选项文字，或直接输入自定义内容" : "回复字母/序号或选项文字"
  }
  const bits: string[] = []
  if (field.minLength !== undefined) bits.push(`至少 ${field.minLength} 字`)
  if (field.maxLength !== undefined) bits.push(`最多 ${field.maxLength} 字`)
  if (field.pattern) bits.push(`格式：${field.pattern}`)
  if (field.format) bits.push(`格式：${field.format}`)
  if (field.placeholder) bits.push(field.placeholder)
  return bits.length ? `请直接回复内容（${bits.join("，")}）` : "请直接回复内容"
}

/** 渲染单个字段为 QQ 文本（选项字母化 A/B/C/D；多选提示逗号分隔）。 */
export function renderFieldPrompt(
  form: FormInfo,
  field: FieldLike,
  position: number,
  total: number,
  selected?: string[],
): string {
  const lines = [`需要你的选择：${redactSecrets(form.title)}`]
  if (total > 1) lines.push(`（第 ${position}/${total} 题）`)
  if (field.title) lines.push(redactSecrets(field.title))
  if (field.description) lines.push(redactSecrets(field.description))
  if (field.type === "external") {
    if (field.url) lines.push(`外部表单：${field.url}`)
    lines.push("（点「打开外部表单」，完成后点「继续」）")
    return lines.join("\n")
  }
  if ((field.type === "multiselect" || field.type === "string") && field.options?.length) {
    field.options.slice(0, LETTERS.length).forEach((opt, i) => {
      lines.push(`${LETTERS[i]}) ${redactSecrets(opt.label)}`)
    })
    if (field.type === "multiselect" && selected?.length) {
      const labels = selected.map((value) => field.options?.find((opt) => opt.value === value)?.label ?? value)
      lines.push(`已选：${labels.join("、")}`)
    }
    lines.push(fieldHint(field))
  } else {
    lines.push(fieldHint(field))
  }
  if (field.default !== undefined) lines.push(`默认：${formatDefault(field.default)}`)
  if (!field.required) lines.push("（可选，回复「跳过」跳过）")
  lines.push("（无自动取消）")
  return lines.join("\n")
}

/** 兼容旧调用：单字段表单渲染。 */
export function renderFormPrompt(form: FormInfo): string {
  const field = primaryField(form)
  if (!field) return [`需要你的选择：${redactSecrets(form.title)}`, "（空表单，请回桌面处理）"].join("\n")
  const visible = visibleFields(form)
  return renderFieldPrompt(form, field, 1, Math.max(1, visible.length))
}

function tokenToOption(token: string, field: FieldLike): string | undefined {
  const t = token.trim()
  if (!t) return undefined
  const opts = field.options ?? []
  const letterIdx = LETTERS.indexOf(t.toUpperCase())
  if (letterIdx >= 0 && letterIdx < opts.length) return opts[letterIdx].value
  const num = Number(t)
  if (Number.isInteger(num) && num >= 1 && num <= opts.length) return opts[num - 1].value
  const hit = opts.find((o) => o.value === t || o.label === t)
  return hit?.value
}

export type ParsedFieldValue = { value: unknown } | { skip: true } | null

function numericBound(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value
  if (value === "Infinity") return Number.POSITIVE_INFINITY
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY
  return undefined
}

function validString(field: FieldLike, value: string): boolean {
  if (field.minLength !== undefined && value.length < field.minLength) return false
  if (field.maxLength !== undefined && value.length > field.maxLength) return false
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) return false
    } catch {
      /* 无效正则不阻断作答 */
    }
  }
  if (field.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return false
  if (field.format === "uri") {
    try { new URL(value) } catch { return false }
  }
  if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  if (field.format === "date-time" && Number.isNaN(Date.parse(value))) return false
  return true
}

/** 解析单个字段；无法解析返回 null，可选字段回复「跳过」返回 skip。 */
export function parseFieldValue(field: FieldLike, text: string): ParsedFieldValue {
  const raw = text.trim()
  if (!raw) {
    if (field.default !== undefined) return { value: field.default }
    return null
  }
  if (/^(跳过|skip|\/skip)$/i.test(raw)) {
    if (!field.required) return { skip: true }
    return null
  }
  if (field.type === "external") return { skip: true }
  if (field.type === "boolean") {
    if (/^(是|yes|y|true|1|对)$/i.test(raw)) return { value: true }
    if (/^(否|no|n|false|0|不对)$/i.test(raw)) return { value: false }
    return null
  }
  if (field.type === "number" || field.type === "integer") {
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    if (field.type === "integer" && !Number.isInteger(n)) return null
    const min = numericBound(field.minimum)
    const max = numericBound(field.maximum)
    if (min !== undefined && n < min) return null
    if (max !== undefined && n > max) return null
    return { value: field.type === "integer" ? Math.floor(n) : n }
  }
  if (field.type === "multiselect") {
    const tokens = raw.split(/[,，、\s]+/).filter(Boolean)
    if (tokens.length === 0) return null
    const values: string[] = []
    for (const token of tokens) {
      const v = tokenToOption(token, field) ?? (field.custom ? token : undefined)
      if (v === undefined) return null
      if (!values.includes(v)) values.push(v)
    }
    if (field.minItems !== undefined && values.length < field.minItems) return null
    if (field.maxItems !== undefined && values.length > field.maxItems) return null
    return { value: values }
  }
  if (field.type === "string" && field.options?.length) {
    const v = tokenToOption(raw, field)
    if (v !== undefined) return { value: v }
    if (field.custom && validString(field, raw)) return { value: raw }
    return null
  }
  if (field.type === "string") {
    return validString(field, raw) ? { value: raw } : null
  }
  // 未知类型兜底为文本
  return { value: raw }
}

/** 解析单字段表单回复；无法解析返回 null（调用方发提示）。 */
export function parseFormAnswer(form: FormInfo, text: string): Record<string, unknown> | null {
  const field = primaryField(form)
  if (!field) return null
  const parsed = parseFieldValue(field, text)
  if (!parsed) return null
  if ("skip" in parsed) return {}
  return { [field.key]: parsed.value }
}

export interface PendingForm extends FormJournalEntry {
  timer: ReturnType<typeof setTimeout> | null
  restored?: boolean
}

interface InternalPendingForm extends PendingForm {
  replying: boolean
  cancelling: boolean
}

// ── 表单按钮：兼容旧 t/form/f/k/v 协议，可选 i 为交互回调 id ──

export interface FormButtonData {
  t: "form"
  f: string
  k: string
  v: string
  /** true=该按钮是“跳过”而非选项值 */
  s?: boolean
  /** true=多选切换按钮 */
  m?: boolean
  /** true=多选完成按钮 */
  d?: boolean
  i?: string
}

export function encodeFormButton(data: FormButtonData): string {
  return JSON.stringify(data)
}

export function decodeFormButton(raw: string | undefined): FormButtonData | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<FormButtonData> & { interactionId?: unknown }
    if (
      parsed && typeof parsed === "object" && parsed.t === "form" &&
      typeof parsed.f === "string" && typeof parsed.k === "string" && typeof parsed.v === "string"
    ) {
      const interactionId = typeof parsed.i === "string"
        ? parsed.i
        : typeof parsed.interactionId === "string" ? parsed.interactionId : undefined
      return {
        t: "form",
        f: parsed.f,
        k: parsed.k,
        v: parsed.v,
        ...(parsed.s === true ? { s: true } : {}),
        ...(parsed.m === true ? { m: true } : {}),
        ...(parsed.d === true ? { d: true } : {}),
        ...(interactionId ? { i: interactionId } : {}),
      }
    }
  } catch {
    // fall through
  }
  return undefined
}

function clipButtonLabel(text: string): string {
  const s = text.trim()
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + "…" : s
}

/** 为单个字段生成按钮键盘：字符串选项/布尔/多选/外部链接；自由文本与数字走文字。 */
export function buildFieldKeyboard(
  form: FormInfo,
  field: FieldLike,
  _ownerOpenid: string,
  selected: string[] = [],
): InlineKeyboard | null {
  const buttons: KeyboardButton[] = []
  if (field.type === "string" && field.options?.length) {
    if (field.options.length > 24) return null
    for (const opt of field.options) {
      buttons.push({
        id: `form-${form.id}-${field.key}-${opt.value}`.slice(0, 64),
        render_data: { label: clipButtonLabel(opt.label), visited_label: clipButtonLabel(`已选 ${opt.label}`), style: 1 },
        action: {
          type: 1,
          permission: { type: 2 },
          data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: opt.value }),
        },
      })
    }
  } else if (field.type === "multiselect" && field.options?.length) {
    if (field.options.length > 22) return null
    for (const opt of field.options) {
      const picked = selected.includes(opt.value)
      buttons.push({
        id: `form-${form.id}-${field.key}-${opt.value}`.slice(0, 64),
        render_data: {
          label: clipButtonLabel(opt.label),
          visited_label: clipButtonLabel(picked ? `已选 ${opt.label}` : opt.label),
          style: picked ? 1 : 0,
        },
        action: {
          type: 1,
          permission: { type: 2 },
          data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: opt.value, m: true }),
        },
      })
    }
    buttons.push({
      id: `form-${form.id}-${field.key}-done`.slice(0, 64),
      render_data: { label: "完成", visited_label: "已提交", style: 1 },
      action: {
        type: 1,
        permission: { type: 2 },
        data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: "", d: true }),
      },
    })
  } else if (field.type === "boolean") {
    for (const [label, value] of [["是", "true"], ["否", "false"]] as const) {
      buttons.push({
        id: `form-${form.id}-${field.key}-${value}`.slice(0, 64),
        render_data: { label, visited_label: `已选 ${label}`, style: 1 },
        action: {
          type: 1,
          permission: { type: 2 },
          data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: value }),
        },
      })
    }
  } else if (field.type === "external" && field.url) {
    buttons.push({
      id: `form-${form.id}-${field.key}-open`.slice(0, 64),
      render_data: { label: "打开外部表单", visited_label: "打开外部表单", style: 1 },
      action: { type: 0, permission: { type: 2 }, data: field.url },
    })
    buttons.push({
      id: `form-${form.id}-${field.key}-continue`.slice(0, 64),
      render_data: { label: "继续", visited_label: "已继续", style: 0 },
      action: {
        type: 1,
        permission: { type: 2 },
        data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: "", s: true }),
      },
    })
  } else {
    return null
  }
  if (!field.required && field.type !== "external" && !buttons.some((button) => button.render_data.label === "跳过")) {
    buttons.push({
      id: `form-${form.id}-${field.key}-skip`.slice(0, 64),
      render_data: { label: "跳过", visited_label: "已跳过", style: 0 },
      action: {
        type: 1,
        permission: { type: 2 },
        data: encodeFormButton({ t: "form", f: form.id, k: field.key, v: "", s: true }),
      },
    })
  }
  const rows: Array<{ buttons: KeyboardButton[] }> = []
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push({ buttons: buttons.slice(i, i + BUTTONS_PER_ROW) })
  }
  return rows.length > 0 ? { content: { rows } } : null
}

/** 兼容旧调用：单字段表单键盘；多字段请用 buildFieldKeyboard。 */
export function buildFormKeyboard(form: FormInfo, ownerOpenid: string): InlineKeyboard | null {
  const visible = visibleFields(form)
  if (visible.length !== 1) return null
  return buildFieldKeyboard(form, visible[0].field, ownerOpenid)
}

export interface FormInteractionEvent {
  id?: string
  user_openid?: string
  group_openid?: string
  group_member_openid?: string
  data?: { resolved?: { button_id?: string; button_data?: string } }
}

export interface FormBridgeDeps {
  client: OpencodeClient
  sendReply: (ctx: MessageContext, text: string) => Promise<void>
  safeDeliver: (ctx: MessageContext, text: string) => Promise<void>
  sendFormCard?: (ctx: MessageContext, form: FormInfo, keyboard: InlineKeyboard, text: string, passive: boolean) => Promise<boolean>
  /** 测试/嵌入方可显式指定台账；生产默认 ~/.openqq/forms.json 或 QQ_FORM_JOURNAL_FILE。 */
  journalPath?: string
  journal?: FormJournal
  /** 以下时钟/TTL 参数供可控测试使用，生产无需传入。 */
  now?: () => number
  ttlMs?: number
}

export interface FormBridge {
  pushForm: (userId: string, ctx: MessageContext, form: FormInfo) => void
  tryResolveText: (userId: string, text: string) => boolean
  handleButton: (event: FormInteractionEvent) => boolean
  hasPending: (userId: string) => boolean
  getPending: (userId: string) => PendingForm | undefined
  /** 仅读本地磁盘，不访问网络；返回恢复记录涉及的 sessionID（含当前映射之外的会话）。 */
  restore: () => string[]
  /** 查询指定会话；列表失败 fail-closed 保留本地，成功才清理或续交。 */
  reconcile: (sessionID: string) => Promise<boolean>
  /** 等待所有已跟踪 reply/cancel/通知完成；超时返回 false。 */
  drainInteractions: (timeoutMs?: number) => Promise<boolean>
  /** 停止接受新交互并清 TTL 定时器；在途 Promise 仍可由 drainInteractions 等待。 */
  stopAccepting: () => void
}

export function createFormBridge(deps: FormBridgeDeps): FormBridge {
  const pending = new Map<string, InternalPendingForm>()
  const journal = deps.journal ?? createFormJournal(deps.journalPath)
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? FORM_PROMPT_TTL_MS
  const operations = new Set<Promise<unknown>>()
  let accepting = true

  function track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => operations.delete(tracked))
    operations.add(tracked)
    return tracked
  }

  function deliver(ctx: MessageContext, text: string): Promise<void> {
    return track(deps.safeDeliver(ctx, text).catch((error) => {
      console.error("[form-bridge] 回执投递失败:", error instanceof Error ? error.message : error)
    }))
  }

  function journalSnapshot(entry: InternalPendingForm): FormJournalEntry {
    return {
      form: entry.form,
      ctx: minimalFormContext(entry.ctx),
      userId: entry.userId,
      createdAt: entry.createdAt,
      state: entry.state,
      ...(entry.answer ? { answer: entry.answer } : {}),
      ...(entry.answers ? { answers: entry.answers } : {}),
      ...(typeof entry.fieldIndex === "number" ? { fieldIndex: entry.fieldIndex } : {}),
      ...(entry.display !== undefined ? { display: entry.display } : {}),
      ...(entry.interactionId ? { interactionId: entry.interactionId } : {}),
      updatedAt: entry.updatedAt,
    }
  }

  function transition(entry: InternalPendingForm, state: FormLifecycleState): void {
    const previous = entry.state
    const previousUpdatedAt = entry.updatedAt
    entry.state = state
    entry.updatedAt = now()
    try {
      journal.put(journalSnapshot(entry))
    } catch (error) {
      entry.state = previous
      entry.updatedAt = previousUpdatedAt
      throw error
    }
  }

  function clearEntry(userId: string, entry: InternalPendingForm): boolean {
    if (pending.get(userId) !== entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    pending.delete(userId)
    try {
      journal.remove(userId, entry.form.id)
    } catch (error) {
      // 服务端已成功时才进入这里；残留账会由下次成功 reconcile 清理。
      console.error("[form-bridge] 清理表单台账失败:", error instanceof Error ? error.message : error)
    }
    return true
  }

  function isCurrent(userId: string, entry: InternalPendingForm): boolean {
    return pending.get(userId) === entry
  }

  function persist(entry: InternalPendingForm): void {
    try {
      entry.updatedAt = now()
      journal.put(journalSnapshot(entry))
    } catch (error) {
      console.error("[form-bridge] 多字段进度落盘失败:", error instanceof Error ? error.message : error)
    }
  }

  function currentFieldOf(entry: InternalPendingForm): { field: FieldLike; index: number } | undefined {
    const answers = entry.answers ?? {}
    let index = entry.fieldIndex
    if (index === undefined) index = firstFieldIndex(entry.form, answers)
    while (index >= 0) {
      const field = fieldAt(entry.form, index)
      if (field && whenMatches(field.when, answers)) {
        entry.fieldIndex = index
        return { field, index }
      }
      index = firstFieldIndex(entry.form, answers, index + 1)
    }
    entry.fieldIndex = undefined
    return undefined
  }

  function fieldProgress(entry: InternalPendingForm, index: number): { position: number; total: number } {
    const all = visibleFields(entry.form, entry.answers ?? {})
    const pos = all.findIndex((item) => item.index === index)
    return { position: pos >= 0 ? pos + 1 : 1, total: Math.max(1, all.length) }
  }

  async function sendCurrentField(entry: InternalPendingForm): Promise<void> {
    const current = currentFieldOf(entry)
    if (!current) {
      submitForm(entry)
      return
    }
    const { field, index } = current
    const { position, total } = fieldProgress(entry, index)
    const selected = Array.isArray(entry.answers?.[field.key]) ? (entry.answers?.[field.key] as string[]) : []
    const text = renderFieldPrompt(entry.form, field, position, total, selected)
    const keyboard = buildFieldKeyboard(entry.form, field, entry.userId, selected)
    if (keyboard && deps.sendFormCard) {
      const passive = position === 1
      const sent = await deps.sendFormCard(entry.ctx, entry.form, keyboard, text, passive).catch(() => false)
      if (sent) return
    }
    await deps.sendReply(entry.ctx, text).catch((error) => {
      console.error("[form-bridge] 字段提示发送失败:", error instanceof Error ? error.message : error)
    })
    if (field.type === "external") await advance(entry, field, { skip: true })
  }

  async function advance(entry: InternalPendingForm, field: FieldLike, parsed: ParsedFieldValue): Promise<void> {
    if (!parsed) return
    const answers = { ...(entry.answers ?? {}) }
    if ("skip" in parsed) {
      if (field.required && field.type !== "external") return
      delete answers[field.key]
    } else {
      answers[field.key] = parsed.value
    }
    // when 条件变化后，已不可见的字段答案不提交给服务端。
    const visibleKeys = new Set(visibleFields(entry.form, answers).map((item) => item.field.key))
    for (const key of Object.keys(answers)) {
      if (!visibleKeys.has(key)) delete answers[key]
    }
    entry.answers = answers
    const currentIndex = entry.fieldIndex ?? firstFieldIndex(entry.form, answers)
    const next = nextFieldIndex(entry.form, answers, currentIndex)
    entry.fieldIndex = next >= 0 ? next : undefined
    entry.answer = undefined
    entry.display = undefined
    persist(entry)
    if (next < 0) {
      submitForm(entry)
      return
    }
    await sendCurrentField(entry)
  }

  function submitForm(entry: InternalPendingForm): void {
    const answer = entry.answers ?? {}
    const display = Object.entries(answer)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
      .join("; ")
    entry.answer = answer
    entry.display = display || "表单已提交"
    entry.fieldIndex = undefined
    submit(entry.userId, entry, answer, entry.display, entry.interactionId)
  }

  function submit(userId: string, entry: InternalPendingForm, answer: Record<string, unknown>, display: string, interactionId?: string): void {
    if (!isCurrent(userId, entry) || entry.replying || entry.cancelling) return
    entry.answer = answer
    entry.display = display
    if (interactionId) entry.interactionId = interactionId
    entry.replying = true
    try {
      // 先同步落 submitting，再发起网络请求；崩溃后 reconcile 可续交同一答案。
      transition(entry, "submitting")
    } catch (error) {
      entry.replying = false
      const msg = error instanceof Error ? error.message : String(error)
      void deliver(entry.ctx, `警告：无法保存提交状态，尚未向服务端作答：${msg}；请回桌面处理`)
      return
    }

    const operation = (async () => {
      try {
        await deps.client.form.reply({
          path: { sessionID: entry.form.sessionID, formID: entry.form.id },
          body: { answer },
        })
      } catch (error) {
        entry.replying = false
        const msg = error instanceof Error ? error.message : String(error)
        if (/AlreadySettled|already|OpenCode API 404/i.test(msg)) {
          // 桌面端先答/先取消是终态；只有明确的服务端冲突才清理。
          if (isCurrent(userId, entry)) clearEntry(userId, entry)
          await deliver(entry.ctx, "该选择已在桌面端处理或取消，QQ 卡片已失效；若 AI 再次询问你会立即收到新卡片，也可回桌面处理")
        } else {
          // submitting + answer 保留在内存和磁盘，可手动重试或由 reconcile 续交。
          await deliver(entry.ctx, `警告：提交失败，选择已保留、可在重启后续交：${msg.length > 120 ? `${msg.slice(0, 120)}…` : msg}`)
        }
        return
      }

      entry.replying = false
      if (isCurrent(userId, entry)) {
        try {
          transition(entry, "replied")
        } catch (error) {
          console.error("[form-bridge] replied 状态落盘失败:", error instanceof Error ? error.message : error)
        }
        clearEntry(userId, entry)
      }
      console.log(`[form-bridge] 表单已作答 user=${userId.slice(0, 8)}… form=${entry.form.id} answer=${display}`)
    })().catch((error) => {
      entry.replying = false
      console.error("[form-bridge] 提交流程异常:", error instanceof Error ? error.message : error)
    })
    void track(operation)
  }

  async function expireEntry(userId: string, entry: InternalPendingForm): Promise<void> {
    if (!isCurrent(userId, entry) || entry.replying || entry.cancelling || entry.state === "expired" && entry.cancelling) return
    entry.cancelling = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    try {
      transition(entry, "expired")
    } catch (error) {
      entry.cancelling = false
      await deliver(entry.ctx, `警告：选择已到期，但取消状态无法落盘；请回桌面处理：${error instanceof Error ? error.message : error}`)
      return
    }
    try {
      await deps.client.form.cancel({ path: { sessionID: entry.form.sessionID, formID: entry.form.id } })
    } catch (error) {
      entry.cancelling = false
      const msg = error instanceof Error ? error.message : String(error)
      await deliver(entry.ctx, `警告：选择请求已到期，但服务端取消失败（${msg.length > 120 ? `${msg.slice(0, 120)}…` : msg}）；本地已保留恢复记录，请回桌面确认`)
      return
    }
    entry.cancelling = false
    if (isCurrent(userId, entry)) {
      try {
        transition(entry, "cancelled")
      } catch (error) {
        console.error("[form-bridge] cancelled 状态落盘失败:", error instanceof Error ? error.message : error)
      }
      clearEntry(userId, entry)
    }
    await deliver(entry.ctx, "提醒：选择请求已过期，服务端已确认取消；若 AI 再次询问你会立即收到新卡片，也可回桌面处理")
  }

  function scheduleExpiry(userId: string, entry: InternalPendingForm): void {
    if (!accepting || ttlMs <= 0) return
    const remaining = Math.max(0, entry.createdAt + ttlMs - now())
    entry.timer = setTimeout(() => {
      void track(expireEntry(userId, entry))
    }, remaining)
    entry.timer.unref?.()
  }

  function restore(): string[] {
    const sessions = new Set<string>()
    for (const saved of journal.load()) {
      sessions.add(saved.form.sessionID)
      if (saved.state === "replied" || saved.state === "cancelled") {
        try { journal.remove(saved.userId, saved.form.id) } catch { /* 下次启动再清理 */ }
        continue
      }
      const entry: InternalPendingForm = {
        ...saved,
        ctx: minimalFormContext({ ...saved.ctx, userId: saved.userId }),
        timer: null,
        restored: true,
        replying: false,
        cancelling: false,
      }
      const previous = pending.get(saved.userId)
      if (previous && previous.updatedAt > entry.updatedAt) continue
      if (previous?.timer) clearTimeout(previous.timer)
      pending.set(saved.userId, entry)
      scheduleExpiry(saved.userId, entry)
      if (entry.state === "pending" && entry.answers !== undefined) {
        void track(sendCurrentField(entry))
      }
      console.log(`[form-bridge] 恢复本地表单 user=${saved.userId.slice(0, 8)}… form=${saved.form.id} state=${saved.state}`)
    }
    return [...sessions]
  }

  async function reconcile(sessionID: string): Promise<boolean> {
    let forms: FormInfo[]
    try {
      forms = (await deps.client.form.list({ sessionID })).data ?? []
    } catch (error) {
      // fail-closed：列表不可信时绝不清槽，也不把未确认的服务端状态告知用户。
      console.error(`[form-bridge] 会话表单对账失败 session=${sessionID}:`, error instanceof Error ? error.message : error)
      return false
    }

    const candidates = [...pending.entries()].filter(([, entry]) => entry.form.sessionID === sessionID)
    for (const [userId, entry] of candidates) {
      if (!isCurrent(userId, entry)) continue
      const server = forms.find((form) => form.id === entry.form.id) as (FormInfo & { state?: { status?: string } | string }) | undefined
      const serverStatus = typeof server?.state === "string" ? server.state : server?.state?.status
      const serverPending = server !== undefined && (!serverStatus || serverStatus === "pending")
      if (!serverPending) {
        clearEntry(userId, entry)
        await deliver(entry.ctx, "该选择已在桌面端处理或取消，QQ 卡片已失效")
        continue
      }
      if (entry.state === "expired") {
        if (!entry.cancelling) await track(expireEntry(userId, entry))
      } else if ((entry.state === "clickReceived" || entry.state === "submitting") && entry.answer && !entry.replying) {
        submit(userId, entry, entry.answer, entry.display ?? "已恢复的选择", entry.interactionId)
      }
    }
    return true
  }

  function pushForm(userId: string, ctx: MessageContext, form: FormInfo): void {
    if (!accepting) {
      void deliver(ctx, "警告：表单桥正在停止，暂不接受新的 QQ 作答；请回桌面处理")
      return
    }
    if (pending.get(userId)?.form.id === form.id) return

    const liveCtx: MessageContext = { ...minimalFormContext(ctx), msgId: ctx.msgId }
    const timestamp = now()
    const firstIndex = firstFieldIndex(form, {})
    const entry: InternalPendingForm = {
      form,
      ctx: liveCtx,
      userId,
      createdAt: timestamp,
      state: "pending",
      answers: {},
      ...(firstIndex >= 0 ? { fieldIndex: firstIndex } : {}),
      updatedAt: timestamp,
      timer: null,
      replying: false,
      cancelling: false,
    }
    try {
      // 推送前先持久化：发送崩溃也至少能恢复旧按钮和服务端对账。
      journal.put(journalSnapshot(entry))
    } catch (error) {
      console.error("[form-bridge] 表单落盘失败，取消 QQ 推送:", error instanceof Error ? error.message : error)
      void deliver(ctx, "警告：选择请求无法保存恢复记录，本次未推送到 QQ；请回桌面处理")
      return
    }

    const previous = pending.get(userId)
    if (previous?.timer) clearTimeout(previous.timer)
    pending.set(userId, entry)
    scheduleExpiry(userId, entry)
    if (previous) {
      // 举一反三（2026-11-05）：被取代的旧表单台账必须同步清理——否则非终态记录
      // 永久残留，每次重启都被 restore 重载（updatedAt 比较能防顶替新槽，但僵尸账
      // 无限累积），与 bgWait superseded 同罪。
      try {
        journal.remove(userId, previous.form.id)
      } catch { /* 下次替换/reconcile 再清理 */ }
      void deliver(previous.ctx, "警告：有新的选择请求，上一个表单已取消在 QQ 的作答（仍可回桌面处理）")
    }
    console.log(`[form-bridge] 表单已推送 user=${userId.slice(0, 8)}… form=${form.id} title=${form.title.slice(0, 40)}`)
    const operation = (async () => {
      await sendCurrentField(entry)
    })()
    void track(operation)
  }

  function tryResolveText(userId: string, text: string): boolean {
    const entry = pending.get(userId)
    if (!entry) return false
    if (!accepting) {
      void deliver(entry.ctx, "警告：表单桥正在停止，本次答案未提交；请回桌面处理")
      return true
    }
    if (entry.state === "expired") {
      void deliver(entry.ctx, "警告：按钮和文字答案已失效，请使用新卡或回桌面处理")
      return true
    }
    if (entry.replying || entry.cancelling) {
      void deliver(entry.ctx, "选择正在提交或取消，请勿重复操作；稍后会给出最终回执")
      return true
    }
    const current = currentFieldOf(entry)
    if (!current) {
      submitForm(entry)
      return true
    }
    const parsed = parseFieldValue(current.field, text)
    if (!parsed) {
      void deps.sendReply(entry.ctx, `没看懂。${fieldHint(current.field)}`).catch(() => {})
      return true
    }
    void track(advance(entry, current.field, parsed))
    return true
  }

  function eventContext(event: FormInteractionEvent, userId: string): MessageContext {
    return {
      type: event.group_member_openid ? "group" : "c2c",
      userId,
      ...(event.group_member_openid && event.group_openid ? { groupId: event.group_openid } : {}),
      msgId: "",
      content: "",
    }
  }

  function rejectButton(ctx: MessageContext): void {
    void deliver(ctx, "警告：按钮已失效、已处理或不属于当前选择，请使用新卡或回桌面处理")
  }

  function handleButton(event: FormInteractionEvent): boolean {
    const userId = event.user_openid ?? event.group_member_openid
    if (!userId) return false
    const button = decodeFormButton(event.data?.resolved?.button_data)
    if (!button) return false
    const entry = pending.get(userId)
    const ctx = entry?.ctx ?? eventContext(event, userId)
    if (!accepting || !entry || entry.form.id !== button.f || entry.state === "expired") {
      console.log(`[form-bridge] 拒识过期表单按钮 user=${userId.slice(0, 8)}… form=${button.f}`)
      rejectButton(ctx)
      return true
    }
    if (entry.replying || entry.cancelling) {
      void deliver(ctx, "该按钮已受理，正在等待服务端最终结果，请勿重复点击")
      return true
    }

    const current = currentFieldOf(entry)
    const field = current?.field
    if (!field || field.key !== button.k) {
      rejectButton(ctx)
      return true
    }
    const interactionId = button.i ?? event.data?.resolved?.button_id ?? event.id
    if (interactionId) entry.interactionId = interactionId

    if (button.d) {
      if (field.type !== "multiselect") {
        rejectButton(ctx)
        return true
      }
      const selected = Array.isArray(entry.answers?.[field.key]) ? (entry.answers?.[field.key] as string[]) : []
      if (selected.length === 0) {
        if (!field.required) {
          void track(advance(entry, field, { skip: true }))
          return true
        }
        void deliver(ctx, `该题必填。${fieldHint(field)}`)
        return true
      }
      if (field.minItems !== undefined && selected.length < field.minItems) {
        void deliver(ctx, `至少选择 ${field.minItems} 项。${fieldHint(field)}`)
        return true
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        void deliver(ctx, `最多选择 ${field.maxItems} 项。${fieldHint(field)}`)
        return true
      }
      void track(advance(entry, field, { value: selected }))
      return true
    }

    if (button.s) {
      if (field.required && field.type !== "external") {
        void deliver(ctx, `该题必填。${fieldHint(field)}`)
        return true
      }
      void track(advance(entry, field, { skip: true }))
      return true
    }

    if (field.type === "multiselect") {
      const option = field.options?.find((candidate) => candidate.value === button.v)
      if (!option) {
        rejectButton(ctx)
        return true
      }
      const selected = Array.isArray(entry.answers?.[field.key]) ? [...(entry.answers?.[field.key] as string[])] : []
      const idx = selected.indexOf(option.value)
      if (idx >= 0) selected.splice(idx, 1)
      else selected.push(option.value)
      entry.answers = { ...(entry.answers ?? {}), [field.key]: selected }
      persist(entry)
      void track(sendCurrentField(entry))
      return true
    }

    let value: unknown
    if (field.type === "boolean") {
      if (button.v !== "true" && button.v !== "false") {
        rejectButton(ctx)
        return true
      }
      value = button.v === "true"
    } else if (field.type === "string") {
      const option = field.options?.find((candidate) => candidate.value === button.v)
      if (!option) {
        rejectButton(ctx)
        return true
      }
      value = option.value
    } else {
      rejectButton(ctx)
      return true
    }

    void track(advance(entry, field, { value }))
    return true
  }

  async function drainInteractions(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (operations.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining)
      })
      const drained = Promise.allSettled([...operations]).then(() => "drained" as const)
      const result = await Promise.race([drained, timeout])
      if (timer) clearTimeout(timer)
      if (result === "timeout") return false
    }
    return true
  }

  function stopAccepting(): void {
    accepting = false
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  return {
    pushForm,
    tryResolveText,
    handleButton,
    hasPending: (userId) => pending.has(userId),
    getPending: (userId) => pending.get(userId),
    restore,
    reconcile,
    drainInteractions,
    stopAccepting,
  }
}

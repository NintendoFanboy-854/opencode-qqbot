// @input:  ./config, ./qq/types, ./opencode/* (client, sessions)
// @output: isCommand, handleCommand, CommandContext
// @pos:    根层 - 命令系统: /new /stop /status /sessions /help /model /agent /rename
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import type { OpencodeClient, SessionMessage } from "./opencode/client.js"
import { renderHistory } from "./opencode/history.js"
import { SessionManager } from "./opencode/sessions.js"
import { sendLocalFile } from "./core/send-media.js"

// 观察模式 API（bridge 实现：SSE 订阅 + 里程碑推送）
export interface WatchApi {
  start: (userId: string, sessionID: string, ctx: MessageContext) => string
  stop: (userId: string) => string
  status: (userId: string) => string
}

// 摘要镜像 API（bridge 实现：订阅 + 摘要卡投递 + 持久开关）
export interface MirrorApi {
  set: (enabled: boolean) => string
  status: () => string
}

// Q1：忙碌队列 API（bridge 实现：FIFO + drain + 控制命令）
export interface QueueApi {
  list: (userId: string) => string
  /** 全量/分页视图（/queue all [页码]） */
  listAll: (userId: string, page?: number) => string
  /** /status 摘要行（排队/在途/执行中/孤儿/最近拒绝） */
  summary: (userId: string) => string
  /** 清空队列，返回清掉的条数（/cancel 与 /queue clear 共用；同时结清台账） */
  clear: (userId: string) => number
  drop: (userId: string, id: number) => string
}

// 台账诊断 API（bridge 实现：磁盘台账 + 会话历史对账）
export interface LedgerApi {
  view: (userId: string, args: string) => Promise<string>
  check: (userId: string) => Promise<string>
  settle: (userId: string, key: string, confirm: boolean) => string
}

// Q2：手动进度查询 API（bridge 实现：本地事件统计，零模型调用）
export interface ProgressApi {
  query: (userId: string) => string
}

export interface CommandContext {
  config: Config
  client: OpencodeClient
  sessions: SessionManager
  /** ACP 传输适配（transport=acp 时注入；命令面与会话/模型/agent/取消走 ACP）。 */
  acp?: CommandAcpApi
  getAccessToken: () => Promise<string>
  watch: WatchApi
  mirror: MirrorApi
  queue: QueueApi
  ledger: LedgerApi
  progress: ProgressApi
  /** P1 防线 B：/cancel 彻底复位（清队列+abort+杀后台等待+结清在途账+drain） */
  stopAll: (userId: string) => Promise<{ cleared: number; title: string | undefined }>
}

/** ACP 命令适配（与 REST 的 sessions/client 同语义的最小面）。 */
export interface CommandAcpApi {
  newSession: (userId: string) => Promise<string>
  setModel: (userId: string, providerId: string, modelId: string, variant?: string) => Promise<void>
  setAgent: (userId: string, agentId: string) => Promise<void>
  cancel: (userId: string) => void
}

interface ParsedCommand {
  name: string
  args: string
}

interface ListedSession {
  id: string
  title: string
  /** location.directory（官方 ACP session/list 语义：每条会话自带 cwd，load 必须用它） */
  directory?: string
}

interface ListedModel {
  id: string
  label: string
}

interface ListedAgent {
  id: string
  label: string
}

export function isCommand(content: string): boolean {
  return content.trim().startsWith("/")
}

export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const parsed = parseCommand(ctx.content)
  if (!parsed) {
    return "不是有效命令"
  }

  switch (parsed.name) {
    case "new":
      return handleNew(ctx, cmdCtx)
    case "stop":
    case "cancel": // /cancel 与 /stop 同义（用户自然习惯 + pi-qqbot 同款，UAT S3 实证缺口）
      return handleStop(ctx, cmdCtx)
    case "sessions":
      return handleSessions(ctx, parsed.args, cmdCtx)
    case "queue":
    case "ledger":
    case "progress":
    case "watch":
    case "mirror":
      // 2026-11-10：诊断类命令已下线（用户要求只留核心）。仍接受但明确告知。
      return "这条命令已经下线了，发 /help 看现在支持什么"
    case "status":
      return handleStatus(ctx, cmdCtx)
    case "help":
      return buildHelpText()
    case "model":
      return handleModel(ctx, parsed.args, cmdCtx)
    case "agent":
      return handleAgent(ctx, parsed.args, cmdCtx)
    case "rename":
      return handleRename(ctx, parsed.args, cmdCtx)
    case "history":
      return handleHistory(ctx, parsed.args, cmdCtx)
    case "send":
      return handleSend(ctx, parsed.args, cmdCtx)
    default:
      return `不支持的命令：/${parsed.name}\n发送 /help 查看可用命令`
  }
}

function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("/")) {
    return null
  }

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = rawName?.toLowerCase()
  if (!name) {
    return null
  }

  return {
    name,
    args: rest.join(" ").trim(),
  }
}

async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const sessionId = cmdCtx.acp
    ? await cmdCtx.acp.newSession(ctx.userId)
    : (await cmdCtx.sessions.createNew(ctx.userId)).sessionId
  return ["已创建新会话", `ID：${sessionId}`].join("\n")
}

// 缺口 4：/send <路径>——把本地文件/图片发到 QQ（路径白名单内）
async function handleSend(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const path = args.trim()
  if (!path) {
    return "用法：/send <本地文件路径>"
  }
  try {
    const done = await sendLocalFile(ctx, path, { getToken: cmdCtx.getAccessToken })
    return `${done}`
  } catch (error) {
    return `警告：发送失败：${error instanceof Error ? error.message : error}`
  }
}

async function handleStop(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const hadSession = !!cmdCtx.sessions.getSession(ctx.userId)
  cmdCtx.acp?.cancel(ctx.userId)
  const { cleared, title } = await cmdCtx.stopAll(ctx.userId)
  const suffix = cleared > 0 ? `，队列中的 ${cleared} 条已清空` : ""
  if (!hadSession && !title) {
    return cleared > 0 ? `当前没有会话可停止${suffix}` : "当前还没有会话可停止"
  }
  const target = title?.trim() ? title : cmdCtx.sessions.getSession(ctx.userId)?.sessionId ?? ""
  return `已发送停止请求：${target}${suffix}`
}

// 2026-11-10：/queue、/ledger 命令实现已删除（诊断类功能下线）。

/**
 * /status 会话行标题解析（2026-11-09 陈旧缓存显示缺陷修复）：
 * 实证「/status 显示 QQBot开发、/sessions 显示 [当前]近三日任务与设计评估」——
 * 桌面端/TUI 改名后 sessions.json 缓存不跟随（SessionManager 只在创建与 /rename 时写 title）。
 * 修复：/status 输出前用 session.get 取实时标题并回写缓存（同 id 不触发设置重放）；
 * OpenCode 不可达时回落缓存标题，不阻断 /status。
 */
export async function resolveStatusSessionTitle(
  sessions: SessionManager,
  client: OpencodeClient,
  userId: string,
): Promise<{ title?: string; sessionId?: string }> {
  const session = sessions.getSession(userId)
  if (!session) return {}
  try {
    const detail = await client.session.get({ path: { id: session.sessionId } })
    const liveTitle = detail?.data?.title
    if (liveTitle && liveTitle !== session.title) {
      sessions.switchSession(userId, session.sessionId, liveTitle, session.directory)
      return { title: liveTitle, sessionId: session.sessionId }
    }
  } catch {
    /* OpenCode 不可达：回落缓存标题 */
  }
  return { title: session.title, sessionId: session.sessionId }
}

async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const sessionInfo = await resolveStatusSessionTitle(cmdCtx.sessions, cmdCtx.client, ctx.userId)
  const { providerId, modelId, variant } = cmdCtx.sessions.getModel(ctx.userId)
  const agentId = cmdCtx.sessions.getAgent(ctx.userId)

  const openCodeStatus = await getOpenCodeStatus(cmdCtx.client)
  const qqStatus = await getQQStatus(cmdCtx)

  const model = providerId && modelId ? `${providerId}/${modelId}${variant ? `#${variant}` : ""}` : "默认"
  const lines = [
    `模型：${model}`,
    `会话：${sessionInfo.sessionId ? (sessionInfo.title ?? "未命名") : "未创建"}（Agent：${agentId ?? "默认"}）`,
  ]
  if (openCodeStatus !== "运行中") lines.push(`服务器异常：${openCodeStatus}`)
  if (qqStatus !== "正常") lines.push(`QQ 鉴权异常：${qqStatus}`)
  return lines.join("\n")
}

async function handleSessions(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const sessions = await listSessions(cmdCtx.client)
  if (sessions.length === 0) {
    return "当前没有可切换的历史会话"
  }

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const head = parts[0]?.toLowerCase() ?? ""

  // 2026-11-12：删除也是无状态——/sessions del <序号> 直接重新拉列表并删除。
  if (head === "del" || head === "delete" || head === "rm") {
    const raw = parts[1] ?? ""
    if (!/^\d+$/.test(raw)) {
      return "用法：/sessions del <序号>"
    }
    const target = sessions[Number(raw) - 1]
    if (!target) {
      return `序号无效，请发 1-${sessions.length}`
    }
    if (target.id === currentSessionId) {
      return "不能删除当前会话；先发 /sessions <序号> 切到别的会话再删"
    }
    try {
      await cmdCtx.client.session.delete({ path: { id: target.id } })
    } catch (error) {
      return `删除会话失败：${toErrorMessage(error)}`
    }
    const cleared = cmdCtx.sessions.forgetBySessionId(target.id)
    return `已删除会话：${target.title}${cleared > 0 ? `（已清理 ${cleared} 个绑定）` : ""}`
  }

  // 2026-11-12：无状态切换——每次 /sessions <序号> 都重新拉列表，不依赖上一轮的待选择状态。
  if (head) {
    if (!/^\d+$/.test(head)) {
      return "用法：/sessions、/sessions <序号>、/sessions del <序号>"
    }
    const target = sessions[Number(head) - 1]
    if (!target) {
      return `序号无效，请发 1-${sessions.length}`
    }
    if (target.id === currentSessionId) {
      return `已经是当前会话：${target.title}`
    }
    cmdCtx.sessions.switchSession(ctx.userId, target.id, target.title, target.directory)
    return `已切换到会话：${target.title}`
  }

  const lines = sessions.map((session, index) => {
    const prefix = session.id === currentSessionId ? "[当前] " : ""
    return `${index + 1}. ${prefix}${session.title}`
  })

  return [
    "会话列表：",
    ...lines,
    "发 /sessions <序号> 切换",
    "发 /sessions del <序号> 删除",
  ].join("\n")
}

async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const query = args.trim()
  const listOnly = !query || query.toLowerCase() === "all"

  // 2026-11-12：无状态选择——/model <序号> 每次重新拉列表，不依赖上一轮命令。
  if (listOnly || /^\d+$/.test(query)) {
    const models = await listModels(cmdCtx.client)
    if (models.length === 0) {
      return "当前没有可用模型"
    }

    if (listOnly) {
      const current = cmdCtx.sessions.getModel(ctx.userId)
      const lines = models.map((model, index) => {
        const isCurrent =
          current.providerId && current.modelId && `${current.providerId}/${current.modelId}` === model.id
        return `${index + 1}. ${isCurrent ? "[当前] " : ""}${model.label}`
      })
      return ["可用模型：", ...lines, "发 /model <序号> 切换，或 /model <provider/model>#max 直接指定档位"].join("\n")
    }

    const item = models[Number(query) - 1]
    if (!item) {
      return `序号无效，请发 1-${models.length}`
    }
    const selected = splitModelId(item.id)
    if (!selected) {
      return `模型项无效：${item.label}`
    }
    await ensureSession(ctx.userId, cmdCtx)
    if (cmdCtx.acp) await cmdCtx.acp.setModel(ctx.userId, selected.providerId, selected.modelId, selected.variant)
    else await cmdCtx.sessions.setModel(ctx.userId, selected.providerId, selected.modelId, selected.variant)
    return `已切换模型：${selected.providerId}/${selected.modelId}${selected.variant ? `#${selected.variant}` : ""}`
  }

  const model = splitModelId(args)
  if (!model) {
    return "模型格式不对，请使用 /model <provider/model>，档位用 #max"
  }

  await ensureSession(ctx.userId, cmdCtx)
  if (cmdCtx.acp) await cmdCtx.acp.setModel(ctx.userId, model.providerId, model.modelId, model.variant)
  else await cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId, model.variant)
  return `已切换模型：${model.providerId}/${model.modelId}${model.variant ? `#${model.variant}` : ""}`
}

async function handleAgent(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const agents = await listAgents(cmdCtx.client)
  if (agents.length === 0) {
    return "当前没有可用 Agent"
  }

  const arg = args.trim()
  if (!arg) {
    const currentAgent = cmdCtx.sessions.getAgent(ctx.userId)
    const lines = agents.map((agent, index) => {
      const isCurrent = currentAgent === agent.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${agent.label}`
    })

    return ["可用 Agent：", ...lines, "发 /agent <序号> 或 /agent <name> 切换"].join("\n")
  }

  // 2026-11-12：无状态选择——数字按当前列表取，名字按 id 精确匹配。
  const matched = /^\d+$/.test(arg)
    ? agents[Number(arg) - 1]
    : agents.find((agent) => agent.id.toLowerCase() === arg.toLowerCase())
  if (!matched) {
    return /^\d+$/.test(arg) ? `序号无效，请发 1-${agents.length}` : `未找到 Agent：${args}`
  }

  await ensureSession(ctx.userId, cmdCtx)
  if (cmdCtx.acp) await cmdCtx.acp.setAgent(ctx.userId, matched.id)
  else await cmdCtx.sessions.setAgent(ctx.userId, matched.id)
  return `已切换 Agent：${matched.id}`
}

async function handleRename(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const title = args.trim()
  if (!title) {
    return "用法：/rename <新名称>"
  }

  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可重命名"
  }

  // 2026-11-10：改名必须落到服务端。此前只写本地缓存，/status 回读服务端标题时会覆盖回去。
  try {
    await cmdCtx.client.session.update({ path: { id: session.sessionId }, body: { title } })
  } catch (error) {
    return `改名失败：${toErrorMessage(error)}`
  }
  cmdCtx.sessions.switchSession(ctx.userId, session.sessionId, title, session.directory)
  return `已重命名：${title}`
}

async function handleHistory(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话"
  }

  const n = /^\d+$/.test(args.trim()) ? Math.max(Number(args.trim()), 1) : 3
  const res = await cmdCtx.client.session.messages({ path: { id: session.sessionId } })
  const messages: SessionMessage[] = res?.data ?? []
  const body = renderHistory(messages, n)
  if (!body) {
    return "该会话暂无历史消息"
  }
  return `${session.title ?? session.sessionId} · 最近 ${n} 轮\n\n${body}`
}

// 2026-11-10：/watch、/mirror 命令实现已删除。

async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  if (cmdCtx.acp) return // ACP 适配内部会 getOrCreate
  await cmdCtx.sessions.getOrCreate(userId)
}

async function getOpenCodeStatus(client: OpencodeClient): Promise<string> {
  try {
    await client.session.list()
    return "运行中"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function getQQStatus(cmdCtx: CommandContext): Promise<string> {
  try {
    await cmdCtx.getAccessToken()
    return "正常"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function listSessions(client: OpencodeClient): Promise<ListedSession[]> {
  const result = await client.session.list()
  const rawItems = extractArray(result)
  const items = rawItems.length > 0 ? rawItems : extractArray(extractProperty(result, "data"))

  return items
    .map((item) => {
      const id = getString(item, "id")
      if (!id) {
        return null
      }
      const location = extractProperty(item, "location")
      const directory = location ? getString(location, "directory") : undefined
      return {
        id,
        title: getString(item, "title") ?? id,
        ...(directory !== undefined ? { directory } : {}),
      }
    })
    .filter((item): item is ListedSession => item !== null)
}

async function listModels(client: OpencodeClient): Promise<ListedModel[]> {
  // 2026-11-10：改用 /api/model（带 variants），列表里能看出每个模型的思考档位。
  // 无数据时回落到 config.providers（老路径，不含档位）。
  const modelApi = extractProperty(client, "model")
  const listFn = typeof modelApi === "object" && modelApi !== null ? Reflect.get(modelApi, "list") : undefined
  if (typeof listFn === "function") {
    const response = await Promise.resolve(listFn.call(modelApi))
    const raw = extractArray(response).length > 0 ? extractArray(response) : extractArray(extractProperty(response, "data"))
    const models: ListedModel[] = []
    for (const item of raw) {
      const providerId = getString(item, "providerID") ?? getString(item, "providerId")
      const modelId = getString(item, "id") ?? getString(item, "modelID")
      if (!providerId || !modelId) continue
      const rawVariants = extractProperty(item, "variants")
      const variants = Array.isArray(rawVariants)
        ? rawVariants.map((v) => (isRecord(v) ? getString(v, "id") : undefined)).filter((v): v is string => !!v)
        : []
      const suffix = variants.length > 0 ? ` [${variants.join("|")}]` : ""
      models.push({ id: `${providerId}/${modelId}`, label: `${providerId}/${modelId}${suffix}` })
    }
    if (models.length > 0) return models
  }

  const configApi = extractProperty(client, "config")
  const providersFn = typeof configApi === "object" && configApi !== null ? Reflect.get(configApi, "providers") : undefined
  const response = typeof providersFn === "function" ? await Promise.resolve(providersFn.call(configApi)) : []

  const providers = extractArray(response)
  const resolvedProviders = providers.length > 0 ? providers : extractArray(extractProperty(response, "data"))
  const models: ListedModel[] = []

  for (const provider of resolvedProviders) {
    const providerId = getString(provider, "id") ?? getString(provider, "providerID")
    const rawModels = extractArray(extractProperty(provider, "models"))
    for (const model of rawModels) {
      const modelId = getString(model, "id") ?? getString(model, "modelID")
      if (!providerId || !modelId) {
        continue
      }
      models.push({
        id: `${providerId}/${modelId}`,
        label: `${providerId}/${modelId}`,
      })
    }
  }

  return models
}

async function listAgents(client: OpencodeClient): Promise<ListedAgent[]> {
  const response = await client.app.agents()
  const rawAgents = extractArray(response)
  const agents = rawAgents.length > 0 ? rawAgents : extractArray(extractProperty(response, "data"))

  return agents
    .map((agent) => {
      const id = getString(agent, "id") ?? getString(agent, "name")
      if (!id) {
        return null
      }

      const description = getString(agent, "description")
      return {
        id,
        label: description ? `${id} - ${description}` : id,
      }
    })
    .filter((agent): agent is ListedAgent => agent !== null)
}

function splitModelId(value: string): { providerId: string; modelId: string; variant?: string } | null {
  const trimmed = value.trim()
  // 档位语法：provider/model#max（与 opencode.json 顶层 model 写法一致）
  const hashIndex = trimmed.indexOf("#")
  const head = hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed
  const variant = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : ""
  const slashIndex = head.indexOf("/")
  if (slashIndex <= 0 || slashIndex === head.length - 1) {
    return null
  }

  const providerId = head.slice(0, slashIndex).trim()
  const modelId = head.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) {
    return null
  }

  return { providerId, modelId, ...(variant ? { variant } : {}) }
}

export function buildHelpText(): string {
  return [
    "可用命令：",
    "/new - 开新会话",
    "/stop - 停下当前任务",
    "/status - 现在在干什么",
    "/model [序号|provider/model#max] - 换模型",
    "/agent [序号|名字] - 换 Agent",
    "/history [N] - 最近几轮对话",
    "/sessions - 列出/切换会话",
    "/send <路径> - 把文件发到 QQ",
    "/rename <名字> - 重命名当前会话",
    "需要审批时回复：允许 / 总是 / 拒绝",
  ].join("\n")
}

function extractArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(isRecord)
}

function extractProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined
  }
  return value[key]
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const resolved = value[key]
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

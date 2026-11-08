// @input:  ./acp（AcpClient）, ./sessions（SessionManager）
// @output: AcpSessionRunner, toPermissionView, textDelta, AcpPermissionView
// @pos:    opencode层 - ACP 会话运行器（P1）：QQ 用户 ↔ ACP session、prompt 流式聚合、
//          权限请求转交上层、会话按需 load、取消与模型/agent 设置。
//          纪律：全事件驱动，不做任何业务轮询（健康自检由上层看门狗负责）。

import { createAcpClient, type AcpClient, type AcpPermissionRequest, type AcpUpdate } from "./acp.js"
import type { SessionManager } from "./sessions.js"

/** 给审批卡/文字裁决用的最小请求视图（与 REST 版 PermissionRequest 保持同形）。 */
export interface AcpPermissionView {
  id: string
  sessionID: string
  action: string
  resources: string[]
  toolCallId?: string
}

/** ACP 权限请求 → 现有审批域可消费的视图（纯函数，供测试）。 */
export function toPermissionView(req: AcpPermissionRequest): AcpPermissionView {
  const call = req.toolCall as { toolCallId?: string; title?: string; kind?: string } | undefined
  const resource = typeof call?.title === "string" && call.title.trim() ? call.title.trim() : "(未知操作)"
  return {
    id: call?.toolCallId ?? `${req.sessionId}:permission`,
    sessionID: req.sessionId,
    action: call?.kind ?? "tool",
    resources: [resource],
    ...(call?.toolCallId ? { toolCallId: call.toolCallId } : {}),
  }
}

/** 从 session/update 中提取助手文本增量；非文本更新返回空串（纯函数，供测试）。 */
export function textDelta(update: AcpUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return ""
  const content = (update as { content?: { type?: string; text?: string } }).content
  return content?.type === "text" && typeof content.text === "string" ? content.text : ""
}

export interface AcpRunResult {
  text: string
  stopReason?: string
}

export interface AcpSessionHandlers {
  /** 权限裁决：返回 once/always/reject；null 表示无处理（按 cancelled fail-closed）。 */
  onPermission?: (userId: string, view: AcpPermissionView) => Promise<"once" | "always" | "reject" | null>
  /** 表单/提问（P3 接入 form-bridge）；未处理时 decline。 */
  onElicitation?: (userId: string, params: Record<string, unknown>) => Promise<unknown>
  /** 流式观察（投递层可选使用） */
  onUpdate?: (userId: string, update: AcpUpdate) => void
  onExit?: (code: number | null) => void
}

export interface AcpSessionOptions {
  cwd: string
  sessions: SessionManager
  handlers?: AcpSessionHandlers
  /** 可注入（测试用）；缺省创建真实 ACP 客户端 */
  client?: AcpClient
  command?: string[]
  args?: string[]
}

export class AcpSessionRunner {
  private readonly client: AcpClient
  private readonly sessions: SessionManager
  private readonly handlers: AcpSessionHandlers
  private readonly cwd: string
  private ready: Promise<void> | null = null
  private loaded = new Set<string>()
  private userBySession = new Map<string, string>()
  private buffers = new Map<string, string[]>()

  constructor(options: AcpSessionOptions) {
    this.cwd = options.cwd
    this.sessions = options.sessions
    this.handlers = options.handlers ?? {}
    this.client =
      options.client ??
      createAcpClient(
        { cwd: options.cwd, ...(options.command ? { command: options.command } : {}), ...(options.args ? { args: options.args } : {}) },
        {
          onUpdate: (sessionId, update) => this.handleUpdate(sessionId, update),
          onPermission: (req) => this.handlePermission(req),
          onElicitation: (params) => {
            const sid = String((params as { sessionId?: unknown }).sessionId ?? "")
            const userId = this.userBySession.get(sid)
            if (!userId || !this.handlers.onElicitation) return Promise.resolve({ action: "decline" })
            return this.handlers.onElicitation(userId, params)
          },
          onExit: (code) => this.handlers.onExit?.(code),
          onError: (error) => console.error("[acp-session] 传输错误:", error.message),
        },
      )
  }

  get pid(): number | undefined {
    return this.client.pid
  }

  get running(): boolean {
    return this.client.alive
  }

  async start(): Promise<void> {
    if (!this.ready) {
      this.ready = this.client.start()
      this.ready.catch(() => {
        this.ready = null // 允许下次重试
      })
    }
    await this.ready
  }

  private handleUpdate(sessionId: string, update: AcpUpdate): void {
    const userId = this.userBySession.get(sessionId)
    if (!userId) return
    const buf = this.buffers.get(sessionId)
    if (buf) {
      const delta = textDelta(update)
      if (delta) buf.push(delta)
    }
    this.handlers.onUpdate?.(userId, update)
  }

  private async handlePermission(req: AcpPermissionRequest): Promise<"once" | "always" | "reject" | null> {
    const userId = this.userBySession.get(req.sessionId)
    if (!userId || !this.handlers.onPermission) return null
    try {
      return await this.handlers.onPermission(userId, toPermissionView(req))
    } catch (error) {
      console.error("[acp-session] 权限处理失败:", error instanceof Error ? error.message : error)
      return null
    }
  }

  private async ensureLoaded(sessionId: string): Promise<void> {
    if (this.loaded.has(sessionId)) return
    try {
      await this.client.loadSession(sessionId, this.cwd)
      this.loaded.add(sessionId)
    } catch (error) {
      // 会话不存在/不可加载：上抛，由调用方决定新建
      throw new Error(`ACP 会话加载失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 取该用户的 ACP 会话；旧 REST 会话通过 session/load 接管，失败则新建。 */
  async getOrCreate(userId: string): Promise<string> {
    await this.start()
    const existing = this.sessions.getSession(userId)
    if (existing?.sessionId) {
      try {
        await this.ensureLoaded(existing.sessionId)
        return existing.sessionId
      } catch (error) {
        console.warn("[acp-session] 旧会话不可加载，改为新建:", error instanceof Error ? error.message : error)
      }
    }
    const sessionId = await this.client.newSession(this.cwd)
    this.sessions.adopt(userId, sessionId)
    this.loaded.add(sessionId)
    return sessionId
  }

  /** 新建会话（/new 迁移前由上层调用）。 */
  async newSession(userId: string): Promise<string> {
    await this.start()
    const sessionId = await this.client.newSession(this.cwd)
    this.sessions.adopt(userId, sessionId)
    this.loaded.add(sessionId)
    return sessionId
  }

  /** 执行一轮 prompt；文本由 session/update 聚合。 */
  async run(userId: string, text: string): Promise<AcpRunResult> {
    const sessionId = await this.getOrCreate(userId)
    this.userBySession.set(sessionId, userId)
    this.buffers.set(sessionId, [])
    try {
      const result = await this.client.prompt(sessionId, [{ type: "text", text }])
      const out = (this.buffers.get(sessionId) ?? []).join("")
      return { text: out, stopReason: result?.stopReason }
    } finally {
      this.buffers.delete(sessionId)
    }
  }

  cancel(userId: string): void {
    const sessionId = this.sessions.getSession(userId)?.sessionId
    if (!sessionId) return
    this.client.cancel(sessionId)
  }

  async setModel(userId: string, providerId: string, modelId: string): Promise<void> {
    const sessionId = await this.getOrCreate(userId)
    await this.client.setConfigOption(sessionId, "model", `${providerId}/${modelId}`)
  }

  async setAgent(userId: string, agentId: string): Promise<void> {
    const sessionId = await this.getOrCreate(userId)
    await this.client.setMode(sessionId, agentId)
  }

  stop(): void {
    this.client.stop()
  }
}

export function createAcpSessionRunner(options: AcpSessionOptions): AcpSessionRunner {
  return new AcpSessionRunner(options)
}

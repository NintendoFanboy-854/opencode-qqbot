// @input:  ./acp（AcpClient）, ./sessions（SessionManager）
// @output: AcpSessionRunner, toPermissionView, textDelta, AcpPermissionView,
//          isAcpPromptTimeout, isAcpPromptBusy
// @pos: opencode层 - ACP 会话运行器（P1）：QQ 用户 ACP session、prompt 流式聚合、
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

/** ACP 回合超时（客户端判定；服务端 turn 已由 doPrompt 显式 cancel 释放）。 */
export function isAcpPromptTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ACP 请求超时/.test(message)
}

/** 会话正有 active prompt（-32603，可能来自桌面端/他端或上一轮未结束）。 */
export function isAcpPromptBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /active ACP prompt|\(-32603\)|\(−32603\)/.test(message)
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
  /**
   * 回合前台等待满 30 分钟（2026-11-08 用户口径：会话没有超时限）——
   * 只通知「转后台继续」，**不终止回合**，串行链保持占用。
   */
  onPromptNotice?: (userId: string, sessionId: string) => void
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
  /**
   * 从服务端详情解析会话归属目录（REST session.get → location.directory）。
   * 2026-11-09 对齐官方 ACP 语义（cli/src/acp/service.ts getSession）：
   * session/load 必须携带会话自己的目录，缓存缺失/漂移时经此解析后再重试，
   * 解析不到才判「会话不可加载」走新建。
   */
  resolveDirectory?: (sessionId: string) => Promise<string | undefined>
}

export class AcpSessionRunner {
  private readonly client: AcpClient
  private readonly sessions: SessionManager
  private readonly handlers: AcpSessionHandlers
  private readonly cwd: string
  private readonly resolveDirectory?: (sessionId: string) => Promise<string | undefined>
  private ready: Promise<void> | null = null
  private loaded = new Set<string>()
  private userBySession = new Map<string, string>()
  private buffers = new Map<string, string[]>()
  /** 同会话 prompt 串行链：ACP 一个会话同时只允许一个 active prompt（否则 -32603）。 */
  private promptChain = new Map<string, Promise<unknown>>()

  constructor(options: AcpSessionOptions) {
    this.cwd = options.cwd
    this.sessions = options.sessions
    this.handlers = options.handlers ?? {}
    this.resolveDirectory = options.resolveDirectory
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
          onPromptNotice: (sid) => {
            const userId = this.userBySession.get(sid)
            if (userId) this.handlers.onPromptNotice?.(userId, sid)
          },
          onExit: (code) => {
            // 传输死亡后必须放行 start() 重试，否则看门狗重启永落空（2026-11-09 事故实证）
            this.ready = null
            this.loaded.clear()
            this.handlers.onExit?.(code)
          },
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

  private async ensureLoaded(sessionId: string, cwd: string): Promise<void> {
    if (this.loaded.has(sessionId)) return
    try {
      await this.client.loadSession(sessionId, cwd)
      this.loaded.add(sessionId)
    } catch (error) {
      // 会话不存在/不可加载：上抛，由调用方决定新建
      throw new Error(`ACP 会话加载失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 取该用户的 ACP 会话；旧 REST 会话通过 session/load 接管，失败则新建。
   *  2026-11-09 对齐官方语义：load 必须携带会话自己的 location.directory——
   *  缓存优先，缺失时先经 resolveDirectory 解析再加载；解析失败才降级新建。 */
  async getOrCreate(userId: string): Promise<string> {
    await this.start()
    const existing = this.sessions.getSession(userId)
    if (existing?.sessionId) {
      let cwd = existing.directory ?? this.cwd
      if (!existing.directory && this.resolveDirectory) {
        // 映射无目录缓存（旧数据/切会话未带）：加载前先从服务端解析，避免无谓的 -32602
        const resolved = await this.resolveDirectory(existing.sessionId).catch(() => undefined)
        if (resolved) {
          cwd = resolved
          this.sessions.cacheDirectory(userId, existing.sessionId, resolved)
        }
      }
      try {
        await this.ensureLoaded(existing.sessionId, cwd)
        return existing.sessionId
      } catch (error) {
        // 目录漂移兜底（如服务端 move 过/缓存过期）：按服务端真实 location 再试一次
        const message = error instanceof Error ? error.message : String(error)
        const retryable = this.resolveDirectory && /does not belong to cwd|Invalid params/.test(message)
        const resolved = retryable
          ? await this.resolveDirectory(existing.sessionId).catch(() => undefined)
          : undefined
        if (resolved && resolved !== cwd) {
          try {
            await this.ensureLoaded(existing.sessionId, resolved)
            this.sessions.cacheDirectory(userId, existing.sessionId, resolved)
            console.log(`[acp-session] 目录漂移已校正 sid=${existing.sessionId.slice(0, 12)}… → ${resolved}`)
            return existing.sessionId
          } catch {
            /* fallthrough 新建 */
          }
        }
        console.warn("[acp-session] 旧会话不可加载，改为新建:", message)
      }
    }
    // 项目归属继承：直接在目标目录创建（与官方 session/new 语义一致，消除 create/move 不一致）
    const inherit = this.sessions.peekInheritDirectory(userId)
    const sessionId = await this.client.newSession(inherit)
    this.sessions.adopt(userId, sessionId)
    this.loaded.add(sessionId)
    await this.sessions.enforceLocation(userId, sessionId, inherit)
    return sessionId
  }

  /** 新建会话（/new）：在继承目录下创建。 */
  async newSession(userId: string): Promise<string> {
    await this.start()
    const inherit = this.sessions.peekInheritDirectory(userId)
    const sessionId = await this.client.newSession(inherit)
    this.sessions.adopt(userId, sessionId)
    this.loaded.add(sessionId)
    await this.sessions.enforceLocation(userId, sessionId, inherit)
    return sessionId
  }

  /** 执行一轮 prompt；文本由 session/update 聚合。 */
  async run(userId: string, text: string): Promise<AcpRunResult> {
    const sessionId = await this.getOrCreate(userId)
    this.userBySession.set(sessionId, userId)

    // 2026-11-08 缺陷修复：同一会话的 prompt 必须串行。此前超时/失败会把上一轮的
    // promise 打死而服务端 turn 仍在跑，队列 drain 立刻再发 prompt →
    // 服务端回 -32603「Session already has an active ACP prompt」，用户连吃报错直到 /stop。
    // 这里按会话把 prompt 接成链：上一轮真正结束（成功/失败/超时）后才发下一轮。
    const previous = this.promptChain.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.doPrompt(sessionId, text),
      () => this.doPrompt(sessionId, text),
    )
    this.promptChain.set(
      sessionId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  private async doPrompt(sessionId: string, text: string): Promise<AcpRunResult> {
    this.buffers.set(sessionId, [])
    try {
      const result = await this.client.prompt(sessionId, [{ type: "text", text }])
      const out = (this.buffers.get(sessionId) ?? []).join("")
      return { text: out, stopReason: result?.stopReason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/请求超时|timeout/i.test(message)) {
        // 客户端超时 ≠ 服务端已停：必须显式 cancel 释放会话，否则 active prompt 残留
        // 会把后续所有 prompt 顶成 -32603。
        console.error(`[acp-session] prompt 超时，已发送 session/cancel 释放会话 sid=${sessionId}`)
        this.client.cancel(sessionId)
      }
      throw error
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

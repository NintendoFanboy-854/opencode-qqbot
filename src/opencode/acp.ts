// @input:  node:child_process, node:readline
// @output: AcpClient, createAcpClient, parseJsonRpcLine, pickOption, permissionOutcome,
//          AcpPermissionRequest, AcpPermissionOutcome, AcpUpdateHandler
// @pos:    opencode层 - ACP（Agent Client Protocol）传输客户端。QQ 侧 turn 的唯一通道：
//          session/prompt 驱动回合，session/update 推送文本，session/request_permission
//          在裁决前阻塞工具执行（拒绝 → stopReason=cancelled）。
//          设计纪律：本模块不做任何轮询；事件由子进程 stdout 推送，健康自检交给上层看门狗。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

/** 解析一行 ACP 输出；非法行返回 null（坏帧不杀流）。 */
export function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  const text = line.trim()
  if (!text) return null
  try {
    const msg = JSON.parse(text) as JsonRpcMessage
    if (!msg || typeof msg !== "object" || (msg as { jsonrpc?: unknown }).jsonrpc !== "2.0") return null
    return msg
  } catch {
    return null
  }
}

export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind?: string
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCall?: { toolCallId?: string; title?: string; kind?: string; content?: unknown; locations?: unknown }
  options?: AcpPermissionOption[]
  _meta?: Record<string, unknown>
}

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }

/** 把用户的「允许一次 / 总是允许 / 拒绝」映射到 ACP optionId（纯函数，供测试）。 */
export function pickOption(options: readonly AcpPermissionOption[], decision: "once" | "always" | "reject"): string | null {
  const wanted =
    decision === "once"
      ? ["allow_once"]
      : decision === "always"
        ? ["allow_always"]
        : ["reject_once", "reject_always"]
  for (const kind of wanted) {
    const hit = options.find((o) => o.kind === kind)
    if (hit) return hit.optionId
  }
  return null
}

/** 无匹配选项时 fail-closed：返回 cancelled，绝不默认放行。 */
export function permissionOutcome(optionId: string | null): AcpPermissionOutcome {
  return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" }
}

export interface AcpUpdate {
  sessionUpdate?: string
  [key: string]: unknown
}

export interface AcpHandlers {
  /** session/update 通知（文本增量、工具调用、计划等） */
  onUpdate?: (sessionId: string, update: AcpUpdate) => void
  /** agent → client 权限请求；返回裁决结果。未处理时按 cancelled 处理（fail-closed）。 */
  onPermission?: (request: AcpPermissionRequest) => Promise<"once" | "always" | "reject" | null>
  /** agent → client 表单/提问；返回 ACP 的 elicitation 结果。未处理时返回 decline。 */
  onElicitation?: (params: Record<string, unknown>) => Promise<unknown>
  /**
   * 回合前台等待满 promptNoticeMs（默认 30 分钟）时触发一次——**只通知，不终止**。
   * 2026-11-08 用户口径：会话没有超时限，只有弹窗才有 TTL；
   * 超时只意味着「前台等待结束，转后台继续」，任务继续跑、完成即回传。
   */
  onPromptNotice?: (sessionId: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onError?: (error: Error) => void
}

export interface AcpClientOptions {
  /** 完整启动命令；默认 Windows 走 cmd /c opencode acp，其他平台 opencode acp */
  command?: string[]
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** 单条请求超时（默认 10 分钟；prompt 另走 promptTimeoutMs） */
  requestTimeoutMs?: number
  /** initialize 握手超时（默认 30 秒；握手失败即清理子进程，可再次 start） */
  handshakeTimeoutMs?: number
  /**
   * session/prompt 回合超时（默认 6 小时**硬上限**）。
   * 分两层（2026-11-08 用户拍板「会话没有超时限，只有弹窗有超时」）：
   *   ① promptNoticeMs（默认 30 分钟）→ 只发一次「已转后台继续」通知，**不终止回合**；
   *   ② 本值 = 硬上限，仅用于兜住真正的死挂（正常轮次远达不到），到点才 reject + cancel。
   * 历史：先 10 分钟（通用超时，长回合必被判死 → -32603 级联），再 30 分钟被我误当成
   * 「会话超时」直接杀任务——那是把弹窗 TTL 的语义错搬到会话上。
   */
  promptTimeoutMs?: number
  /** 回合前台等待多久后发「转后台继续」通知（默认 30 分钟，只通知不终止）。 */
  promptNoticeMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** 无超时请求（timeoutMs=0）没有定时器 */
  timer?: ReturnType<typeof setTimeout>
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private buffer = ""
  private stopped = false
  private readonly opts: AcpClientOptions
  private readonly handlers: AcpHandlers

  constructor(options: AcpClientOptions, handlers: AcpHandlers = {}) {
    this.opts = options
    this.handlers = handlers
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return !!this.child && !this.stopped
  }

  /** 启动子进程并完成 ACP initialize。可重入：子进程退出后 child 置空，可再次拉起。 */
  async start(): Promise<void> {
    if (this.child) return
    const cmd = this.opts.command ?? (process.platform === "win32" ? ["cmd", "/c", "opencode"] : ["opencode"])
    const args = this.opts.args ?? ["acp"]
    const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child
    this.stopped = false

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", () => {
      // ACP 的 stdout 只承载协议；stderr 是日志。此处不落正文，避免噪声/泄密。
    })
    child.on("error", (error) => {
      this.teardown()
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    })
    child.on("exit", (code, signal) => {
      this.teardown()
      this.failAll(new Error(`ACP 进程退出 code=${code} signal=${signal ?? ""}`))
      this.handlers.onExit?.(code, signal)
    })

    // 2026-11-08 根因修复：form 必须是「对象」而非布尔。ACP schema 里
    // elicitation.form 是 `{_meta?}` 形状，写成 true 会被判为无效能力，
    // opencode 侧 formElicitation=false → 表单/提问直接被取消，
    // question 工具只会回 "The question couldn't be shown..."（不产生任何下发）。
    // 2026-11-09 加固：initialize 独立握手超时（默认 30s，不再吃 10 分钟通用超时）；
    // 握手失败立即清理子进程，下次 start() 可干净重试。
    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      }, this.opts.handshakeTimeoutMs ?? 30_000)
    } catch (error) {
      this.teardown()
      throw error
    }
  }

  /** 清理子进程引用（不杀进程——exit/error 路径进程已不在；stop() 先杀再调）。 */
  private teardown(): void {
    this.stopped = true
    this.child = null
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf("\n")
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const msg = parseJsonRpcLine(line)
      if (msg) void this.dispatch(msg)
      idx = this.buffer.indexOf("\n")
    }
    // 防御性上限：异常输出不应撑爆内存
    if (this.buffer.length > 4_000_000) this.buffer = ""
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    // 响应：按 id 归还
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      if ("error" in msg && msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else entry.resolve((msg as JsonRpcResponse).result)
      return
    }

    if (!("method" in msg)) return
    const method = msg.method

    // 通知：session/update
    if (!("id" in msg)) {
      if (method === "session/update") {
        const params = (msg.params ?? {}) as { sessionId?: string; update?: AcpUpdate }
        if (params.sessionId && params.update) this.handlers.onUpdate?.(params.sessionId, params.update)
      }
      return
    }

    // agent → client 请求：必须回应，否则工具会一直等
    const id = msg.id as number | string
    if (method === "session/request_permission") {
      const req = (msg.params ?? {}) as AcpPermissionRequest
      let decision: "once" | "always" | "reject" | null = null
      try {
        decision = this.handlers.onPermission ? await this.handlers.onPermission(req) : null
      } catch (error) {
        this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      const optionId = decision ? pickOption(req.options ?? [], decision) : null
      this.respond(id, { outcome: permissionOutcome(optionId) })
      return
    }

    if (method === "elicitation/create") {
      let result: unknown = { action: "decline" }
      try {
        result = this.handlers.onElicitation ? await this.handlers.onElicitation((msg.params ?? {}) as Record<string, unknown>) : { action: "decline" }
      } catch (error) {
        this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      this.respond(id, result)
      return
    }

    // 未知的 agent→client 请求：明确拒绝，避免挂起
    this.respondError(id, -32601, `unsupported method: ${method}`)
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result })
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } })
  }

  private write(msg: unknown): void {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(JSON.stringify(msg) + "\n")
  }

  /** JSON-RPC 请求（带超时）；timeoutMs=0 表示**不设超时**（回合默认不设，见 prompt）。
   *  2026-11-09 加固：传输未连接（子进程退出/未启动）时立即失败，
   *  不再把请求写进死 stdin 后干等 10 分钟/6 小时超时。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child || this.stopped) {
      return Promise.reject(new Error(`ACP 传输未连接: ${method}`))
    }
    const id = ++this.seq
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 10 * 60_000
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`ACP 请求超时: ${method}`))
            }, timeout)
          : undefined
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  async newSession(cwd: string, extra?: { additionalDirectories?: string[]; mcpServers?: unknown[] }): Promise<string> {
    const result = await this.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: extra?.mcpServers ?? [],
      ...(extra?.additionalDirectories ? { additionalDirectories: extra.additionalDirectories } : {}),
    })
    return result.sessionId
  }

  async loadSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] })
  }

  async prompt(sessionId: string, prompt: Array<{ type: "text"; text: string } | Record<string, unknown>>): Promise<{ stopReason?: string }> {
    // 2026-11-08 用户口径：**会话没有超时限，只有弹窗才有 TTL**。
    // 满 promptNoticeMs（30 分钟）只通知一次「已转后台继续」，promise 不 reject、
    // 任务不被杀、串行链保持占用（后续消息继续排队，不会撞 -32603）；
    // 只有 promptTimeoutMs（6 小时硬上限）才 reject，用于兜住真正的死挂。
    const noticeMs = this.opts.promptNoticeMs ?? 30 * 60_000
    const capMs = this.opts.promptTimeoutMs ?? 6 * 60 * 60_000
    let noticed = false
    const noticeTimer =
      noticeMs > 0
        ? setTimeout(() => {
            if (noticed) return
            noticed = true
            this.handlers.onPromptNotice?.(sessionId)
          }, noticeMs)
        : null
    try {
      return await this.request("session/prompt", { sessionId, prompt }, capMs)
    } finally {
      if (noticeTimer) clearTimeout(noticeTimer)
    }
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId })
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.request("session/set_config_option", { sessionId, configId, value })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId })
  }

  async listSessions(cwd?: string): Promise<unknown> {
    return this.request("session/list", cwd ? { cwd } : {})
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId })
  }

  stop(): void {
    this.stopped = true
    this.failAll(new Error("ACP 客户端已停止"))
    try {
      this.child?.stdin.end()
    } catch {
      /* ignore */
    }
    this.child?.kill()
    this.child = null
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}

export function createAcpClient(options: AcpClientOptions, handlers: AcpHandlers = {}): AcpClient {
  return new AcpClient(options, handlers)
}

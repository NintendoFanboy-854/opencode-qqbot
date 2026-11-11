// 2026-11-12 回归：/sessions /model /agent 都必须是「命令自带序号即可生效」的无状态形式。
import { handleCommand } from "../src/commands.ts"
import type { CommandContext } from "../src/commands.ts"
import type { MessageContext } from "../src/qq/types.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

let switched: unknown[] | null = null
let setModel: unknown[] | null = null
let setAgent: unknown[] | null = null
let deleted: string | null = null
let forgotten: string | null = null
let recoveredInfo: { oldSessionId?: string; newSessionId?: string } | null = null
let simulateRecovery = false

const sessions = {
  getSession: () => ({ sessionId: "s1", title: "One", directory: "C:\\a" }),
  switchSession: (...args: unknown[]) => {
    switched = args
  },
  forgetBySessionId: (id: string) => {
    forgotten = id
    return 0
  },
  getModel: () => ({ providerId: "p", modelId: "m1" }),
  setModel: async (...args: unknown[]) => {
    setModel = args
  },
  getAgent: () => "build",
  setAgent: async (...args: unknown[]) => {
    setAgent = args
  },
  getOrCreate: async (
    userId: string,
    opts?: { onRecovered?: (info: { userId: string; oldSessionId: string; oldTitle?: string; newSessionId: string }) => void },
  ) => {
    if (simulateRecovery) {
      opts?.onRecovered?.({
        userId,
        oldSessionId: "old-session",
        oldTitle: "Old",
        newSessionId: "s1",
      })
    }
    return { sessionId: "s1", title: "One" }
  },
}

const client = {
  session: {
    list: async () => ({
      data: [
        { id: "s1", title: "One", location: { directory: "C:\\a" } },
        { id: "s2", title: "Two", location: { directory: "C:\\b" } },
      ],
    }),
    delete: async (opts: { path: { id: string } }) => {
      deleted = opts.path.id
      return null
    },
    get: async () => ({ data: { id: "s1", title: "One", agent: "qqbot" } }),
  },
  config: {
    get: async () => [
      {
        type: "document",
        path: "C:\\Users\\HuanChen\\.config\\opencode\\opencode.json",
        info: {
          model: { providerID: "opencode", model: "deepseek-v4.1-flash-free", variant: "max" },
        },
      },
    ],
  },
  model: {
    list: async () => ({
      data: [
        { providerID: "p", id: "m1", variants: [{ id: "low" }, { id: "max" }] },
        { providerID: "p", id: "m2", variants: [{ id: "high" }] },
      ],
    }),
  },
  app: {
    agents: async () => ({
      data: [
        { id: "build", description: "Build" },
        { id: "qqbot", description: "QQ" },
      ],
    }),
  },
}

const cmdCtx = {
  client,
  sessions,
  getAccessToken: async () => "token",
  onSessionRecovered: (info: { oldSessionId?: string; newSessionId?: string }) => {
    recoveredInfo = info
  },
  watch: {},
  mirror: {},
  queue: {},
  ledger: {},
  progress: {},
  stopAll: async () => ({ cleared: 0, title: undefined }),
} as unknown as CommandContext

const ctx = (content: string): MessageContext => ({
  type: "c2c",
  userId: "u1",
  msgId: "m",
  content,
  timestamp: String(Date.now()),
})

// 本地映射没有 model 时，/model 和 /status 要能解析出真实生效的全局模型
const cmdCtxNoModel = {
  ...cmdCtx,
  sessions: { ...sessions, getModel: () => ({}) },
} as unknown as CommandContext

// 1. 不先发 /sessions，直接带序号切换
const r1 = await handleCommand(ctx("/sessions 2"), cmdCtx)
check("直接 /sessions 2 生效", r1.includes("已切换到会话") && switched?.[0] === "u1" && switched?.[1] === "s2", r1)

// 2. 不先发 /model list，直接 select 切换
setModel = null
const r2 = await handleCommand(ctx("/model select 2"), cmdCtx)
check("直接 /model select 2 生效", r2.includes("已切换模型") && setModel?.[1] === "p" && setModel?.[2] === "m2", r2)

// 2b. /model 默认只显示当前模型，不展开全部；子命令只在回复里
const r2a = await handleCommand(ctx("/model"), cmdCtx)
check("model 默认只显示当前", r2a.includes("当前模型：p/m1") && !r2a.includes("p/m2"), r2a)
check("model 面板显示 list/select", r2a.includes("/model list") && r2a.includes("/model select"), r2a)

const r2aFallback = await handleCommand(ctx("/model"), cmdCtxNoModel)
check(
  "model 映射无 model 时解析全局模型",
  r2aFallback.includes("当前模型：opencode/deepseek-v4.1-flash-free#max"),
  r2aFallback,
)
const statusFallback = await handleCommand(ctx("/status"), cmdCtxNoModel)
check(
  "status 映射无 model 时解析全局模型",
  statusFallback.includes("opencode/deepseek-v4.1-flash-free#max"),
  statusFallback,
)

const r2b = await handleCommand(ctx("/model list"), cmdCtx)
check("model list 显示全部和强度", r2b.includes("p/m1 [low|max]") && r2b.includes("p/m2 [high]"), r2b)

setModel = null
const r2c = await handleCommand(ctx("/model select 2 high"), cmdCtx)
check(
  "model select 带强度",
  r2c.includes("#high") && setModel?.[2] === "m2" && setModel?.[3] === "high",
  r2c,
)

const r2d = await handleCommand(ctx("/model select 2 low"), cmdCtx)
check("model 强度无效", r2d.includes("强度无效"), r2d)

setModel = null
const r2e = await handleCommand(ctx("/model select 1#max"), cmdCtx)
check(
  "model select 序号#强度",
  r2e.includes("#max") && setModel?.[2] === "m1" && setModel?.[3] === "max",
  r2e,
)

// 3. 不先发 /agent，直接带序号切换
const r3 = await handleCommand(ctx("/agent 2"), cmdCtx)
check("直接 /agent 2 生效", r3.includes("已切换 Agent") && setAgent?.[1] === "qqbot", r3)

// 4. 列表本身不产生待选择状态，提示带序号；子命令只在 /sessions 回复里出现
const r4 = await handleCommand(ctx("/sessions"), cmdCtx)
check("列表提示命令带序号", r4.includes("/sessions <序号>"), r4)
check("sessions 回复里有删除子命令", r4.includes("/sessions del <序号>"), r4)
const help = await handleCommand(ctx("/help"), cmdCtx)
check("help 不展开 sessions 子命令", !help.includes("/sessions del"), help)
check("help 不展开 model 子命令", !help.includes("/model list") && !help.includes("/model select"), help)

// 5. 序号越界有明确错误
const r5 = await handleCommand(ctx("/model select 99"), cmdCtx)
check("模型序号越界", r5.includes("序号无效"), r5)
const r6 = await handleCommand(ctx("/agent 99"), cmdCtx)
check("Agent 序号越界", r6.includes("序号无效"), r6)

// 7. 无状态删除：直接 /sessions del 2 删除
deleted = null
forgotten = null
const r7 = await handleCommand(ctx("/sessions del 2"), cmdCtx)
check("直接 /sessions del 2 生效", r7.includes("已删除会话") && deleted === "s2" && forgotten === "s2", r7)

// 8. 不允许删除当前会话
deleted = null
const r8 = await handleCommand(ctx("/sessions del 1"), cmdCtx)
check("拒绝删除当前会话", r8.includes("不能删除当前会话") && deleted === null, r8)

// 9. 删除序号越界 / 缺少序号
const r9 = await handleCommand(ctx("/sessions del 99"), cmdCtx)
check("删除序号越界", r9.includes("序号无效"), r9)
const r10 = await handleCommand(ctx("/sessions del"), cmdCtx)
check("删除缺少序号", r10.includes("用法"), r10)

// 10. /model select 缺少参数
const r11 = await handleCommand(ctx("/model select"), cmdCtx)
check("model select 缺少参数", r11.includes("用法"), r11)

// 11. 命令路径触发会话恢复时，必须回调通知 hook（bridge 再发独立 QQ 消息）
simulateRecovery = true
recoveredInfo = null
await handleCommand(ctx("/model select 2"), cmdCtx)
check(
  "命令触发的会话恢复通知",
  recoveredInfo?.oldSessionId === "old-session" && recoveredInfo?.newSessionId === "s1",
  JSON.stringify(recoveredInfo),
)

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`)
}
if (results.some(([, ok]) => !ok)) process.exitCode = 1

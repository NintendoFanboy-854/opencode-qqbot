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
  getOrCreate: async () => ({ sessionId: "s1", title: "One" }),
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
  },
  model: {
    list: async () => ({
      data: [
        { providerID: "p", id: "m1" },
        { providerID: "p", id: "m2" },
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

// 1. 不先发 /sessions，直接带序号切换
const r1 = await handleCommand(ctx("/sessions 2"), cmdCtx)
check("直接 /sessions 2 生效", r1.includes("已切换到会话") && switched?.[0] === "u1" && switched?.[1] === "s2", r1)

// 2. 不先发 /model，直接带序号切换
const r2 = await handleCommand(ctx("/model 2"), cmdCtx)
check("直接 /model 2 生效", r2.includes("已切换模型") && setModel?.[1] === "p" && setModel?.[2] === "m2", r2)

// 3. 不先发 /agent，直接带序号切换
const r3 = await handleCommand(ctx("/agent 2"), cmdCtx)
check("直接 /agent 2 生效", r3.includes("已切换 Agent") && setAgent?.[1] === "qqbot", r3)

// 4. 列表本身不产生待选择状态，提示带序号；子命令只在 /sessions 回复里出现
const r4 = await handleCommand(ctx("/sessions"), cmdCtx)
check("列表提示命令带序号", r4.includes("/sessions <序号>"), r4)
check("sessions 回复里有删除子命令", r4.includes("/sessions del <序号>"), r4)
const help = await handleCommand(ctx("/help"), cmdCtx)
check("help 不展开 sessions 子命令", !help.includes("/sessions del"), help)

// 5. 序号越界有明确错误
const r5 = await handleCommand(ctx("/model 99"), cmdCtx)
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

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`)
}
if (results.some(([, ok]) => !ok)) process.exitCode = 1

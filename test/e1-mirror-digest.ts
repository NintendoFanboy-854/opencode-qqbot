// E1 单元：buildDigest（摘要镜像卡构建）
import { buildDigest, digestTurnKey } from "../src/opencode/mirror.ts"
import { createMirror } from "../src/core/mirror.ts"
import { collectReplyText } from "../src/opencode/client.ts"
import type { SessionMessage } from "../src/opencode/client.ts"
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// 环境隔离（2026-11-06）：loadMirrorEnabled 读真实 ~/.openqq/settings.json，
// 运行时镜像开关状态会左右 ensureSubs 是否订阅——测试不得依赖真实环境。
const SETTINGS = join(homedir(), ".openqq", "settings.json")
const SETTINGS_BAK = SETTINGS + ".e1-bak"
const hadSettings = existsSync(SETTINGS)
if (hadSettings) renameSync(SETTINGS, SETTINGS_BAK)
writeFileSync(SETTINGS, JSON.stringify({ mirror: true }))
process.on("exit", () => {
  try {
    if (hadSettings) renameSync(SETTINGS_BAK, SETTINGS)
    else if (existsSync(SETTINGS)) renameSync(SETTINGS, SETTINGS + ".e1-del")
  } catch { /* 尽力恢复 */ }
})

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

// 构造实测倒序结构（新→旧）
const mk = (arr: any[]): SessionMessage[] => arr as SessionMessage[]

// 1. 正常一轮：倒序（assistant 答 → user 问 → 上一轮残留）
const normal = mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "答案是42。" }, { type: "tool", tool: "shell", state: { status: "completed" } }] },
  { id: "u2", type: "user", text: "问一个问题" },
  { id: "a1", type: "assistant", content: [{ type: "text", text: "旧答案" }] },
  { id: "u1", type: "user", text: "旧问题" },
])
const d1 = buildDigest(normal)
check("正常一轮出卡", !!d1, d1?.split("\n")[0] ?? "null")
check("含最新用户问题", d1?.includes("用户：问一个问题") ?? false)
check("含最新答案、不含旧轮", (d1?.includes("答案是42") ?? false) && !(d1?.includes("旧答案") ?? false))

// 2. 无 assistant 正文（纯工具轮）→ null
const toolOnly = mk([
  { id: "a2", type: "assistant", content: [{ type: "tool", tool: "shell", state: { status: "completed" } }] },
  { id: "u2", type: "user", text: "跑个命令" },
])
check("纯工具轮返回 null", buildDigest(toolOnly) === null)

// 3. 空历史 → null
check("空历史返回 null", buildDigest([]) === null)

// 4. 只有 user 没有回复 → null
check("无回复返回 null", buildDigest(mk([{ id: "u1", type: "user", text: "在吗" }])) === null)

// 5. 默认全文不截断（E2，2026-10-29 用户要求"摘要回全文"）
const longText = "字".repeat(2000)
const dLong = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: longText }] },
  { id: "u2", type: "user", text: "长文" },
]))
check(
  "默认全文不截断（含完整 2000 字、无省略号无提示行）",
  (dLong?.includes(longText) ?? false) && !(dLong?.includes("…") ?? false) && !(dLong?.includes("答案共") ?? false),
)

// 5b. 配置截断模式：QQ_DIGEST_ANSWER_MAX_CHARS>0 恢复旧行为（可逆开关）
process.env.QQ_DIGEST_ANSWER_MAX_CHARS = "600"
const dLongCapped = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: longText }] },
  { id: "u2", type: "user", text: "长文" },
]))
check(
  "配置 600 恢复截断+提示行",
  (dLongCapped?.includes("…") ?? false) && (dLongCapped?.includes("答案共 2000 字") ?? false),
)
delete process.env.QQ_DIGEST_ANSWER_MAX_CHARS

// 6. 脱敏：答案含 token 不外泄
const dSecret = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "执行了 OPENCODE_PASSWORD=supersecret123 的命令" }] },
  { id: "u2", type: "user", text: "带密钥的轮次" },
]))
check("答案已脱敏", (dSecret?.includes("***") ?? false) && !dSecret!.includes("supersecret123"))

// 7. 多段文本拼接
const dMulti = buildDigest(mk([
  { id: "a2", type: "assistant", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] },
  { id: "u2", type: "user", text: "多段" },
]))
check("多段文本均收录", (dMulti?.includes("第一段") ?? false) && (dMulti?.includes("第二段") ?? false))

// 8. 同一回合多个 assistant 消息：只取最终正文，阶段前导语不重复拼接
const dProgress = buildDigest(mk([
  { id: "a-final", type: "assistant", content: [{ type: "text", text: "最终答案" }] },
  { id: "a-progress", type: "assistant", content: [{ type: "text", text: "正在检查与阶段进度" }] },
  { id: "u2", type: "user", text: "执行长任务" },
]))
check(
  "镜像只含最终 assistant、不含阶段前导语",
  (dProgress?.includes("最终答案") ?? false) && !(dProgress?.includes("阶段进度") ?? false),
)
const turnMessages = mk([
  { id: "a-final", type: "assistant", content: [{ type: "text", text: "最终答案" }] },
  { id: "a-progress", type: "assistant", content: [{ type: "text", text: "阶段进度" }] },
  { id: "u-turn", type: "user", text: "执行长任务" },
])
const turnKey = digestTurnKey(turnMessages)
check("逻辑回合并发键含最终 assistant", turnKey === "u-turn:a-final", String(turnKey))
check("同一回合并发键稳定", digestTurnKey([...turnMessages]) === turnKey)
check("不同 assistant 回合不被误去重", digestTurnKey(mk([{ ...turnMessages[0], id: "a-other" }, ...turnMessages.slice(1)])) !== turnKey)
check("不同用户回合不被误去重", digestTurnKey(mk([...turnMessages.slice(0, 2), { ...turnMessages[2], id: "u-other" }])) !== turnKey)

const reply = collectReplyText(mk([
  { id: "a-final", type: "assistant", time: { created: 300 }, content: [{ type: "text", text: "最终答案" }] },
  { id: "a-progress", type: "assistant", time: { created: 200 }, content: [{ type: "text", text: "阶段进度" }] },
  { id: "a-first", type: "assistant", time: { created: 100 }, content: [{ type: "text", text: "开始处理" }] },
]), 100)
check("直答只取最新 assistant 正文", reply === "最终答案", reply)

// 9. 多 location/重复完成事件并发触发：同一逻辑回合实际只投一次
const listeners: Array<(ev: any) => void> = []
let mirrorDeliveries = 0
const mirror = createMirror({
  sessions: { all: () => [{ sessionId: "s1", userId: "u1" }] } as any,
  eventStream: { subscribe: (_sid: string, cb: (ev: any) => void) => { listeners.push(cb); return () => {} } } as any,
  client: { session: { messages: async () => ({ data: turnMessages }) } } as any,
  lastCtx: new Map(),
  safeDeliver: async () => { mirrorDeliveries++ },
  bgWaits: new Map(),
  busyUsers: new Set(),
})
mirror.ensureSubs()
const completion = { id: "evt-1", type: "session.execution.succeeded", data: { sessionID: "s1" } }
await Promise.all([listeners[0](completion), listeners[0](completion)])
check("同一逻辑回合并发完成事件只投一次", mirrorDeliveries === 1, `deliveries=${mirrorDeliveries}`)

const fails = results.filter(([, ok]) => !ok)
for (const [n, ok, d] of results) console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " — " + d : ""}`)
console.log(fails.length === 0 ? "E1 buildDigest: ALL PASS" : `E1: ${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)

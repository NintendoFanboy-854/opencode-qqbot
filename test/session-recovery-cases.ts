// 2026-11-12 回归：只有明确 404/不存在才允许自动新建，网络/鉴权错误不能误清新映射。
import { isSessionNotFoundError } from "../src/opencode/sessions.ts"

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean) => results.push([name, ok])

check("API 404", isSessionNotFoundError(new Error("OpenCode API 404: session not found")))
check("not found", isSessionNotFoundError(new Error("Session not found")))
check("不存在", isSessionNotFoundError(new Error("会话不存在")))
check("401 不算", !isSessionNotFoundError(new Error("OpenCode API 401: Unauthorized")))
check("ECONNREFUSED 不算", !isSessionNotFoundError(new Error("ECONNREFUSED")))
check("503 不算", !isSessionNotFoundError(new Error("OpenCode API 503: busy")))

for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
if (results.some(([, ok]) => !ok)) process.exitCode = 1

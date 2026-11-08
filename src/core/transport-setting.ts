// @input:  node:fs, node:path, node:os
// @output: Transport, readTransportSetting, writeTransportSetting
// @pos:    core - 传输选择持久化（非密钥）。~/.openqq/transport.json：{"transport":"acp"}
//          设计动机：环境变量注入会在看门狗/插件重拉后丢失，导致 ACP 模式回退 REST。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type Transport = "acp" | "rest"

const DIR = join(homedir(), ".openqq")
const FILE = join(DIR, "transport.json")

export function readTransportSetting(): Transport | undefined {
  try {
    if (!existsSync(FILE)) return undefined
    const raw = readFileSync(FILE, "utf8").replace(/^\uFEFF/, "")
    const obj = JSON.parse(raw) as { transport?: unknown }
    if (obj.transport === "acp") return "acp"
    if (obj.transport === "rest") return "rest"
    return undefined
  } catch {
    return undefined
  }
}

export function writeTransportSetting(transport: Transport): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify({ transport }, null, 2), "utf8")
  } catch (error) {
    console.error("[transport] 持久化失败:", error instanceof Error ? error.message : error)
  }
}

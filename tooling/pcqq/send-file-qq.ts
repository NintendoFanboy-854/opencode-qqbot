// UAT 一次性工具：把本地图片经 bot 凭据直发操作者 QQ（等同 /send，零侵入 bot 进程）
// 用法: bun tooling/pcqq/send-file-qq.ts <图片路径>
import { readFileSync } from "node:fs"

import { ensureConfig, loadConfig } from "../../src/config.ts"
import { getAccessToken, uploadQQMedia, sendQQMediaMessage, MediaFileType } from "../../src/qq/api.ts"

const file = process.argv[2]
if (!file) throw new Error("用法: bun send-file-qq.ts <图片路径>")

await ensureConfig()
const config = loadConfig()
const uid = config.allowedUsers[0]
if (!uid) throw new Error("allowedUsers 为空")

const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
const ctx = { type: "c2c" as const, userId: uid, msgId: "", content: "", timestamp: new Date().toISOString() }
const uploaded = await uploadQQMedia(token, ctx, {
  fileType: MediaFileType.IMAGE,
  fileData: readFileSync(file).toString("base64"),
})
const resp = await sendQQMediaMessage(token, ctx, uploaded.file_info)
console.log("SENT-OK id=" + (resp as any)?.id)
process.exit(0)

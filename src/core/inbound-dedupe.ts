// @input:  node:crypto（指纹哈希）
// @output: messageFingerprint, admissionDecision, AdmissionKind, AdmissionInput
// @pos:    core - 入站受理去重判定（K1 同 msgId 占位 + K2 在途内容指纹）
//
// 背景（2026-11-03 根因定案）：重复回复主链=多 believer 并存、同 msgId 并发受理；
// 且不同 msgId 的相同意图（同文连发不同 msgId）也会重复执行。修复语义经用户拍板
// （2026-11-02）：去重只管「并发在途」窗口——已完成消息的重投按重发处理，不做
// 长窗已答拦截。在途判定数据源=在途台账（inflight-journal，跨进程原子），本模块
// 只做纯判定与指纹，不持有状态（台账即状态，进程不私有）。
//
// K1：同 msgId 在途（含其他进程认领）→ 拒绝；K2：同用户同内容指纹在途 → 拒绝。
// 两者窗口都=in-flight；settle 即释放，重投/重发重新放行。
// 回执纪律：duplicate-msgid 静默（另一个 believer 会给答案，本侧任何回复都是气泡）；
// duplicate-intent 给「正在处理中」短提示（首投方不会发，不构成重复）。
import { createHash } from "crypto"

export type AdmissionKind = "ok" | "duplicate-msgid" | "duplicate-intent"

/**
 * K2 内容指纹：同用户 + 归一化意图（文本/引用/附件签名）相同 → 同一意图。
 * 核入 userId 防跨用户误拦；intentKey 复用 message-queue 的意图键（busy 分支同源）。
 */
export function messageFingerprint(userId: string, intentKey: string): string {
  return createHash("sha256").update(`${userId}\u0000${intentKey}`).digest("hex").slice(0, 32)
}

export interface AdmissionInput {
  /** K1：台账里已有同 msgId 在途（任何进程认领的都算） */
  hasSameMsgIdInflight: boolean
  /** 本条指纹；空串跳过 K2（重派回合/无文本消息不参与指纹拦） */
  fingerprint: string
  /** K2：台账里全部在途记录的指纹 */
  inflightFingerprints: readonly string[]
}

/** 受理判定（纯函数）：只看并发在途；settled/被修剪的旧账不拦 */
export function admissionDecision(input: AdmissionInput): AdmissionKind {
  if (input.hasSameMsgIdInflight) return "duplicate-msgid"
  if (input.fingerprint && input.inflightFingerprints.includes(input.fingerprint)) {
    return "duplicate-intent"
  }
  return "ok"
}

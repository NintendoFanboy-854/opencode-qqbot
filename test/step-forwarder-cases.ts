// 2026-11-12 回归：text.ended 一段一段发；最终答复按 part 重建去重。
import { StepForwarder, normalizeStepText } from "../src/core/step-forwarder.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const sid = "ses_test"
const sf = new StepForwarder()

// 1. 多个 text part 按 ordinal 排序
sf.addText(sid, "m1", 1, "第二段")
sf.addText(sid, "m1", 0, "第一段")
check("collect 按 ordinal 排序", sf.collect(sid, "m1") === "第一段\n第二段", JSON.stringify(sf.collect(sid, "m1")))
check("hasTextEvents", sf.hasTextEvents(sid, "m1"))

// 2. 逐 part 转发
sf.markPartForwarded(sid, "m1", 0, "第一段")
check("part 0 已转发", sf.isPartForwarded(sid, "m1", 0))
check("part 1 未转发", !sf.isPartForwarded(sid, "m1", 1))
const pending = sf.pendingParts(sid)
check("pendingParts 只剩 part 1", pending.length === 1 && pending[0]?.ordinal === 1, JSON.stringify(pending))

// 3. 已转发的 part 不再被晚到 text.ended 覆盖
sf.addText(sid, "m1", 0, "晚到但不应覆盖")
check("已转发 part 不覆盖", sf.collect(sid, "m1") === "第一段\n第二段", JSON.stringify(sf.collect(sid, "m1")))

// 4. 最终答复：多 part 重建后去重
sf.addText(sid, "m2", 0, "最终")
sf.addText(sid, "m2", 1, "答案")
sf.markEnded(sid, "m2", "stop")
sf.markPartForwarded(sid, "m2", 0, "最终")
sf.markPartForwarded(sid, "m2", 1, "答案")
check("多 part 最终答复已转发", sf.wasFinalForwarded(sid, "最终\n答案"))
check("不同文本不误判", !sf.wasFinalForwarded(sid, "另一个答案"))

// 5. 文件-only 最终 step：有 part 发出过就算已交付
sf.markEnded(sid, "m3", "stop")
sf.markPartForwarded(sid, "m3", 0, "")
check("文件-only 最终 step 去重", sf.wasFinalForwarded(sid, ""))

// 6. 没有任何 part 发出过的空最终 step：不能误判为已交付
sf.markEnded(sid, "m4", "stop")
check("空最终 step 未交付", !sf.wasFinalForwarded(sid, ""))

// 7. fetch 兜底覆盖整条消息
sf.markEnded(sid, "m5", "stop")
sf.markFetched(sid, "m5", "兜底整段")
check("fetch 兜底参与最终去重", sf.wasFinalForwarded(sid, "兜底整段"))
check("fetch 标记", sf.isMessageFetched(sid, "m5"))

// 8. 新一轮清空
sf.startTurn(sid)
check("startTurn 清空", !sf.hasTextEvents(sid, "m1") && !sf.wasFinalForwarded(sid, "最终\n答案"))

// 9. 归一化
check("normalizeStepText", normalizeStepText("  a\r\n\tb  ") === "a b", normalizeStepText("  a\r\n\tb  "))

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`)
}
if (results.some(([, ok]) => !ok)) process.exitCode = 1

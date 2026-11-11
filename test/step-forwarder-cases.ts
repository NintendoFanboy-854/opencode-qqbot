// 2026-11-12 回归：任意交错的 step 文本都要按顺序收集，最终答复去重。
import { StepForwarder, normalizeStepText } from "../src/core/step-forwarder.ts"

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

const sid = "ses_test"
const sf = new StepForwarder()

// 1. 多个 text part 按 ordinal 排序
sf.addText(sid, "m1", 1, "第二段")
sf.addText(sid, "m1", 0, "第一段")
check("collect 按 ordinal 排序", sf.collect(sid, "m1") === "第一段\n第二段", JSON.stringify(sf.collect(sid, "m1")))

// 2. step.ended 返回缓冲文本
const buffered = sf.markEnded(sid, "m1", "tool-calls")
check("markEnded 返回缓冲文本", buffered === "第一段\n第二段", String(buffered))

// 3. 转发后不再重复
sf.markForwarded(sid, "m1", "tool-calls", buffered ?? "")
check("已转发标记", sf.isForwarded(sid, "m1"))
sf.addText(sid, "m1", 2, "晚到的第三段")
check("已转发后的晚到文本不再收集", sf.collect(sid, "m1") === "第一段\n第二段", JSON.stringify(sf.collect(sid, "m1")))

// 4. 最终答复去重（空白归一化）
sf.addText(sid, "m2", 0, "最终 答案\n带换行")
const finalText = sf.markEnded(sid, "m2", "stop") ?? ""
sf.markForwarded(sid, "m2", "stop", finalText)
check("最终答复已转发", sf.wasFinalForwarded(sid, "最终 答案 带换行"), String(sf.wasFinalForwarded(sid, "最终 答案 带换行")))
check("不同文本不误判", !sf.wasFinalForwarded(sid, "另一个答案"))

// 5. 只有文件、无文本的最终 step 也要能去重
sf.markForwarded(sid, "m3", "stop", "")
check("文件-only 最终 step 去重", sf.wasFinalForwarded(sid, ""))

// 6. pending 只列未转发的
sf.addText(sid, "m4", 0, "失败前的一段")
const pending = sf.pending(sid)
check("pending 含未转发消息", pending.includes("m4") && !pending.includes("m1"), JSON.stringify(pending))

// 7. 新一轮清空
sf.startTurn(sid)
check("startTurn 清空转发状态", !sf.isForwarded(sid, "m1") && !sf.wasFinalForwarded(sid, "最终 答案 带换行"))

// 8. 归一化
check("normalizeStepText", normalizeStepText("  a\r\n\tb  ") === "a b", normalizeStepText("  a\r\n\tb  "))

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`)
}
if (results.some(([, ok]) => !ok)) process.exitCode = 1

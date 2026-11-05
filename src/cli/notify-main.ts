// @input:  ./notify.ts（runNotifyCli）
// @output:（无导出）——notify CLI 的自执行入口（构建目标：dist/notify-cli.js）
// @pos:    cli - bin/openqq.js notify 子命令的落点；测试请 import ./notify.ts（不要引入本文件）。
import { main } from "./notify.js"

process.exitCode = await main(process.argv.slice(2))

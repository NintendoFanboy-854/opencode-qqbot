// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createClient, healthCheck, type OpencodeClient } from "./opencode/client.js"
import { discoverOpencode, persistDiscovery } from "./core/discovery.js"
import { startLinkWatch } from "./core/linkwatch.js"
import { getAccessToken, sendC2CMessage, getNextMsgSeq } from "./qq/api.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/api.js"
import { createBridge } from "./bridge.js"
import { waitInstanceLock, acquireInstanceLock, INSTANCE_LOCK_DISABLED_ENV, type InstanceLock } from "./core/instance-lock.js"

// O1（2026-10-15）：开机竞态退避等待——桌面服务未就绪时 20s 重试、15 分钟
// 上限。今晨实证（09:04–09:31）：fail-fast 秒退 → 看门狗 10 分钟粒度空转 4 次；
// 退避后服务就绪即起，不再依赖下个看门狗 tick。
// HC1（2026-10-26）：2.1.3 服务端口动态化（实证 49374→28894）。连不上时在
// 第 1/4/7… 次重试前触发回环端口签名扫描，命中即重建 client 并落盘
// ~/.openqq/last-discovered.json。.env 配置仍是第一优先，配置可达时零扫描。
async function waitForOpencode(
  clientFactory: (url: string) => OpencodeClient,
  initialUrl: string,
): Promise<OpencodeClient> {
  const deadline = Date.now() + 15 * 60 * 1000
  let attempt = 0
  let url = initialUrl
  let client = clientFactory(url)
  // 2026-11-09 掉线事故：凭据失配（401）是确定性错误，重试 15 分钟毫无意义
  //（事故实测：401 连刷 34 次，锁在、无心跳，整机判僵尸 15 分钟）。连续 N 次
  // 认证失败即快速退出，把锁交还，交给插件引导器/看门狗用干净环境重拉。
  const AUTH_FAIL_LIMIT = 3
  let authFails = 0
  for (;;) {
    try {
      await healthCheck(client)
      return client
    } catch (error) {
      attempt++
      const msg = error instanceof Error ? error.message : String(error)
      if (/\b401\b|Unauthorized/i.test(msg)) {
        authFails++
        if (authFails >= AUTH_FAIL_LIMIT) {
          throw new Error(
            `${msg}（连续 ${authFails} 次认证被拒）—— 请核对 ~/.openqq/.env 的 OPENCODE_PASSWORD 是否与当前 OpenCode 服务一致；本实例退出，等待外部拉起`,
          )
        }
      } else {
        authFails = 0
      }
      if (Date.now() >= deadline) throw error
      console.log(
        `[index] OpenCode 未就绪（第 ${attempt} 次）：${msg} —20s 后重试`,
      )
      if (attempt === 1 || attempt % 3 === 0) {
        const found = await discoverOpencode({ password: process.env.OPENCODE_PASSWORD })
        if (found && found.baseUrl !== url) {
          console.log(`[index] 端口漂移自动发现：${url} → ${found.baseUrl}（v${found.version}），改用之`)
          persistDiscovery(found)
          url = found.baseUrl
          client = clientFactory(url)
        }
      }
      await new Promise((r) => setTimeout(r, 20_000))
    }
  }
}

async function main(): Promise<void> {
  // P2（2026-10-30 清债）：插件拉起等无控制台场景的文件日志双写（bun fd 重定向
  // 实测不落盘，改为进程内 tee）。计划任务通道有 PowerShell 重定向，不受影响。
  // 2026-11-05：默认开启（~/.openqq/openqq.log），堵住 bot.out.log 断流无人发现的缺口；
  // QQ_LOG_FILE 可覆盖路径，设 0/off/false 关闭。
  {
    const raw = (process.env.QQ_LOG_FILE ?? "").trim()
    if (!/^(0|off|false|no)$/i.test(raw)) {
      const { installFileLog } = await import("./core/file-log.js")
      installFileLog(raw || join(homedir(), ".openqq", "openqq.log"))
    }
  }
  await ensureConfig()
  const config = loadConfig()

  // M 项（2026-10-30，吸收竞品 proper-lockfile 方案零依赖手写）：单实例锁防多开——
  // 双实例同 bot 会被 QQ 网关互踢。后到实例待命轮询，宿主退出/暴毙（30s 僵尸判定）
  // 后自动接管。QQ_INSTANCE_LOCK=false 关闭；=try 则抢不到即退出（插件引导器拉起
  // 场景：多 location 并发拉起时防待命实例堆积）。
  let instanceLock: InstanceLock | null = null
  const lockMode = process.env[INSTANCE_LOCK_DISABLED_ENV] ?? ""
  if (lockMode === "try") {
    instanceLock = acquireInstanceLock(config.qq.appId)
    if (!instanceLock) {
      console.log("[index] 已有实例在运行（try 模式），本实例退出")
      process.exit(0)
    }
  } else if (lockMode !== "false") {
    instanceLock = await waitInstanceLock(config.qq.appId)
  }

  if (!config.opencode.baseUrl) {
    throw new Error("缺少 OPENCODE_BASE_URL，指向 OpenCode 桌面版 API（如 http://127.0.0.1:<端口>/api；2.1.x 端口动态，失联时启动流程会自动发现）")
  }

  // E4 心跳：每 60 秒写一次时间戳 = 事件循环存活证明。
  // 2026-11-09 加固：提前到「抢锁后、连 OpenCode 前」——启动阶段（等 OpenCode /
  // 发现端口）同样可能持续数分钟，原先这段空白会让看门狗把健康启动判成
  // 「心跳陈旧」而杀掉。锁活性另由 instance-lock 的 mtime 心跳承担，两者互不替代。
  const heartbeatFile = join(homedir(), ".openqq", "heartbeat")
  const touchHeartbeat = (): void => {
    try {
      mkdirSync(join(homedir(), ".openqq"), { recursive: true })
      writeFileSync(heartbeatFile, String(Date.now()))
    } catch (error) {
      console.error("[index] 心跳写入失败:", error)
    }
  }
  touchHeartbeat()
  const heartbeatTimer = setInterval(touchHeartbeat, 60_000)
  heartbeatTimer.unref?.()
  // 事件循环漂移遥测（2026-11-09 心跳停滞事故）：预期每 30s 触发一次，
  // 实际延迟 = 定时器被事件循环推迟了多少。漂移 >5s 说明 loop 被卡住，
  // 心跳/审批 TTL 等所有定时器都会被同步推迟——直接输出证据。
  let lastTick = Date.now()
  const lagTimer = setInterval(() => {
    const now = Date.now()
    const drift = now - lastTick - 30_000
    lastTick = now
    if (drift > 5_000) {
      console.warn(`[loop-lag] 事件循环漂移 ${Math.round(drift / 1000)}s（定时器被推迟，心跳可能失新鲜）`)
    }
  }, 30_000)
  lagTimer.unref?.()

  let client: OpencodeClient
  try {
    client = await waitForOpencode((u) => createClient(u), config.opencode.baseUrl)
  } catch (error) {
    // 启动失败立即交还锁，缩短下一次接管的等待（否则锁要等 30s 过期才回收）
    clearInterval(heartbeatTimer)
    clearInterval(lagTimer)
    instanceLock?.release()
    throw error
  }

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const sessions = new SessionManager(client)
  const bridge = createBridge(config, client, sessions)
  const { eventStream } = bridge

  // HC2（2026-10-26）：运行中链路自愈巡检 + QQ 告警。
  // 告警走主动消息（allowlist 首个用户），markdown 失败回退纯文本；
  // 去重由 linkwatch 状态机保证（每事故 open + fixed 各 ≤1 条）。
  const alarm = async (text: string): Promise<void> => {
    const uid = config.allowedUsers[0]
    if (!uid) return
    const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    const seq = getNextMsgSeq("")
    try {
      await sendC2CMessage(token, uid, text, undefined, seq, true)
    } catch (error) {
      console.warn("[index] 告警 markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : error)
      await sendC2CMessage(token, uid, text, undefined, seq, false)
    }
  }
  const linkWatch = startLinkWatch({ client, onRebase: (url) => eventStream.rebase(url), alarm })

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onInteraction: (event) => bridge.handleInteraction(event),
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] OpenCode QQ Bot 已启动")

  // R 项（2026-10-30）：启动对账——恢复重启窗口内"已派发未回答"的在途回合
  //（补投答案/重挂后台等待/重派丢失消息）。异步执行不阻塞心跳建立。
  void bridge.recoverInflightRounds()

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    clearInterval(heartbeatTimer)
    clearInterval(lagTimer)
    instanceLock?.release()
    linkWatch.stop()
    gateway.stop()
    stopBackgroundTokenRefresh()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1) // 锁文件随之成僵尸，30s 后待命实例自动接管
})

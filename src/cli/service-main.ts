// @input:  平台（process.platform）、运行时命令、看门狗产物路径
// @output: build* 纯函数 + serviceInstall/serviceUninstall/serviceStatus
// @pos:    cli - 自启注册器（全平台唯一的 OS 差异点，代码仍是 TS）
//
// 2026-11-09 架构红线：平台差异只允许出现在「注册自启项」这一处。
// 本文件生成三平台的注册配置；不引入 .ps1/.vbs/.bat 作为运行时代码。
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

export const WIN_TASK_NAME = "OpenQQBotWatchdog"
export const SYSTEMD_UNIT = "openqq-watchdog"
export const LAUNCHD_LABEL = "com.linjp.opencode-qqbot.watchdog"

export interface ServiceSpec {
  /** 运行时可执行文件（bun 或 node 的绝对路径） */
  runtimeCmd: string
  /** dist/openqq-watchdog.js 绝对路径 */
  scriptPath: string
  intervalMin: number
}

export interface CommandResult {
  ok: boolean
  detail: string
}

function run(cmd: string, args: string[]): CommandResult {
  try {
    // windowsHide：CLI 巡检/注册时不弹控制台窗口（2026-11-09 用户反馈“时不时闪一下”）
    const r = spawnSync(cmd, args, { encoding: "utf-8", windowsHide: true })
    const detail = `${cmd} ${args.join(" ")}\n${(r.stdout ?? "").trim()}${(r.stderr ?? "").trim() ? `\n${r.stderr.trim()}` : ""}`
    return { ok: r.status === 0, detail }
  } catch (error) {
    return { ok: false, detail: `执行失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------- 纯函数（导出供测试） ----------

const escXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Windows 任务 XML（S4U 注册，2026-11-09 静默拉起缺陷③）：
 * schtasks 直调 console 程序在 Interactive 登录型下每次 tick 闪现控制台窗口
 * （Win11 默认终端宿主=Windows Terminal）。S4U=非交互会话，进程零窗口、免存密码。
 * 纯函数生成，注册动作不经任何 shell 中转。
 */
export function buildSchtasksTaskXml(spec: ServiceSpec, now = new Date()):
 string {
  const user = escXml(process.env.USERNAME ?? "SYSTEM")
  const trigger =
    `<TimeTrigger><StartBoundary>${now.toISOString()}</StartBoundary>` +
    `<Repetition><Interval>PT${spec.intervalMin}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>` +
    `<Enabled>true</Enabled></TimeTrigger>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<RegistrationInfo><Author>${user}</Author><Description>OpenCode QQBot watchdog (plugin-managed, silent)</Description></RegistrationInfo>`,
    `<Triggers>${trigger}</Triggers>`,
    '<Principals><Principal id="Author">' +
      `<UserId>${user}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>" +
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
      "<ExecutionTimeLimit>PT5M</ExecutionTimeLimit><StartWhenAvailable>true</StartWhenAvailable>" +
      "<Enabled>true</Enabled></Settings>",
    '<Actions Context="Author"><Exec>' +
      `<Command>${escXml(spec.runtimeCmd)}</Command>` +
      `<Arguments>${escXml(`"${spec.scriptPath}" --once`)}</Arguments>` +
      '</Exec></Actions>',
    "</Task>",
    "",
  ].join("\n")
}

export function buildSchtasksXmlArgs(xmlPath: string): string[] {
  return ["/Create", "/TN", WIN_TASK_NAME, "/XML", xmlPath, "/F"]
}

/** conhost.exe 全路径（Windows 自带；不存在作 fallback 判定） */
export function conhostPath(platform = process.platform): string | null {
  if (platform !== "win32") return null
  const p = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe")
  try {
    return statSync(p).isFile() ? p : null
  } catch {
    return null
  }
}

/**
 * 第二梯队：conhost --headless 包装（实测零闪窗、非 shell、无需提权）。
 * 适用未提权进程注册 S4U 被 Access denied 的场景；需用户已登录（Interactive 会话）。
 * 仅在「自启注册」这一处使用（平台差异收口红线）。
 */
export function buildSchtasksConhostArgs(spec: ServiceSpec): string[] {
  const conhost = conhostPath() ?? "C:\\Windows\\System32\\conhost.exe"
  const tr = `"${conhost}" --headless "${spec.runtimeCmd}" "${spec.scriptPath}" --once`
  return ["/Create", "/TN", WIN_TASK_NAME, "/SC", "MINUTE", "/MO", String(spec.intervalMin), "/TR", tr, "/F"]
}

export function buildSchtasksCreateArgs(spec: ServiceSpec): string[] {
  const tr = `"${spec.runtimeCmd}" "${spec.scriptPath}" --once`
  return ["/Create", "/TN", WIN_TASK_NAME, "/SC", "MINUTE", "/MO", String(spec.intervalMin), "/TR", tr, "/F"]
}

export function buildSchtasksDeleteArgs(): string[] {
  return ["/Delete", "/TN", WIN_TASK_NAME, "/F"]
}

export function buildSystemdService(spec: ServiceSpec): string {
  return [
    "[Unit]",
    "Description=OpenCode QQBot watchdog (plugin-managed)",
    "After=default.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart="${spec.runtimeCmd}" "${spec.scriptPath}" --once`,
    "",
  ].join("\n")
}

export function buildSystemdTimer(intervalMin: number): string {
  return [
    "[Unit]",
    "Description=OpenCode QQBot watchdog timer",
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${intervalMin}min`,
    `Unit=${SYSTEMD_UNIT}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n")
}

export function buildLaunchdPlist(spec: ServiceSpec): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${esc(spec.runtimeCmd)}</string>`,
    `    <string>${esc(spec.scriptPath)}</string>`,
    "    <string>--once</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${spec.intervalMin * 60}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

export function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user")
}

export function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
}

// ---------- 平台执行 ----------

/** 查询已注册任务的形态（注册层唯一平台差异点）：S4U > conhost --headless > Interactive */
export function registeredForm(platform = process.platform): "s4u" | "conhost" | "interactive" | "unknown" {
  if (platform !== "win32") return "unknown"
  const q = run("schtasks", ["/Query", "/TN", WIN_TASK_NAME, "/XML"])
  if (!q.ok) return "unknown"
  if (/<LogonType>S4U<\/LogonType>/.test(q.detail)) return "s4u"
  if (q.detail.includes("--headless") && /<Command>[^<]*conhost\.exe/i.test(q.detail)) return "conhost"
  return "interactive"
}

export function isS4uRegistered(platform = process.platform): boolean {
  return registeredForm(platform) === "s4u"
}

const FORM_LABEL: Record<string, string> = {
  s4u: "S4U（非交互会话，tick 零窗口）",
  conhost: "conhost --headless（隐藏控制台，需已登录会话）",
  interactive: "Interactive（可能闪窗）",
  unknown: "未知形态",
}

export function serviceInstall(spec: ServiceSpec, platform = process.platform): CommandResult {
  if (platform === "win32") {
    // 三级梯队（2026-11-09 静默拉起缺陷③）：
    // ① XML+S4U（最优，需提权/管理员令牌——未提权实证 Access denied）
    // ② conhost --headless 包装（不需提权、零闪窗、非 shell；需已登录）
    // ③ 旧 Interactive 直调（有看门狗保底，可能闪窗）
    // 每级失败都落到下一级，保证「有看门狗」优先于「看门狗静默」——最终形态在 serviceStatus 可辨。
    const xmlPath = join(tmpdir(), `openqq-watchdog-task-${process.pid}.xml`)
    try {
      // schtasks 的 XML 解析器只接受 UTF-16+UTF-16LE BOM（实证：UTF-8 声名/无 BOM 均「无法切换编码」）
      writeFileSync(xmlPath, Buffer.concat([
        new Uint8Array([0xff, 0xfe]),
        Buffer.from(buildSchtasksTaskXml(spec), "utf-16le"),
      ]))
      const res = run("schtasks", buildSchtasksXmlArgs(xmlPath))
      if (res.ok) {
        return { ok: true, detail: `${res.detail}\n注册形态: ${FORM_LABEL.s4u}` }
      }
      const xmlErr = res.detail
      rmSync(xmlPath, { force: true })
      const conhostRes = run("schtasks", buildSchtasksConhostArgs(spec))
      if (conhostRes.ok) {
        return { ok: true, detail: `${conhostRes.detail}\n注册形态: ${FORM_LABEL.conhost}\n（S4U 注册失败，已回退 conhost --headless 梯队，schtasks 原始输出：${xmlErr}）` }
      }
      const legacy = run("schtasks", buildSchtasksCreateArgs(spec))
      return {
        ...legacy,
        detail: `${legacy.detail}\n（S4U 与 conhost --headless 梯队均失败，已回退 Interactive 形态；S4U 输出：${xmlErr} ｜ conhost 输出：${conhostRes.detail}）`,
      }
    } finally {
      try {
        rmSync(xmlPath, { force: true })
      } catch {
        /* 临时文件清理失败不阻断 */
      }
    }
  }
  if (platform === "linux") {
    const dir = systemdDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.service`), buildSystemdService(spec))
    writeFileSync(join(dir, `${SYSTEMD_UNIT}.timer`), buildSystemdTimer(spec.intervalMin))
    const reload = run("systemctl", ["--user", "daemon-reload"])
    if (!reload.ok) return reload
    const enable = run("systemctl", ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`])
    return {
      ok: enable.ok,
      detail: `${enable.detail}\n提示：无图形会话时需 loginctl enable-linger $USER 才能常驻`,
    }
  }
  if (platform === "darwin") {
    const path = launchdPath()
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(path, buildLaunchdPlist(spec))
    return run("launchctl", ["load", "-w", path])
  }
  return { ok: false, detail: `不支持的平台：${platform}` }
}

export function serviceUninstall(platform = process.platform): CommandResult {
  if (platform === "win32") return run("schtasks", buildSchtasksDeleteArgs())
  if (platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`])
    rmSync(join(systemdDir(), `${SYSTEMD_UNIT}.timer`), { force: true })
    rmSync(join(systemdDir(), `${SYSTEMD_UNIT}.service`), { force: true })
    return run("systemctl", ["--user", "daemon-reload"])
  }
  if (platform === "darwin") {
    const path = launchdPath()
    const res = run("launchctl", ["unload", "-w", path])
    rmSync(path, { force: true })
    return res
  }
  return { ok: false, detail: `不支持的平台：${platform}` }
}

export function serviceStatus(platform = process.platform): CommandResult {
  if (platform === "win32") {
    const q = run("schtasks", ["/Query", "/TN", WIN_TASK_NAME])
    const form = q.ok ? `注册形态: ${FORM_LABEL[registeredForm(platform)]}` : "任务未注册"
    return { ...q, detail: `${q.detail}\n${form}` }
  }
  if (platform === "linux") {
    const exists = existsSync(join(systemdDir(), `${SYSTEMD_UNIT}.timer`))
    const active = run("systemctl", ["--user", "is-active", `${SYSTEMD_UNIT}.timer`])
    return { ok: exists && active.ok, detail: `unit 文件存在=${exists}\n${active.detail}` }
  }
  if (platform === "darwin") {
    const path = launchdPath()
    return { ok: existsSync(path), detail: `${path} 存在=${existsSync(path)}\n${run("launchctl", ["list", LAUNCHD_LABEL]).detail}` }
  }
  return { ok: false, detail: `不支持的平台：${platform}` }
}

/** 读取已安装的 unit/plist 内容（诊断用） */
export function readInstalledConfig(platform = process.platform): string | null {
  try {
    if (platform === "linux") return readFileSync(join(systemdDir(), `${SYSTEMD_UNIT}.timer`), "utf-8")
    if (platform === "darwin") return readFileSync(launchdPath(), "utf-8")
    return null
  } catch {
    return null
  }
}

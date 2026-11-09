// @input:  平台（process.platform）、运行时命令、看门狗产物路径
// @output: build* 纯函数 + serviceInstall/serviceUninstall/serviceStatus
// @pos:    cli - 自启注册器（全平台唯一的 OS 差异点，代码仍是 TS）
//
// 2026-11-09 架构红线：平台差异只允许出现在「注册自启项」这一处。
// 本文件生成三平台的注册配置；不引入 .ps1/.vbs/.bat 作为运行时代码。
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

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
    const r = spawnSync(cmd, args, { encoding: "utf-8" })
    const detail = `${cmd} ${args.join(" ")}\n${(r.stdout ?? "").trim()}${(r.stderr ?? "").trim() ? `\n${r.stderr.trim()}` : ""}`
    return { ok: r.status === 0, detail }
  } catch (error) {
    return { ok: false, detail: `执行失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------- 纯函数（导出供测试） ----------

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

export function serviceInstall(spec: ServiceSpec, platform = process.platform): CommandResult {
  if (platform === "win32") {
    return run("schtasks", buildSchtasksCreateArgs(spec))
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
  if (platform === "win32") return run("schtasks", ["/Query", "/TN", WIN_TASK_NAME])
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

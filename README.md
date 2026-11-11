# OpenCode QQ Bot（本地改造版）

把 [OpenCode](https://opencode.ai) 接到 QQ 上。人不在电脑前，也能发任务、看进度、收结果。

这是个人自用工具，不是对外服务。README 只写现在真实存在的东西。

---

## 它只做四件事

1. **收消息** —— 你在 QQ 里发的字、图、文件，转给 OpenCode。
2. **发任务** —— 把消息作为 prompt 投给会话，同一时间只跑一件。
3. **带结果回来** —— 过程中模型每说一段话就逐段单独发回（不合并）；跑完的最终答案也发回，长任务跑不完就放到后台等，做完再发。
4. **过程中给回声** —— 收到就回一句；1 分钟没动静会告诉你还在跑；被打断会明说。

除此之外的都不做。

---

## 现在的样子

这是从上游 `@linjz/opencode-qqbot` 改了之后的自用版本，和原版差别很大：

**删掉的**

- 用户白名单（原来不在名单里的人会被拒绝）
- 下载域名限制（原来只认 QQ 自家 CDN）
- 发送路径白名单（原来只能发特定目录）
- 重复问题自动忽略（原来同样的话问第二次会被当成手滑）
- 孤儿巡检（原来每分钟扫一遍，给你发"消息卡住了"）
- 诊断命令 `/queue` `/ledger` `/progress` `/watch` `/mirror`
- agent 配置里"读 .env 要审批"的规则
- 裸数字选择（现在用 `/model 2`、`/sessions 2`、`/agent 2` 直接切换）

**保留的**

- 结果不丢：发送失败会重试，重启后能补发
- 图片和文件双向；AI 主动发文件走 `qq_send_file` 工具
- 审批卡片（OpenCode 要权限时，QQ 里点一下就行）
- 看护进程：bot 挂了会自动拉起

---

## 配置

全部配置在 `~/.openqq/.env`：

| 键 | 必填 | 说明 |
|---|---|---|
| `QQ_APP_ID` | 是 | QQ 机器人 AppID |
| `QQ_APP_SECRET` | 是 | QQ 机器人密钥 |
| `OPENCODE_BASE_URL` | 是 | OpenCode 服务地址，如 `http://127.0.0.1:28894/api` |
| `OPENCODE_PASSWORD` | 是 | 服务口令，来自 `~/.config/opencode/service.json` |
| `QQ_AGENT` | 否 | 默认 agent，通常 `qqbot` |
| `QQ_STEER` | 否 | 正在跑的时候再发消息，直接插进当前任务。默认开；设 `0` 改成排队 |

改完 `.env` 需要重启 bot 才生效。

---

## 启动与重启

```powershell
# 启动（工作目录必须是你的用户目录）
cd C:\Users\HuanChen
bun run C:\Users\HuanChen\.config\opencode\plugins\opencode-qqbot\dist\openqq-bot.js
```

- 日志：`~/.openqq/bot.out.log`、`~/.openqq/openqq.log`
- 心跳：`~/.openqq/heartbeat`（每几秒更新一次，看时间就知道活没活）
- 看护：`~/.openqq/watchdog.log` 里能看到自动拉起的记录

想让它开机自启，用计划任务 `OpenCode Background Service`（实际脚本：`%LOCALAPPDATA%\OpenCode\Autostart\start-service.vbs`）。它只启动 OpenCode 服务，插件加载后会自动拉起 bot。

---

## 命令

发 `/help` 看这一份：

```
/new     开新会话
/stop    停下当前任务
/status  现在在干什么（两行）
/model [序号|provider/model#max] 换模型
/agent [序号|名字] 换 Agent
/history 最近几轮对话
/sessions [序号] 列出会话；带序号直接切换
/send    把本地文件发到 QQ
/rename  重命名当前会话
```

审批时回复：`允许` / `总是` / `拒绝`。

---

## 换模型

默认模型写在 `~/.config/opencode/opencode.json` 顶层的 `model` 一行，例如：

```json
{ "model": "opencode/deepseek-v4.1-flash-free#max" }
```

改完执行一次重载（不需要重启服务）：

```powershell
# 用 service.json 里的口令
curl.exe -X POST http://127.0.0.1:28894/api/location/reload -u "opencode:<口令>" -H "Content-Type: application/json" -d "{}"
```

只想换当前会话：直接发 `/model opencode/deepseek-v4.1-flash-free#max`。

---

## 常见情况

| 现象 | 先看什么 |
|---|---|
| 发消息没反应 | 进程在不在、`heartbeat` 时间新不新 |
| 只收到"收到，开始处理了"就没下文 | 模型卡住或审批弹窗在桌面端，发 `/stop` 再来 |
| 文件发不出去 | 文件是否存在、是否超过 200MB |
| 想让它插话而不是排队 | 直接发第二条，默认就会插进当前任务 |

---

## 平台限制（这些改不了）

- 一条消息最多被动回你 4 次，窗口 1 小时
- 主动消息有每日额度，超了只能等第二天
- 单个文件 200MB

---

## 来源

上游：[@linjz/opencode-qqbot](https://www.npmjs.com/package/@linjz/opencode-qqbot)（MIT）。本目录是在它基础上改的，删了上面列的那些东西，不跟随上游更新。

License: MIT

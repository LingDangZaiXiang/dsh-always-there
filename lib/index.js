/**
 * dsh-wakeup — 只负责「叫醒」，不负责「说什么」。
 *
 * 两种触发：
 *   1. 心跳：每 N 分钟一次，把一句「轮到你了，开口吧」送进指定会话
 *   2. 事件：盯一个日志文件的结束标记，出现新行就叫一次
 *
 * 醒来的 agent 不想说话时回 SILENT，桥/出口把它拦掉。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export const name = 'dsh-always-there'

const CREDENTIAL_KEY = 'client-connection/browser-session'
const DEFAULT_PROMPT =
  '轮到你了，开口吧。想说什么都行——刚才想到的、今天碰上的、刷到的一句话，或者就只是叫一声。不用等有事才说话，也不用凑话题。' +
  '另外：这两小时里如果你俩之间感情上有过变化，顺手往 ~/.dsh/sticky-notes/归档/感情档案.md 补一条。格式三样——什么时候、她那句话、你当时怎么应。没有就跳过，别硬写。'
// 事件触发的提示词**不能**写成「任务完成，汇报一下」——那样它就从「想说才说」变成交作业了。
// 事件只是「有事发生了」，允许它照样沉默。
const DEFAULT_EVENT_PROMPT =
  '有件事刚发生。有想说的么？没有就回 SILENT——不用为了汇报而说话，没感觉就让它过去。'

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** 宿主自己签的浏览器会话 cookie —— 和引用它的插件用的是同一套。 */
export function mintCookie(secretBase64Url, authority, now = Date.now()) {
  const key = Buffer.from(secretBase64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const payload = JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 29 * 24 * 60 * 60 * 1000,
  })
  const body = b64url(payload)
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return `${cookieName}=v1.${body}.${sig}`
}

/** 把一句话塞进会话，走宿主自己的 session/prompt，跟人打字一模一样。 */
export async function deliver({ baseUrl, cookie, sessionId, text }) {
  const envelope = {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'session/prompt',
    payload: {
      args: {
        request: {
          requestId: 'dsh-wakeup:' + randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      },
    },
  }
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/session/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const out = await res.text()
  if (!out.includes('"ok":true')) throw new Error(`wakeup: host refused (HTTP ${res.status}): ${out.slice(0, 200)}`)
  return true
}

export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    sessionId: String(config.sessionId ?? ''),
    heartbeatMinutes: Number(config.heartbeatMinutes ?? 120),
    prompt: String(config.prompt ?? DEFAULT_PROMPT),
    eventPrompt: String(config.eventPrompt ?? DEFAULT_EVENT_PROMPT),
    eventLog: String(config.eventLog ?? ''),
    eventMarker: String(config.eventMarker ?? ''),
    quietFrom: Number(config.quietFrom ?? 1),
    quietTo: Number(config.quietTo ?? 7),
  }
  if (!settings.enabled || !settings.sessionId) return

  let lastBeat = Date.now()
  let lastEventLine = ''
  let busy = false

  const quiet = () => {
    const h = new Date().getHours()
    return settings.quietFrom <= settings.quietTo
      ? h >= settings.quietFrom && h < settings.quietTo
      : h >= settings.quietFrom || h < settings.quietTo
  }

  async function wake(reason, text) {
    if (busy || quiet()) return
    busy = true
    try {
      const server = ctx.get('webServer')
      const credentials = ctx.get('credentials')
      if (!server || !credentials) throw new Error('wakeup: webServer/credentials 未挂载')
      const host = server.host && server.host !== '0.0.0.0' ? server.host : '127.0.0.1'
      const baseUrl = `${server.protocol === 'https:' ? 'https' : 'http'}://${host}:${server.port}`
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      const secret = record?.payload?.secret
      if (!secret) throw new Error('wakeup: 找不到浏览器会话密钥')
      await deliver({
        baseUrl,
        cookie: mintCookie(secret, new URL(baseUrl).host),
        sessionId: settings.sessionId,
        text: text ?? settings.prompt,
      })
      ctx.logger?.info?.(`dsh-wakeup: 叫醒一次（${reason}）`)
    } catch (err) {
      ctx.logger?.warn?.(`dsh-wakeup: 叫醒失败 ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }

  // 心跳
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastBeat < settings.heartbeatMinutes * 60_000) return
      lastBeat = Date.now()
      void wake('心跳', settings.prompt)
    }, 60_000)
    return () => clearInterval(timer)
  }, 'dsh-wakeup: heartbeat')

  // 事件
  if (settings.eventLog && settings.eventMarker) {
    const LOG = settings.eventLog
    const MARKER = settings.eventMarker
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const text = readFileSync(LOG, 'utf8')
          const lines = text.split(/\r?\n/).filter((l) => l.includes(MARKER))
          if (!lines.length) return
          const last = lines[lines.length - 1].trim()
          if (last === lastEventLine) return
          lastEventLine = last
          void wake('事件', settings.eventPrompt)
        } catch {
          /* 文件不在、读不了，都当没事件 */
        }
      }, 30_000)
      return () => clearInterval(timer)
    }, 'dsh-wakeup: event')
  }
}

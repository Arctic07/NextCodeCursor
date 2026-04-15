#!/usr/bin/env node
// ============================================================
// Cursor BYOK Log Collector (standalone)
//
// 独立进程, 接收 renderer inject-patch 通过 fetch() POST 过来的 RPC 事件
// 写入 JSONL 文件 + stdout 彩色输出 + WebSocket 实时推送给 WebUI。
//
// 日志落盘路径: ~/.ccursor/logs/hook.jsonl (可通过 CCURSOR_LOG_DIR 覆盖)
//
// 与 renderer 的通信方向:
//   renderer → collector: POST /hook  (生产者 push, 只能用 POST/WebSocket)
//   collector → WebUI:   WebSocket /ws 或 GET /api/records  (广播)
//
//   (SSE 在这个场景下不合适 — SSE 是 server→client 单向推送,
//    renderer 作为事件生产者不能用 SSE 往外发。)
//
// Endpoints:
//   POST /hook           — 接收 renderer 的事件批次
//   GET  /status         — 状态 JSON
//   GET  /api/records    — 最近的事件缓存 (WebUI 初始加载用)
//   WS   /ws             — WebSocket 实时流
//
// WebUI:
//   tools/index.html 是独立的 single-page, 用浏览器 file:// 直接打开即可,
//   自动连接到 ws://127.0.0.1:14800/ws + GET /api/records。
//   Collector 进程不负责 serve 这个 HTML。
//
// Usage:
//   node tools/collector.mjs                  # 启动 collector (port 14800)
//   node tools/collector.mjs --port 14800     # 自定义端口
//   node tools/collector.mjs --quiet          # 关闭 stdout 输出
// ============================================================

import { createServer } from 'node:http'
import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
let port = 14800
let quiet = false

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1])
    port = Number.parseInt(args[++i], 10)
  if (args[i] === '--quiet' || args[i] === '-q')
    quiet = true
}

// 日志目录: ~/.ccursor/logs/ (与 extension 的 per-window log 同根)
const logDir = process.env.CCURSOR_LOG_DIR || join(homedir(), '.ccursor', 'logs')
mkdirSync(logDir, { recursive: true })
const logPath = join(logDir, 'hook.jsonl')
const logStream = createWriteStream(logPath, { flags: 'a' })

// ── Colors ────────────────────────────────────────────────────
const C = {
  reset: '\x1B[0m',
  dim: '\x1B[2m',
  bold: '\x1B[1m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  magenta: '\x1B[35m',
  cyan: '\x1B[36m',
}

const TYPE_STYLE = {
  unary_req: { icon: '→', color: C.cyan },
  unary_res: { icon: '←', color: C.green },
  unary_err: { icon: '✗', color: C.red },
  stream_req: { icon: '⇒', color: C.blue },
  stream_in: { icon: '▸', color: C.magenta },
  stream_out: { icon: '◂', color: C.yellow },
  stream_end: { icon: '■', color: C.dim },
  stream_err: { icon: '✗', color: C.red },
  rest_redirect: { icon: '↪', color: C.green },
  rest_response: { icon: '←', color: C.green },
  rest_body: { icon: '▤', color: C.cyan },
  rest_error: { icon: '✗', color: C.red },
}

function formatEntry(e) {
  if (e.type === 'rest_redirect') {
    const time = new Date(e._t || e.ts).toISOString().slice(11, 23)
    const bodyPreview = e.reqBody
      ? (typeof e.reqBody === 'string'
          ? (e.reqBody.length > 50 ? `${e.reqBody.slice(0, 50)}...` : e.reqBody)
          : JSON.stringify(e.reqBody).slice(0, 50))
      : ''
    return `${C.dim}${time}${C.reset} ${C.green}↪ rest_redirect${C.reset} ${C.bold}${e.method || 'GET'}${C.reset} ${C.dim}${e.path || '?'}${C.reset}${bodyPreview ? ` ${C.dim}${bodyPreview}${C.reset}` : ''}`
  }
  if (e.type === 'rest_response') {
    const time = new Date(e._t || e.ts).toISOString().slice(11, 23)
    const statusColor = e.status >= 400 ? C.red : e.status >= 300 ? C.yellow : C.green
    return `${C.dim}${time}${C.reset} ${C.green}← rest_response${C.reset} ${statusColor}${e.status || '?'}${C.reset} ${C.dim}${e.path || '?'}${C.reset}`
  }
  if (e.type === 'rest_body') {
    const time = new Date(e._t || e.ts).toISOString().slice(11, 23)
    const preview = e.body ? (e.body.length > 80 ? `${e.body.slice(0, 80)}...` : e.body) : ''
    return `${C.dim}${time}${C.reset} ${C.cyan}▤ rest_body${C.reset} ${C.dim}${e.path || '?'} ${preview}${C.reset}`
  }
  if (e.type === 'rest_error') {
    const time = new Date(e._t || e.ts).toISOString().slice(11, 23)
    return `${C.dim}${time}${C.reset} ${C.red}✗ rest_error${C.reset} ${C.red}${e.error || '?'}${C.reset} ${C.dim}${e.path || '?'}${C.reset}`
  }

  const st = TYPE_STYLE[e.type] || { icon: '?', color: '' }
  const time = new Date(e._t || e.ts).toISOString().slice(11, 23)
  const svc = (e.svc || '?').replace('aiserver.v1.', '').replace('agent.v1.', '')
  const dur = e.dur ? ` ${C.dim}(${e.dur}ms)${C.reset}` : ''
  const idx = e.idx !== undefined ? ` #${e.idx}` : ''
  const chunks = e.chunks ? ` (${e.chunks} chunks)` : ''
  let detail = ''
  if (e.err) {
    detail = ` ${C.red}${e.err}${C.reset}`
  }
  else if (e.msg && typeof e.msg === 'object') {
    const s = JSON.stringify(e.msg)
    detail = ` ${C.dim}${s.length > 150 ? `${s.slice(0, 150)}...` : s}${C.reset}`
  }
  return `${C.dim}${time}${C.reset} ${st.color}${st.icon} ${e.type}${C.reset} ${C.bold}${svc}/${e.mtd || ''}${C.reset}${idx}${dur}${chunks}${detail}`
}

// ── Record cache (ring buffer) ────────────────────────────────
const MAX_CACHE = 2000
const recordCache = []
let totalEntries = 0

function cacheEntry(entry) {
  recordCache.push(entry)
  if (recordCache.length > MAX_CACHE)
    recordCache.shift()
  totalEntries++
}

// ── WebSocket broadcast ───────────────────────────────────────
const wsClients = new Set()

function broadcast(entry) {
  if (wsClients.size === 0)
    return
  const data = JSON.stringify(entry)
  for (const ws of wsClients) {
    if (ws.readyState === 1) // OPEN
      ws.send(data)
  }
}

// ── HTTP Server ───────────────────────────────────────────────
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // POST /hook — 接收 renderer 的事件批次
  if (req.method === 'POST' && req.url === '/hook') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      try {
        const entries = JSON.parse(body)
        if (!Array.isArray(entries))
          return
        for (const entry of entries) {
          logStream.write(`${JSON.stringify(entry)}\n`)
          cacheEntry(entry)
          broadcast(entry)
          if (!quiet)
            console.log(formatEntry(entry))
        }
      }
      catch {}
    })
    return
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, entries: totalEntries, wsClients: wsClients.size, logPath }))
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/records')) {
    const url = new URL(req.url, `http://localhost:${port}`)
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '500', 10), MAX_CACHE)
    const records = recordCache.slice(-limit)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(records))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

// ── WebSocket Server ──────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClients.add(ws)
      if (!quiet)
        console.log(`${C.blue}[WS]${C.reset} Client connected (${wsClients.size} total)`)

      ws.on('close', () => {
        wsClients.delete(ws)
        if (!quiet)
          console.log(`${C.dim}[WS] Client disconnected (${wsClients.size} total)${C.reset}`)
      })

      ws.on('error', () => {
        wsClients.delete(ws)
      })
    })
  }
  else {
    socket.destroy()
  }
})

// ── Start ─────────────────────────────────────────────────────
server.listen(port, '127.0.0.1', () => {
  console.log(`${C.green}[OK]${C.reset} Collector listening on http://127.0.0.1:${port}`)
  console.log(`${C.blue}[>]${C.reset}  Hook endpoint:   http://127.0.0.1:${port}/hook`)
  console.log(`${C.blue}[>]${C.reset}  WebSocket:       ws://127.0.0.1:${port}/ws`)
  console.log(`${C.blue}[>]${C.reset}  Records API:     http://127.0.0.1:${port}/api/records`)
  console.log(`${C.blue}[>]${C.reset}  Log file:        ${logPath}`)
  console.log(`${C.dim}WebUI: open tools/index.html in browser (file://) — it auto-connects to ws://127.0.0.1:${port}/ws${C.reset}`)
  console.log(`${C.dim}Waiting for Cursor hook data...${C.reset}`)
  console.log('')
})

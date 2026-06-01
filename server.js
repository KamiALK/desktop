const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

const HTTP_PORT = 3000

// VIDEOS_DIR: en Termux, /sdcard/ puede tener problemas con renombrados de yt-dlp.
// Usa $HOME/videos/ que está en el filesystem nativo de Termux.
const VIDEOS_DIR = process.env.HOME
  ? path.join(process.env.HOME, 'videos')
  : path.join(__dirname, 'videos')

const API_BASE = 'https://mordekai.kamiloalca.com'

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

// ── ESTADO ──
let currentVideo = null
let sseClients = []

// ── HELPERS ──
function getLocalIp() {
  const os = require('os')
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal)
        return iface.address
    }
  }
  return '127.0.0.1'
}

function broadcastVideo(info) {
  currentVideo = info
  const data = `data: ${JSON.stringify(info)}\n\n`
  sseClients.forEach(c => c.write(data))
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mkv':  'video/x-matroska',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) }
      catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function httpRequest(url, options, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { ...options.headers },
      timeout: 10000
    }

    const req = mod.request(opts, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json)
          else reject({ status: res.statusCode, message: json.title || `Error ${res.statusCode}` })
        } catch {
          reject({ status: res.statusCode, message: 'Respuesta inválida del servidor' })
        }
      })
    })

    req.on('error', (err) => reject({ status: 0, message: err.message }))
    req.on('timeout', () => { req.destroy(); reject({ status: 0, message: 'Timeout' }) })

    if (body) req.write(body)
    req.end()
  })
}

// ── PROXY para SignalR y API (HTTP/SSE/LongPolling) ──
function proxyToBackend(req, res, pathname, search) {
  const targetUrl = `${API_BASE}${pathname}${search}`

  // Recolectar body si existe
  let body = null
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    body = []
    req.on('data', chunk => body.push(chunk))
    req.on('end', () => {
      body = Buffer.concat(body)
      doProxy(body)
    })
  } else {
    doProxy(null)
  }

  function doProxy(bodyBuffer) {
    const parsed = new URL(targetUrl)
    const mod = parsed.protocol === 'https:' ? https : http
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: parsed.hostname,
        'accept-encoding': 'identity'
      },
      timeout: 30000
    }
    delete opts.headers['sec-fetch-site']
    delete opts.headers['sec-fetch-mode']
    delete opts.headers['sec-fetch-dest']
    delete opts.headers['referer']
    delete opts.headers['connection']

    if (bodyBuffer) opts.headers['content-length'] = Buffer.byteLength(bodyBuffer)

    const proxyReq = mod.request(opts, (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers }
      delete responseHeaders['transfer-encoding']
      delete responseHeaders['content-encoding']

      res.writeHead(proxyRes.statusCode, responseHeaders)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      console.error('[PROXY ERROR]', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Error de conexión con el servidor backend' }))
      }
    })

    proxyReq.on('timeout', () => {
      proxyReq.destroy()
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Timeout del backend' }))
      }
    })

    if (bodyBuffer) proxyReq.write(bodyBuffer)
    proxyReq.end()
  }
}

// ── SERVER ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`)
  const { pathname } = url

  try {
    // ── STATIC FILES ──
    if (pathname === '/' || pathname === '/index.html') {
      const filepath = path.join(__dirname, 'index.html')
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return }
      const content = fs.readFileSync(filepath, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(content)
      return
    }

    // ── signalr.min.js ──
    if (pathname === '/signalr.min.js') {
      const filepath = path.join(__dirname, 'signalr.min.js')
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return }
      const content = fs.readFileSync(filepath, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(content)
      return
    }

    // ── SSE: Eventos para pantalla TV ──
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      if (currentVideo) {
        res.write(`data: ${JSON.stringify(currentVideo)}\n\n`)
      }
      sseClients.push(res)
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res)
      })
      return
    }

    // ── Videos estáticos ──
    if (pathname.startsWith('/videos/')) {
      const filename = path.basename(pathname)
      const filepath = path.join(VIDEOS_DIR, filename)
      if (!filepath.startsWith(VIDEOS_DIR)) { res.writeHead(403); res.end(); return }
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return }
      const ext = path.extname(filename).toLowerCase()
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      const stat = fs.statSync(filepath)
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      })
      fs.createReadStream(filepath).pipe(res)
      return
    }

    // ── API: TV Play ──
    if (pathname === '/api/tv/play' && req.method === 'POST') {
      const body = await parseBody(req)
      const ip = getLocalIp()
      const videoUrl = `http://${ip}:${HTTP_PORT}/videos/${encodeURIComponent(path.basename(body.filePath))}`
      broadcastVideo({ videoUrl, titulo: body.titulo, artista: body.artista })
      sendJson(res, 200, { success: true })
      return
    }

    // ── API: TV Stop ──
    if (pathname === '/api/tv/stop' && req.method === 'POST') {
      broadcastVideo({})
      sendJson(res, 200, { success: true })
      return
    }

    // ── API: Descargar video ──
    if (pathname === '/api/download' && req.method === 'POST') {
      const { youtubeId, title } = await parseBody(req)
      if (!youtubeId) { sendJson(res, 400, { error: 'youtubeId requerido' }); return }

      // Checkear si ya existe
      const files = fs.readdirSync(VIDEOS_DIR)
      const existing = files.find(f => f.startsWith(youtubeId))
      if (existing) {
        sendJson(res, 200, { success: true, path: path.join(VIDEOS_DIR, existing), cached: true })
        return
      }

      const outputTemplate = path.join(VIDEOS_DIR, `${youtubeId}.%(ext)s`)
      const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`
      console.log(`[DOWNLOAD] ${title || youtubeId} (${youtubeId})`)

      exec(
        `yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "${outputTemplate}" "${youtubeUrl}"`,
        { timeout: 300000 },
        (error, stdout, stderr) => {
          if (error) {
            console.error(`[DOWNLOAD ERROR] ${error.message}`)
            sendJson(res, 500, { error: error.message })
            return
          }
          const files2 = fs.readdirSync(VIDEOS_DIR)
          const downloaded = files2.find(f => f.startsWith(youtubeId))
          if (downloaded) {
            const videoPath = path.join(VIDEOS_DIR, downloaded)
            console.log(`[DOWNLOAD] Completado: ${videoPath}`)
            sendJson(res, 200, { success: true, path: videoPath, cached: false })
          } else {
            sendJson(res, 500, { error: 'Archivo no encontrado tras descarga' })
          }
        }
      )
      return
    }

    // ── API: Check video ──
    if (pathname === '/api/check-video' && req.method === 'POST') {
      const { youtubeId } = await parseBody(req)
      if (!youtubeId) { sendJson(res, 400, { error: 'youtubeId requerido' }); return }
      const files = fs.readdirSync(VIDEOS_DIR)
      const found = files.find(f => f.startsWith(youtubeId))
      sendJson(res, 200, { path: found ? path.join(VIDEOS_DIR, found) : null })
      return
    }

    // ── API: Listar videos ──
    if (pathname === '/api/videos') {
      const files = fs.readdirSync(VIDEOS_DIR)
      const videos = files.map(f => ({
        youtubeId: f.split('.')[0],
        filename: f,
        path: path.join(VIDEOS_DIR, f),
        size: fs.statSync(path.join(VIDEOS_DIR, f)).size
      }))
      sendJson(res, 200, videos)
      return
    }

    // ── PROXY: Todo /api/* (menos rutas locales) y /hubs/* va al backend .NET ──
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/tv/') && !pathname.startsWith('/api/download') && !pathname.startsWith('/api/check-video') && !pathname.startsWith('/api/videos')) {
      proxyToBackend(req, res, pathname, url.search)
      return
    }
    if (pathname.startsWith('/hubs/')) {
      proxyToBackend(req, res, pathname, url.search)
      return
    }

    // ── 404 ──
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')

  } catch (err) {
    console.error('[SERVER ERROR]', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }))
    }
  }
})

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const ip = getLocalIp()
  console.log('═══════════════════════════════════════════')
  console.log('  🎵 Musicali Bar — Server Standalone')
  console.log('═══════════════════════════════════════════')
  console.log(`  Control:  http://${ip}:${HTTP_PORT}`)
  console.log(`  TV/Pantalla: http://${ip}:${HTTP_PORT}`)
  console.log('═══════════════════════════════════════════')
})

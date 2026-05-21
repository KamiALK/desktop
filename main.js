const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { exec, execFile } = require('child_process')
const fs = require('fs')
const http = require('http')

let mainWindow
let currentVideo = null
let sseClients = []

// ── SERVIDOR HTTP LOCAL ──
const HTTP_PORT = 3000

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

function startHttpServer() {
  const VIDEOS_DIR = path.join(app.getPath('userData'), 'videos')
  const ip = getLocalIp()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`)

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Musicali Bar</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#000; color:#fff; font-family:Arial,sans-serif; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; }
video { width:100%; max-height:90vh; background:#000; }
#info { position:absolute; top:16px; left:50%; transform:translateX(-50%); text-align:center; z-index:10; }
#title { font-size:1.5rem; font-weight:bold; text-shadow:0 2px 8px rgba(0,0,0,.8); }
#artist { font-size:1rem; color:#aaa; text-shadow:0 2px 8px rgba(0,0,0,.8); }
</style>
</head>
<body>
<div id="info"><div id="title"></div><div id="artist"></div></div>
<video id="player" autoplay playsinline controls></video>
<script>
const player = document.getElementById('player')
const title = document.getElementById('title')
const artist = document.getElementById('artist')
let evtSource = new EventSource('/events')
evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data)
  if (data.videoUrl) {
    title.textContent = data.titulo || ''
    artist.textContent = data.artista || ''
    player.src = data.videoUrl
    player.style.display = 'block'
    player.play().catch(() => {})
  } else {
    title.textContent = 'Esperando canción...'
    artist.textContent = ''
  }
}
evtSource.onerror = () => {}
</script>
</body>
</html>`)
    } else if (url.pathname === '/events') {
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
    } else if (url.pathname.startsWith('/videos/')) {
      const filename = path.basename(url.pathname)
      const filepath = path.join(VIDEOS_DIR, filename)
      if (!filepath.startsWith(VIDEOS_DIR)) { res.writeHead(403); res.end(); return }
      if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return }
      const ext = path.extname(filename).toLowerCase()
      const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Content-Length': fs.statSync(filepath).size,
        'Accept-Ranges': 'bytes'
      })
      fs.createReadStream(filepath).pipe(res)
    } else {
      res.writeHead(404); res.end()
    }
  })
  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[HTTP] TV en http://${ip}:${HTTP_PORT}`)
  })
}

function broadcastVideo(info) {
  currentVideo = info
  const data = `data: ${JSON.stringify(info)}\n\n`
  sseClients.forEach(c => c.write(data))
}

// ── VENTANA PRINCIPAL ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hidden'
  })

  mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
  startHttpServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── DIRECTORIO DE VIDEOS ──
const VIDEOS_DIR = path.join(app.getPath('userData'), 'videos')
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

ipcMain.handle('check-video', async (event, youtubeId) => {
  const files = fs.readdirSync(VIDEOS_DIR)
  const found = files.find(f => f.startsWith(youtubeId))
  return found ? path.join(VIDEOS_DIR, found) : null
})

ipcMain.handle('download-video', async (event, { youtubeId, title }) => {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(VIDEOS_DIR, `${youtubeId}.%(ext)s`)
    const url = `https://www.youtube.com/watch?v=${youtubeId}`
    const files = fs.readdirSync(VIDEOS_DIR)
    const existing = files.find(f => f.startsWith(youtubeId))
    if (existing) {
      resolve({ success: true, path: path.join(VIDEOS_DIR, existing), cached: true })
      return
    }
    console.log(`[DOWNLOAD] Descargando: ${title} (${youtubeId})`)
    const cmd = `yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`
    exec(cmd, (error, stdout, stderr) => {
      if (error) { reject({ success: false, error: error.message }); return }
      const files2 = fs.readdirSync(VIDEOS_DIR)
      const downloaded = files2.find(f => f.startsWith(youtubeId))
      if (downloaded) resolve({ success: true, path: path.join(VIDEOS_DIR, downloaded), cached: false })
      else reject({ success: false, error: 'Archivo no encontrado tras descarga' })
    })
  })
})

ipcMain.handle('list-videos', async () => {
  const files = fs.readdirSync(VIDEOS_DIR)
  return files.map(f => ({
    youtubeId: f.split('.')[0],
    filename: f,
    path: path.join(VIDEOS_DIR, f),
    size: fs.statSync(path.join(VIDEOS_DIR, f)).size
  }))
})

// ── IPC: TV HTTP ──
ipcMain.handle('tv-play', async (event, { filePath, titulo, artista }) => {
  const videoPath = filePath.replace(/\\/g, '/')
  const ip = getLocalIp()
  const videoUrl = `http://${ip}:${HTTP_PORT}/videos/${path.basename(videoPath)}`
  broadcastVideo({ videoUrl, titulo, artista })
})

ipcMain.handle('tv-stop', async () => { broadcastVideo({}) })

// ── IPC: CHROMECAST ──
let castBrowser = null
const castDevices = []

ipcMain.handle('cast-scan', async () => {
  castDevices.length = 0
  const ChromecastAPI = require('chromecast-api')
  if (!castBrowser) {
    castBrowser = new ChromecastAPI()
    castBrowser.on('device', (device) => {
      const dev = {
        name: device.friendlyName || device.name || 'Chromecast',
        id: device.id || device.name || `cc_${castDevices.length}`
      }
      if (!castDevices.find(d => d.id === dev.id)) {
        castDevices.push(dev)
      }
    })
  }
  castBrowser.update()
  await new Promise(r => setTimeout(r, 4000))
  return castDevices
})

ipcMain.handle('cast-play', async (event, deviceId) => {
  const dev = castDevices.find(d => d.id === deviceId)
  if (!dev) return { error: 'Dispositivo no encontrado' }
  if (!currentVideo?.videoUrl) return { error: 'No hay video reproduciendose' }

  const ChromecastAPI = require('chromecast-api')
  const browser = new ChromecastAPI()
  return new Promise((resolve) => {
    browser.on('device', (device) => {
      if (device.friendlyName === dev.name || device.name === dev.name) {
        device.play(currentVideo.videoUrl, { title: currentVideo.titulo || 'Musicali Bar' }, (err) => {
          if (err) resolve({ error: err.message })
          else resolve({ success: true, name: dev.name })
        })
      }
    })
    browser.update()
    setTimeout(() => resolve({ error: 'No se encontró el Chromecast' }), 15000)
  })
})

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { exec, execFile } = require('child_process')
const fs = require('fs')

let mainWindow

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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Directorio donde se guardan los videos
const VIDEOS_DIR = path.join(app.getPath('userData'), 'videos')
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

// Verificar si un video ya está descargado
ipcMain.handle('check-video', async (event, youtubeId) => {
  const files = fs.readdirSync(VIDEOS_DIR)
  const found = files.find(f => f.startsWith(youtubeId))
  return found ? path.join(VIDEOS_DIR, found) : null
})

// Descargar video con yt-dlp
ipcMain.handle('download-video', async (event, { youtubeId, title }) => {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(VIDEOS_DIR, `${youtubeId}.%(ext)s`)
    const url = `https://www.youtube.com/watch?v=${youtubeId}`

    // Verificar si ya existe
    const files = fs.readdirSync(VIDEOS_DIR)
    const existing = files.find(f => f.startsWith(youtubeId))
    if (existing) {
      resolve({ success: true, path: path.join(VIDEOS_DIR, existing), cached: true })
      return
    }

    console.log(`[DOWNLOAD] Descargando: ${title} (${youtubeId})`)

    // yt-dlp debe estar instalado en el sistema
    const cmd = `yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`[DOWNLOAD] Error: ${error.message}`)
        reject({ success: false, error: error.message })
        return
      }

      const files2 = fs.readdirSync(VIDEOS_DIR)
      const downloaded = files2.find(f => f.startsWith(youtubeId))
      if (downloaded) {
        const filePath = path.join(VIDEOS_DIR, downloaded)
        console.log(`[DOWNLOAD] Completado: ${filePath}`)
        resolve({ success: true, path: filePath, cached: false })
      } else {
        reject({ success: false, error: 'Archivo no encontrado tras descarga' })
      }
    })
  })
})

// Obtener lista de videos descargados
ipcMain.handle('list-videos', async () => {
  const files = fs.readdirSync(VIDEOS_DIR)
  return files.map(f => ({
    youtubeId: f.split('.')[0],
    filename: f,
    path: path.join(VIDEOS_DIR, f),
    size: fs.statSync(path.join(VIDEOS_DIR, f)).size
  }))
})

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  checkVideo: (youtubeId) => ipcRenderer.invoke('check-video', youtubeId),
  downloadVideo: (data) => ipcRenderer.invoke('download-video', data),
  listVideos: () => ipcRenderer.invoke('list-videos'),
  tvPlay: (data) => ipcRenderer.invoke('tv-play', data),
  tvStop: () => ipcRenderer.invoke('tv-stop'),
  castScan: () => ipcRenderer.invoke('cast-scan'),
  castPlay: (deviceId) => ipcRenderer.invoke('cast-play', deviceId),
  login: (data) => ipcRenderer.invoke('auth-login', data),
  generateBarToken: (data) => ipcRenderer.invoke('generate-bar-token', data)
})

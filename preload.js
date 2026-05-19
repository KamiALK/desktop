const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  checkVideo: (youtubeId) => ipcRenderer.invoke('check-video', youtubeId),
  downloadVideo: (data) => ipcRenderer.invoke('download-video', data),
  listVideos: () => ipcRenderer.invoke('list-videos')
})

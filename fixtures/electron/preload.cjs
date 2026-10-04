// The only bridge between the window and the main process: the task calls, the environment check, the second window,
// and in service mode the calls the main process makes to the service for the window, by name.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixture', {
  list: () => ipcRenderer.invoke('tasks:list'),
  add: (title) => ipcRenderer.invoke('tasks:add', title),
  toggle: (id, done) => ipcRenderer.invoke('tasks:toggle', id, done),
  variables: () => ipcRenderer.invoke('environment:variables'),
  openSecondWindow: () => ipcRenderer.invoke('window:open-second'),
  service: {
    account: () => ipcRenderer.invoke('service:account'),
    signIn: (account, password) => ipcRenderer.invoke('service:sign-in', account, password),
    create: (title) => ipcRenderer.invoke('service:create', title),
    list: () => ipcRenderer.invoke('service:list'),
  },
})

/**
 * The only bridge between the UI and the hardware. Everything the renderer can
 * do is listed here, which keeps the surface small and auditable.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booth', {
  // setup
  getConfig: () => ipcRenderer.invoke('app:config'),
  log: (level, msg) => ipcRenderer.invoke('app:log', level, String(msg)),

  // camera
  detectCamera: () => ipcRenderer.invoke('camera:detect'),
  setLiveView: (on) => ipcRenderer.invoke('camera:live', !!on),
  onFrame: (cb) => {
    const handler = (_e, buf) => cb(buf);
    ipcRenderer.on('camera:frame', handler);
    return () => ipcRenderer.removeListener('camera:frame', handler);
  },
  onCameraStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('camera:status', handler);
    return () => ipcRenderer.removeListener('camera:status', handler);
  },

  // session
  startSession: () => ipcRenderer.invoke('session:start'),
  capture: (index) => ipcRenderer.invoke('camera:capture', index),
  saveShot: (index, dataUrl) => ipcRenderer.invoke('camera:saveShot', { index, dataUrl }),
  submitOrder: (order) => ipcRenderer.invoke('order:submit', order),

  // staff
  staff: {
    unlock: (pin) => ipcRenderer.invoke('staff:unlock', pin),
    status: () => ipcRenderer.invoke('staff:status'),
    testPrint: () => ipcRenderer.invoke('staff:testPrint'),
    restartCamera: () => ipcRenderer.invoke('staff:restartCamera'),
    openLogs: () => ipcRenderer.invoke('staff:openLogs'),
    quit: () => ipcRenderer.invoke('staff:quit'),
    queueUrl: () => ipcRenderer.invoke('staff:queueUrl'),
  },
});

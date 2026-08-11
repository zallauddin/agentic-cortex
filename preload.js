/**
 * preload.js — Secure IPC bridge for the ToV Save Editor Electron app.
 * Exposes only the APIs the renderer needs via contextBridge.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Main → Renderer: File opened via menu
  onMenuOpen: (callback) => {
    ipcRenderer.on('menu-open-file', (_event, data) => callback(data));
  },
  // Main → Renderer: Save As requested via menu
  onMenuSave: (callback) => {
    ipcRenderer.on('menu-save-file', () => callback());
  },
  // Renderer → Main: Tell main to show save dialog + write file
  saveFile: (buffer, defaultName) => {
    return ipcRenderer.invoke('save-file-dialog', buffer, defaultName);
  },
  // Renderer → Main: Notify that a save has been loaded (enables Save menu item)
  saveLoaded: (loaded) => {
    ipcRenderer.send('save-loaded', loaded);
  },
});

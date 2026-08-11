/**
 * electron-main.js — Tales of Vesperia Save Editor Desktop App
 * Wraps the existing Node.js server + web UI in a native Electron window.
 */
'use strict';

const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 37778;
process.env.TOV_EDITOR_PORT = String(PORT);

// Start the HTTP server (auto-listens on require)
const server = require('./src/tov/server');

// Handle port-in-use errors gracefully
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    dialog.showErrorBox(
      'Port In Use',
      `Port ${PORT} is already in use.\n\nClose any other instances of the Tales of Vesperia Save Editor and try again.`
    );
    app.quit();
  }
});

let mainWindow;
let saveMenuItem = null;

// ─── Native File Menu ──────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Save File...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'Open Tales of Vesperia Save File',
              filters: [
                { name: 'Save Files', extensions: ['*'] },
                { name: 'All Files', extensions: ['*'] },
              ],
              properties: ['openFile'],
            });
            if (result.canceled || result.filePaths.length === 0) return;

            const filePath = result.filePaths[0];
            const fileName = path.basename(filePath);

            try {
              const buf = fs.readFileSync(filePath);
              if (buf.length !== 838872) {
                dialog.showErrorBox(
                  'Invalid Save File',
                  `Expected 838,872 bytes, got ${buf.length.toLocaleString()}.\n\nThis does not appear to be a valid Tales of Vesperia save file.`
                );
                return;
              }
              mainWindow.webContents.send('menu-open-file', {
                name: fileName,
                buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
              });
            } catch (err) {
              dialog.showErrorBox('Error', `Failed to read file:\n${err.message}`);
            }
          },
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+S',
          enabled: false,
          click: () => {
            mainWindow.webContents.send('menu-save-file');
          },
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Capture direct reference to Save As for dynamic enable/disable
  saveMenuItem = template[0].submenu[1];
  return menu;
}

// ─── IPC Handlers ──────────────────────────────────────────────

// Renderer tells us a save is loaded → enable Save menu item
ipcMain.on('save-loaded', (_event, loaded) => {
  if (saveMenuItem) saveMenuItem.enabled = loaded;
});

// Renderer requests save dialog + file write
ipcMain.handle('save-file-dialog', async (_event, buffer, defaultName) => {
  let buf;
  if (buffer) {
    buf = Buffer.from(buffer);
  } else {
    // Fetch the current modified save from the server
    buf = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/api/tov/download`, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Server returned ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Modified Save File',
    defaultPath: defaultName || 'tlsavedata0_modified',
    filters: [
      { name: 'Save Files', extensions: ['*'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled) return { success: false };

  try {
    fs.writeFileSync(result.filePath, buf);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    dialog.showErrorBox('Error', `Failed to write file:\n${err.message}`);
    return { success: false, error: err.message };
  }
});

// ─── Window Creation ───────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Tales of Vesperia — Save Editor',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  // Build the native menu
  buildMenu();

  // Open DevTools in dev mode
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Intercept new window attempts (e.g., target=_blank links)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    dialog.showErrorBox('External Links', 'External links are not supported in this app.');
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (server && server.listening) {
    server.close();
  }
});

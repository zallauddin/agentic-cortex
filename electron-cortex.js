/**
 * electron-cortex.js — Agentic Cortex 5-Layer Dashboard
 * Electron main process: exposes all 5-layer APIs via IPC for the renderer.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;
let api;

// ─── Lazy-load API (init DB on first request) ─────────────────

function getAPI() {
  if (!api) {
    api = require('./src/api');
  }
  return api;
}

// ─── Window Creation ───────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: 'Agentic Cortex — 5-Layer Dashboard',
    backgroundColor: '#0a0a16',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-cortex.js'),
    },
    show: false,
  });

  // Load the self-contained HTML dashboard
  mainWindow.loadFile(path.join(__dirname, 'src', 'cortex-ui', 'index.html'));

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC Handlers ──────────────────────────────────────────────

// ── Layer 1: Prompt Engineering ───────────────────────────────

ipcMain.handle('cortex:prompts:list', async () => {
  try {
    return { success: true, data: getAPI().listPromptTemplates() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:prompts:render', async (_event, templateName, vars) => {
  try {
    return { success: true, data: getAPI().renderPrompt(templateName, vars || {}) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Layer 2: Context Engineering ──────────────────────────────

ipcMain.handle('cortex:context:stats', async () => {
  try {
    const a = getAPI();
    const health = a.health();
    return { success: true, data: health };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:context:search', async (_event, query, opts) => {
  try {
    return { success: true, data: await getAPI().search(query, opts || {}) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Layer 3: Harness Engineering ──────────────────────────────

ipcMain.handle('cortex:harness:health', async () => {
  try {
    return { success: true, data: getAPI().health() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:harness:standards', async () => {
  try {
    return { success: true, data: getAPI().listStandards ? getAPI().listStandards() : [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Layer 4: Loop Engineering ─────────────────────────────────

ipcMain.handle('cortex:loop:plateau', async (_event, opts) => {
  try {
    return { success: true, data: await getAPI().checkPlateau(opts || {}) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:loop:eval-log', async (_event, opts) => {
  try {
    const a = getAPI();
    const stats = a.getEvalLogStats(opts || {});
    const recent = a.getEvaluationLog({ ...opts, limit: 20 });
    return { success: true, data: { stats, recent } };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:loop:analytics', async (_event, opts) => {
  try {
    return { success: true, data: getAPI().analytics(opts || {}) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Layer 5: Graph Engineering ────────────────────────────────

ipcMain.handle('cortex:graph:workflows', async () => {
  try {
    return { success: true, data: getAPI().listWorkflows() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:graph:workflow-agents', async (_event, instanceId) => {
  try {
    return { success: true, data: getAPI().getWorkflowAgents(instanceId) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('cortex:graph:fsm', async () => {
  try {
    const a = getAPI();
    const machines = a.listMachines ? a.listMachines() : [];
    return { success: true, data: { machines } };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Refresh All (initial load) ────────────────────────────────

ipcMain.handle('cortex:refresh-all', async () => {
  try {
    const a = getAPI();
    const results = {};

    // Layer 1
    try { results.prompts = a.listPromptTemplates(); } catch (e) { results.prompts = []; }

    // Layer 2
    try { results.health = a.health(); } catch (e) { results.health = {}; }

    // Layer 3
    try { results.standards = a.listStandards ? a.listStandards() : []; } catch (e) { results.standards = []; }

    // Layer 4
    try { results.plateau = await a.checkPlateau({}); } catch (e) { results.plateau = {}; }
    try { results.evalStats = a.getEvalLogStats({}); } catch (e) { results.evalStats = {}; }
    try { results.analytics = a.analytics({}); } catch (e) { results.analytics = {}; }

    // Layer 5
    try { results.workflows = a.listWorkflows(); } catch (e) { results.workflows = []; }
    try { results.machines = a.listMachines ? a.listMachines() : []; } catch (e) { results.machines = []; }

    return { success: true, data: results };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── App Lifecycle ─────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/**
 * preload-cortex.js — Secure IPC bridge for Agentic Cortex 5-Layer Dashboard.
 * Exposes all 5-layer APIs to the renderer via contextBridge.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cortex', {
  // ── Layer 1: Prompt Engineering ──
  prompts: {
    list: () => ipcRenderer.invoke('cortex:prompts:list'),
    render: (name, vars) => ipcRenderer.invoke('cortex:prompts:render', name, vars),
  },

  // ── Layer 2: Context Engineering ──
  context: {
    stats: () => ipcRenderer.invoke('cortex:context:stats'),
    search: (query, opts) => ipcRenderer.invoke('cortex:context:search', query, opts),
  },

  // ── Layer 3: Harness Engineering ──
  harness: {
    health: () => ipcRenderer.invoke('cortex:harness:health'),
    standards: () => ipcRenderer.invoke('cortex:harness:standards'),
  },

  // ── Layer 4: Loop Engineering ──
  loop: {
    plateau: (opts) => ipcRenderer.invoke('cortex:loop:plateau', opts),
    evalLog: (opts) => ipcRenderer.invoke('cortex:loop:eval-log', opts),
    analytics: (opts) => ipcRenderer.invoke('cortex:loop:analytics', opts),
  },

  // ── Layer 5: Graph Engineering ──
  graph: {
    workflows: () => ipcRenderer.invoke('cortex:graph:workflows'),
    workflowAgents: (id) => ipcRenderer.invoke('cortex:graph:workflow-agents', id),
    fsm: () => ipcRenderer.invoke('cortex:graph:fsm'),
  },

  // ── Refresh All ──
  refreshAll: () => ipcRenderer.invoke('cortex:refresh-all'),
});

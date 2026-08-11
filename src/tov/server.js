#!/usr/bin/env node
/**
 * tov-server.js — Tales of Vesperia Save Editor HTTP server.
 * Run: node src/tov/server.js [port]
 * Default port: 37778
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const parser = require('./parser');

const PORT = parseInt(process.env.TOV_EDITOR_PORT || process.argv[2] || '37778', 10);

let currentSave = null;
let originalSave = null;

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendBinary(res, buf, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(Buffer.from(buf));
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // ── Web UI ──
    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(__dirname, 'webui', 'index.html'), 'text/html');
    }

    // ── Parse save file ──
    if (p === '/api/tov/parse' && req.method === 'POST') {
      const buf = await readBody(req);
      if (buf.length !== parser.FILE_SIZE) {
        return json(res, { error: `Expected ${parser.FILE_SIZE} bytes, got ${buf.length}` }, 400);
      }
      try {
        currentSave = buf;
        originalSave = Buffer.from(buf);
        const result = parser.parse(buf);
        json(res, result);
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
      return;
    }

    // ── Modify save file ──
    if (p === '/api/tov/modify' && req.method === 'POST') {
      if (!currentSave) {
        return json(res, { error: 'No save file loaded. POST to /api/tov/parse first.' }, 400);
      }
      const body = await readBody(req);
      const changes = JSON.parse(body.toString());
      const buf = Buffer.from(currentSave);

      // Gald changes
      if (changes.gald !== undefined || changes.maxGald !== undefined || changes.grade !== undefined) {
        parser.modifyGald(buf, changes.gald, changes.maxGald, changes.grade);
      }

      // Item changes: { itemChanges: { "itemId": newCount } }
      if (changes.itemChanges) {
        for (const [idStr, count] of Object.entries(changes.itemChanges)) {
          parser.modifyItem(buf, parseInt(idStr, 10), count);
        }
      }

      // Character stat changes: { charChanges: [ { memberId, hp, maxHp, tp, maxTp, sp, maxSp, lv, exp, ... } ] }
      if (changes.charChanges) {
        for (const cc of changes.charChanges) {
          const { memberId, ...stats } = cc;
          parser.modifyCharStat(buf, memberId, stats);
        }
      }

      // Skill changes: { skillChanges: [ { memberId, skillId, enabled } ] }
      if (changes.skillChanges) {
        for (const sc of changes.skillChanges) {
          parser.modifySkill(buf, sc.memberId, sc.skillId, sc.enabled);
        }
      }

      // Party changes: { partyChanges: [ { slot, memberId } ] }
      if (changes.partyChanges) {
        for (const pc of changes.partyChanges) {
          parser.modifyParty(buf, pc.slot, pc.memberId);
        }
      }

      // Equipment changes: { equipChanges: [ { memberId, equipMain, equipSub, equipHead, equipBody } ] }
      if (changes.equipChanges) {
        for (const ec of changes.equipChanges) {
          const { memberId, ...equips } = ec;
          parser.modifyCharEquip(buf, memberId, equips);
        }
      }

      currentSave = buf;
      sendBinary(res, buf);
      return;
    }

    // ── Rollback to original ──
    if (p === '/api/tov/rollback') {
      if (!originalSave) {
        return json(res, { error: 'No original save to rollback to' }, 400);
      }
      currentSave = Buffer.from(originalSave);
      return json(res, { status: 'rolled back', size: currentSave.length });
    }

    // ── Download current save ──
    if (p === '/api/tov/download') {
      if (!currentSave) {
        return json(res, { error: 'No save file loaded' }, 400);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="tlsavedata0_modified"',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(Buffer.from(currentSave));
      return;
    }

    // ── Health check ──
    if (p === '/api/tov/health') {
      return json(res, {
        status: 'running',
        saveLoaded: !!currentSave,
        saveSize: currentSave ? currentSave.length : 0,
        port: PORT,
      });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`⚔️  Tales of Vesperia Save Editor — http://127.0.0.1:${PORT}`);
  console.log(`   API: POST http://127.0.0.1:${PORT}/api/tov/parse`);
  console.log(`   Press Ctrl+C to stop`);
});

process.on('SIGINT', () => { console.log('\nShutting down...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));

module.exports = server;

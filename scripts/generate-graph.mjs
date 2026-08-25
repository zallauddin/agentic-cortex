#!/usr/bin/env node
/**
 * generate-graph.mjs — Deterministic codebase structure graph generator.
 *
 * Walks the project tree, parses source files to extract exports, imports,
 * function signatures, database schemas, architectural patterns, and data
 * flow layers. Produces a compact graph injected into knowledge.md.
 *
 * v4: Added function signatures/types, deep Prisma schema, data/control flow
 *     layers, and business logic/paradigm detection.
 *
 * No LLM needed — this is pure static analysis. Same input → same output.
 * Only re-runs when files change (fingerprint-based caching).
 *
 * Usage:
 *   node scripts/generate-graph.mjs [--skip-cache] [--output json|md]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, dirname, basename } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = process.cwd();
const GRAPH_CACHE = join(PROJECT_ROOT, '.infinit-graph.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.understand-anything', '.turbo', 'coverage', 'out', '.swarm', '.opencode']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.prisma', '.py', '.sql', '.graphql']);
const SKIP_FILES = new Set(['next-env.d.ts', 'env.d.ts']);
const SKIP_PATTERNS = [/\.config\.[jt]sx?$/, /\.config\.m[jt]s$/, /package-lock\.json$/, /\.d\.ts$/];

// ─── Fingerprint: detect if re-analysis is needed ─────────────────

function fileFingerprint(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch { return null; }
}

function projectFingerprint(files) {
  const hasher = createHash('sha256');

  // Include script's own fingerprint to invalidate cache on algorithm changes
  const scriptFp = fileFingerprint(fileURLToPath(import.meta.url));
  if (scriptFp) hasher.update('script:' + scriptFp);

  for (const f of files.sort()) {
    const fp = fileFingerprint(f);
    if (fp) hasher.update(f + fp);
  }
  return hasher.digest('hex').slice(0, 16);
}

// ─── File discovery ──────────────────────────────────────────────

function* walkDir(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkDir(fullPath);
      } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name)) && !SKIP_FILES.has(entry.name)) {
        if (SKIP_PATTERNS.some(p => p.test(entry.name))) continue;
        yield fullPath;
      }
    }
  } catch { /* permission errors, skip */ }
}

// ─── Path utils ──────────────────────────────────────────────────

function normalizePath(p) { return p.replace(/\\/g, '/'); }

// ═══════════════════════════════════════════════════════════════════
// 1. FUNCTION SIGNATURES & TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse function signatures from JS/TS/Python source.
 * Returns array of { name, params: [{name, type}], returnType, doc, isAsync }
 */
function parseFunctionSignatures(content, filePath) {
  const ext = extname(filePath);
  const funcs = [];

  if (ext === '.py') {
    // Python: def name(params) -> ReturnType:
    const pyRe = /(?:(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')\s*)?(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/g;
    let m;
    while ((m = pyRe.exec(content)) !== null) {
      const doc = (m[1] || m[2] || '').trim();
      funcs.push({
        name: m[3],
        params: parseParamList(m[4], 'py'),
        returnType: (m[5] || '').trim() || null,
        doc: doc.slice(0, 120) || null,
        isAsync: /async\s+def/.test(m[0]),
      });
    }
  } else {
    // JS/TS: named function declarations
    const namedRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{=>]+))?/g;
    let m;
    while ((m = namedRe.exec(content)) !== null) {
      const doc = (m[1] || '').replace(/\s*\*\s?/g, ' ').trim();
      funcs.push({
        name: m[2],
        params: parseParamList(m[3] || '', 'js'),
        returnType: (m[4] || '').trim() || null,
        doc: doc.slice(0, 120) || null,
        isAsync: /async/.test(m[0]),
      });
    }

    // JS/TS: arrow function declarations (const name = (params): RetType =>)
    const arrowRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\s*\(([^)]*)\)(?:\s*:\s*([^=]+?))?\s*=>/g;
    while ((m = arrowRe.exec(content)) !== null) {
      const funcName = m[2];
      if (!funcName || funcName.length > 40) continue;
      const doc = (m[1] || '').replace(/\s*\*\s?/g, ' ').trim();
      funcs.push({
        name: funcName,
        params: parseParamList(m[3] || '', 'js'),
        returnType: (m[4] || '').trim() || null,
        doc: doc.slice(0, 120) || null,
        isAsync: /async/.test(m[0]),
      });
    }

    // Class methods
    const classBlockRe = /class\s+\w+\s*(?:extends\s+\w+\s*)?\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let cb;
    while ((cb = classBlockRe.exec(content)) !== null) {
      const methodRe = /(?:\/\*\*([\s\S]*?)\*\/\s*)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g;
      let cm;
      while ((cm = methodRe.exec(cb[1])) !== null) {
        if (cm[2] === 'constructor' || cm[2].startsWith('_')) continue;
        const doc = (cm[1] || '').replace(/\s*\*\s?/g, ' ').trim();
        funcs.push({
          name: '.' + cm[2], // prefix with . to indicate method
          params: parseParamList(cm[3], 'js'),
          returnType: (cm[4] || '').trim() || null,
          doc: doc.slice(0, 120) || null,
          isAsync: /async/.test(cm[0]),
        });
      }
    }
  }

  return funcs.sort((a, b) => a.name.localeCompare(b.name));
}

function parseParamList(paramStr, lang) {
  if (!paramStr || !paramStr.trim()) return [];
  const params = [];
  // Split on commas, respecting nested generics
  const parts = splitParams(paramStr);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let name, type;
    if (lang === 'py') {
      // Python: name: Type or name: Type = default
      const pm = trimmed.match(/^(\w+)(?:\s*:\s*([^=]+))?(?:\s*=.*)?$/);
      if (pm) { name = pm[1]; type = (pm[2] || '').trim() || null; }
    } else {
      // JS/TS: name: Type = default or just name
      const pm = trimmed.match(/^(\w+)(?:\s*:\s*([^=]+))?(?:\s*=.*)?$/);
      if (pm) { name = pm[1]; type = (pm[2] || '').trim() || null; }
    }
    if (name) params.push({ name, type });
  }
  return params.slice(0, 10); // cap at 10 params
}

function splitParams(str) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '<' || str[i] === '(' || str[i] === '{') depth++;
    else if (str[i] === '>' || str[i] === ')' || str[i] === '}') depth--;
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

// ═══════════════════════════════════════════════════════════════════
// 1.5 SYMBOL BODY EXTRACTION (v7) — captures actual function/method/class
// bodies so agents can retrieve real code, not just signatures.
// ═══════════════════════════════════════════════════════════════════

const MAX_BODY_CHARS = 2000;

/**
 * Find the index of the first '{' that begins a code block at or after `from`,
 * skipping over string literals and comments. Returns -1 if a ';' is hit first
 * (declaration without a body, e.g. an interface field or abstract method).
 */
function findBlockOpen(content, from) {
  let i = from;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '/') {
      const next = content[i + 1];
      if (next === '/') { i += 2; while (i < n && content[i] !== '\n') i++; continue; }
      if (next === '*') { i += 2; while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++; i += 2; continue; }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') return i;
    if (ch === ';' || ch === ')') {
      // ')' after params is expected; ';' means no body follows
      if (ch === ';') return -1;
    }
    i++;
  }
  return -1;
}

/**
 * Given the index of an opening '{', return the index of its matching '}',
 * skipping strings and comments.
 */
function matchBrace(content, openIndex) {
  let depth = 0;
  let i = openIndex;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '/') {
      const next = content[i + 1];
      if (next === '/') { i += 2; while (i < n && content[i] !== '\n') i++; continue; }
      if (next === '*') { i += 2; while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++; i += 2; continue; }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Compute the 1-based line number of a character index. */
function lineOf(content, index) {
  if (index < 0 || index >= content.length) return 0;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** @type {Set<string>} Keywords that look like method calls but are control flow */
const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return',
  'typeof', 'new', 'delete', 'void', 'in', 'of', 'async', 'await', 'instanceof',
  'throw', 'else', 'do', 'case', 'extends', 'yield', 'try', 'class', 'import', 'export',
]);

/**
 * Scan backwards from `beforeIndex` for a JSDoc comment (`/** ... *\/`)
 * that immediately precedes a declaration. Returns { text, end } where
 * `end` is the index just past the closing '*\/' (start of the signature),
 * or null if no doc comment is found. Scans at most 1500 chars / ~40 lines
 * so unrelated earlier comments are never captured.
 */
function grabDoc(content, beforeIndex) {
  let i = beforeIndex;
  // Skip trailing whitespace; i ends right after the last non-ws char.
  while (i > 0 && /\s/.test(content[i - 1])) i--;
  if (i < 2) return null;
  // The last non-ws char before the declaration must be the '/' of a '*\/'.
  if (content[i - 1] !== '/' || content[i - 2] !== '*') return null;
  const start = Math.max(0, i - 1500);
  let open = -1;
  for (let j = i - 3; j >= start; j--) {
    if (content[j] === '/' && content[j + 1] === '*') { open = j; break; }
  }
  if (open < 0) return null;
  return { text: content.slice(open, i), end: i };
}

/** Clean a doc comment into plain text. */
function cleanDoc(doc) {
  return (doc || '')
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .replace(/^\s*\* ?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * Extract symbol bodies from JS/TS/JSX source. Returns
 * [{ name, kind, signature, doc, body, startLine }].
 */
function extractJsSymbols(content) {
  const symbols = [];
  const seen = new Set();

  const push = (name, kind, sigStart, sigEnd) => {
    if (!name || name.length > 60 || seen.has(kind + ':' + name)) return;
    const open = findBlockOpen(content, sigEnd);
    if (open < 0) return;
    const close = matchBrace(content, open);
    if (close < 0) return;
    seen.add(kind + ':' + name);
    let body = content.slice(open, close + 1);
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n  // …(truncated)';
    const doc = grabDoc(content, sigStart);
    symbols.push({
      name,
      kind,
      signature: content.slice(doc ? doc.end : sigStart, open).trim().replace(/\s+/g, ' ').slice(0, 300),
      doc: cleanDoc(doc ? doc.text : ''),
      body,
      startLine: lineOf(content, sigStart),
    });
  };

  // Named function declarations
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    push(m[1], 'function', m.index, fnRe.lastIndex);
  }

  // Arrow function declarations: const name = (params) => { ... }
  const arrowRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\s*(?:function\s*)?\(/g;
  while ((m = arrowRe.exec(content)) !== null) {
    if (m[1].length > 40) continue;
    push(m[1], 'function', m.index, arrowRe.lastIndex);
  }

  // Class declarations + their methods
  const classRe = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[\w$.]+)?\s*\{/g;
  let cm;
  while ((cm = classRe.exec(content)) !== null) {
    const openIdx = content.indexOf('{', classRe.lastIndex - 1);
    if (openIdx < 0) continue;
    const closeIdx = matchBrace(content, openIdx);
    if (closeIdx < 0) continue;

    // Whole-class symbol (body capped)
    const clsName = cm[1];
    if (!seen.has('class:' + clsName)) {
      seen.add('class:' + clsName);
      let clsBody = content.slice(openIdx, closeIdx + 1);
      if (clsBody.length > MAX_BODY_CHARS) clsBody = clsBody.slice(0, MAX_BODY_CHARS) + '\n  // …(truncated)';
      const doc = grabDoc(content, cm.index);
      symbols.push({
        name: clsName,
        kind: 'class',
        signature: content.slice(doc ? doc.end : cm.index, openIdx + 1).trim().replace(/\s+/g, ' ').slice(0, 300),
        doc: cleanDoc(doc ? doc.text : ''),
        body: clsBody,
        startLine: lineOf(content, cm.index),
      });
    }

    // Methods inside the class body
    const methodRe = /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/g;
    methodRe.lastIndex = openIdx + 1;
    let mm;
    while ((mm = methodRe.exec(content)) !== null) {
      if (mm.index >= closeIdx) break;
      const mName = mm[1];
      if (mName === 'constructor' || mName.startsWith('_') || CONTROL_KEYWORDS.has(mName)) continue;
      const mOpen = content.indexOf('{', methodRe.lastIndex - 1);
      if (mOpen < 0 || mOpen > closeIdx) continue;
      const mClose = matchBrace(content, mOpen);
      if (mClose < 0 || mClose > closeIdx) continue;
      const seenKey = 'method:' + clsName + '.' + mName;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      let mBody = content.slice(mOpen, mClose + 1);
      if (mBody.length > MAX_BODY_CHARS) mBody = mBody.slice(0, MAX_BODY_CHARS) + '\n  // …(truncated)';
      const doc = grabDoc(content, mm.index);
      symbols.push({
        name: clsName + '.' + mName,
        kind: 'method',
        signature: mName + '(' + mm[2] + ')',
        doc: cleanDoc(doc ? doc.text : ''),
        body: mBody,
        startLine: lineOf(content, mm.index),
      });
    }
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Extract symbol bodies from Python source (indentation-based).
 */
function extractPySymbols(content) {
  const symbols = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (m) {
      const indent = (line.match(/^\s*/) || [''])[0].length;
      const name = m[1];
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') { body.push(l); j++; continue; }
        const li = (l.match(/^\s*/) || [''])[0].length;
        if (li > indent) { body.push(l); j++; } else break;
      }
      let bodyText = body.join('\n');
      if (bodyText.length > MAX_BODY_CHARS) bodyText = bodyText.slice(0, MAX_BODY_CHARS) + '\n  # …(truncated)';
      // Docstring from first body lines
      let doc = '';
      const firstNonEmpty = body.findIndex(l => l.trim() !== '');
      if (firstNonEmpty >= 0) {
        const d = body[firstNonEmpty].trim();
        if (d.startsWith('"""') || d.startsWith("'''")) {
          doc = d.replace(/^['"]{3}/, '').trim();
        }
      }
      symbols.push({
        name,
        kind: 'function',
        signature: line.trim().slice(0, 300),
        doc: doc.slice(0, 240),
        body: bodyText,
        startLine: i + 1,
      });
      i = j;
    } else {
      i++;
    }
  }
  return symbols;
}

/**
 * Extract symbol bodies for a source file, dispatching by extension.
 */
function extractSymbolBodies(content, filePath) {
  const ext = extname(filePath);
  if (ext === '.py') return extractPySymbols(content);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'].includes(ext)) return extractJsSymbols(content);
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// 2. DEEP PRISMA SCHEMA EXTRACTION
// ═══════════════════════════════════════════════════════════════════

function parsePrismaSchema(content) {
  const models = [];
  const enums = [];

  // Extract enums
  const enumRe = /enum\s+(\w+)\s*\{([^}]+)\}/g;
  let em;
  while ((em = enumRe.exec(content)) !== null) {
    const values = [];
    const valRe = /(\w+)/g;
    let v;
    while ((v = valRe.exec(em[2])) !== null) values.push(v[1]);
    enums.push({ name: em[1], values });
  }

  // Extract models with fields
  const modelRe = /model\s+(\w+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let mm;
  while ((mm = modelRe.exec(content)) !== null) {
    const modelName = mm[1];
    const body = mm[2];
    const fields = [];
    const relations = [];

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      // Parse field: name Type @attributes...
      const fieldRe = /^\s*(\w+)\s+(\w+(?:\[\])?\??)(?:\s+(.*))?$/;
      const fm = trimmed.match(fieldRe);
      if (!fm) continue;

      const fieldName = fm[1];
      const rawType = fm[2];
      const attrs = fm[3] || '';

      const field = {
        name: fieldName,
        type: rawType.replace('?', ''),
        isRequired: !rawType.endsWith('?') && !rawType.endsWith('[]'),
        isList: rawType.endsWith('[]'),
        isId: /\B@id\b/.test(attrs),
        isUnique: /\B@unique\b/.test(attrs),
        isUpdatedAt: /\B@updatedAt\b/.test(attrs),
        default: null,
        relation: null,
      };

      // Default value
      const defRe = /@default\(([^)]+)\)/;
      const dm = attrs.match(defRe);
      if (dm) field.default = dm[1].replace(/"/g, '').trim();

      // Relation
      const relRe = /@relation\(([^)]*)\)/;
      const rm = attrs.match(relRe);
      if (rm) {
        const refRe = /references:\s*\[(\w+)\]/;
        const fieldsRe = /fields:\s*\[(\w+)\]/;
        const refMatch = rm[1].match(refRe);
        const fieldsMatch = rm[1].match(fieldsRe);
        field.relation = {
          model: refMatch ? refMatch[1] : null,
          field: fieldsMatch ? fieldsMatch[1] : null,
        };
        relations.push({
          from: modelName,
          fromField: fieldName,
          to: refMatch ? refMatch[1] : null,
          toField: fieldsMatch ? fieldsMatch[1] : null,
        });
      }

      // Is it a relation field (user-defined model name as type vs scalar)?
      const PRISMA_SCALARS = new Set([
        'String', 'Int', 'BigInt', 'Float', 'Boolean', 'DateTime',
        'Json', 'Bytes', 'Decimal', 'Unsupported'
      ]);
      if (!field.relation && /^[A-Z]/.test(field.type) && !PRISMA_SCALARS.has(field.type)) {
        field.relation = { model: field.type, field: 'id' };
        relations.push({ from: modelName, fromField: fieldName, to: field.type, toField: 'id' });
      }

      fields.push(field);
    }

    models.push({ name: modelName, fields, relations });
  }

  return { models, enums };
}

// ═══════════════════════════════════════════════════════════════════
// 3. DATA/CONTROL FLOW LAYERS
// ═══════════════════════════════════════════════════════════════════

const LAYER_UI = 'UI';
const LAYER_API = 'API';
const LAYER_SERVICE = 'Service';
const LAYER_DATA = 'Data';
const LAYER_UNKNOWN = 'Unknown';

function classifyLayer(filePath, role) {
  const lower = normalizePath(filePath).toLowerCase();
  if (role === 'page' || role === 'layout' || role === 'component') return LAYER_UI;
  if (role === 'api-route' || lower.includes('/routes/') || lower.includes('/controllers/') || lower.includes('/api/')) return LAYER_API;
  if (role === 'library' || role === 'hook' || lower.includes('/lib/') || lower.includes('/utils/') || lower.includes('/services/') || lower.startsWith('src/core/')) return LAYER_SERVICE;
  if (role === 'schema' || lower.includes('/models/') || lower.includes('/repositories/') || lower.includes('/db/') || lower.endsWith('.prisma')) return LAYER_DATA;
  if (role === 'script') return LAYER_UNKNOWN;
  return LAYER_SERVICE; // default service layer
}

function buildLayerMap(graph) {
  const layers = { [LAYER_UI]: [], [LAYER_API]: [], [LAYER_SERVICE]: [], [LAYER_DATA]: [], [LAYER_UNKNOWN]: [] };
  const edges = {}; // "A->B": count

  // Assign files to layers
  for (const [path, node] of Object.entries(graph)) {
    const layer = classifyLayer(path, node.role);
    node.layer = layer;
    layers[layer].push(path);
  }

  // Count cross-layer edges
  for (const [path, node] of Object.entries(graph)) {
    for (const imp of node.imports || []) {
      // Resolve local import to actual file
      const resolved = resolveImport(imp, path, graph);
      if (!resolved) continue;
      const sourceLayer = node.layer;
      const targetLayer = graph[resolved]?.layer || LAYER_UNKNOWN;
      if (sourceLayer !== targetLayer) {
        const key = `${sourceLayer}->${targetLayer}`;
        edges[key] = (edges[key] || 0) + 1;
      }
    }
  }

  // Identify typical request paths: UI → API → Service → Data
  const paths = [];
  if (layers[LAYER_UI].length > 0 && layers[LAYER_API].length > 0) paths.push('UI → API');
  if (layers[LAYER_API].length > 0 && layers[LAYER_SERVICE].length > 0) paths.push('API → Service');
  if (layers[LAYER_SERVICE].length > 0 && layers[LAYER_DATA].length > 0) paths.push('Service → Data');

  // Find top cross-file imports (most connected nodes)
  const importCounts = {};
  for (const [path, node] of Object.entries(graph)) {
    importCounts[path] = node.imports?.length || 0;
  }
  const hubFiles = Object.entries(importCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([p, c]) => ({ path: p, imports: c }));

  return {
    layerCounts: {
      [LAYER_UI]: layers[LAYER_UI].length,
      [LAYER_API]: layers[LAYER_API].length,
      [LAYER_SERVICE]: layers[LAYER_SERVICE].length,
      [LAYER_DATA]: layers[LAYER_DATA].length,
    },
    crossLayerEdges: edges,
    requestPath: paths.join(' → '),
    hubFiles,
  };
}

function resolveImport(importPath, fromFile, graph) {
  if (importPath.startsWith('@/')) {
    const resolved = normalizePath(relative(PROJECT_ROOT, join(PROJECT_ROOT, importPath.replace('@/', 'src/'))));
    return findBestMatch(resolved, graph);
  }
  if (importPath.startsWith('.')) {
    const base = normalizePath(dirname(fromFile));
    const resolved = normalizePath(relative(PROJECT_ROOT, join(PROJECT_ROOT, base, importPath)));
    return findBestMatch(resolved, graph);
  }
  return null;
}

function findBestMatch(path, graph) {
  // Try extensions
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '/index.ts', '/index.js']) {
    const test = path + ext;
    if (graph[test]) return test;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// 4. BUSINESS LOGIC / PARADIGMS / TECH STACK
// ═══════════════════════════════════════════════════════════════════

function detectParadigms(files, graph) {
  const paradigms = [];

  // Collect directory names
  const dirNames = new Set();
  for (const f of files) {
    const parts = normalizePath(relative(PROJECT_ROOT, f)).split('/');
    for (const p of parts) dirNames.add(p.toLowerCase());
  }

  // MVC detection
  const hasControllers = dirNames.has('controllers') || [...dirNames].some(d => d.endsWith('controller'));
  const hasViews = dirNames.has('views') || [...dirNames].some(d => d === 'templates');
  const hasModels = dirNames.has('models') || [...dirNames].some(d => d.endsWith('model'));
  if (hasControllers && hasModels) paradigms.push('MVC');
  if (hasControllers && hasViews && hasModels) paradigms.push('Full MVC');

  // Repository pattern
  const hasRepos = Object.keys(graph).some(p => /repository|repos?\b/i.test(p));
  if (hasRepos) paradigms.push('Repository Pattern');

  // Event-driven detection (sample a few files)
  let eventDrivenHits = 0;
  for (const f of files.slice(0, 30)) {
    try {
      const content = readFileSync(f, 'utf-8');
      if (/\.emit\(|\.publish\(|EventEmitter|\.on\(['"]\w+['"]|\.addEventListener/.test(content)) eventDrivenHits++;
    } catch {}
  }
  if (eventDrivenHits >= 3) paradigms.push('Event-Driven');

  // Microservices / containerization detection (check disk directly, not via walkDir)
  let hasDockerCompose = false;
  try {
    const rootFiles = readdirSync(PROJECT_ROOT);
    hasDockerCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']
      .some(n => rootFiles.includes(n))
      || rootFiles.some(f => /^docker-compose\./.test(f));
  } catch { /* can't read root dir */ }
  const hasMultiService = dirNames.has('services') || dirNames.has('apps') || dirNames.has('microservices');
  if (hasDockerCompose && hasMultiService) paradigms.push('Microservices');
  if (hasDockerCompose && !hasMultiService) paradigms.push('Containerized');

  // Monorepo
  if (dirNames.has('packages') || (dirNames.has('apps') && dirNames.has('packages'))) {
    paradigms.push('Monorepo');
  }

  // CLI tool detection
  const hasCliEntry = files.some(f => {
    const name = basename(f);
    return name === 'cli.js' || name === 'cli.ts' || name === 'cli.mjs' || name === 'main.py' || name === 'index.js';
  });
  if (hasCliEntry) {
    paradigms.push('CLI Tool');
  }

  return paradigms;
}

function detectTechStack() {
  const stack = { runtime: [], frameworks: [], databases: [], tools: [] };

  // Read known config files directly from project root (walkDir excludes .json/.txt/.toml)
  const configFiles = [
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'requirements.txt'),
    join(PROJECT_ROOT, 'pyproject.toml'),
  ];

  for (const f of configFiles) {
    if (!existsSync(f)) continue;
    const name = basename(f);
    try {
      if (name === 'package.json') {
        const pkg = JSON.parse(readFileSync(f, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const keys = Object.keys(deps);

        if (keys.includes('next')) stack.frameworks.push('Next.js');
        if (keys.includes('react')) stack.frameworks.push('React');
        if (keys.includes('vue')) stack.frameworks.push('Vue');
        if (keys.includes('angular')) stack.frameworks.push('Angular');
        if (keys.includes('express')) stack.frameworks.push('Express');
        if (keys.includes('fastify')) stack.frameworks.push('Fastify');
        if (keys.includes('nestjs') || keys.includes('@nestjs/core')) stack.frameworks.push('NestJS');
        if (keys.includes('prisma')) { stack.databases.push('Prisma'); stack.tools.push('Prisma ORM'); }
        if (keys.includes('drizzle-orm')) { stack.databases.push('Drizzle'); stack.tools.push('Drizzle ORM'); }
        if (keys.includes('typeorm')) stack.tools.push('TypeORM');
        if (keys.includes('better-sqlite3')) stack.databases.push('SQLite');
        if (keys.includes('pg') || keys.includes('postgres')) stack.databases.push('PostgreSQL');
        if (keys.includes('mysql2') || keys.includes('mysql')) stack.databases.push('MySQL');
        if (keys.includes('mongoose') || keys.includes('mongodb')) stack.databases.push('MongoDB');
        if (keys.includes('redis') || keys.includes('ioredis')) stack.databases.push('Redis');
        if (keys.includes('tailwindcss')) stack.tools.push('Tailwind CSS');
        if (keys.includes('typescript') || keys.includes('ts-node') || keys.includes('tsx')) stack.runtime.push('TypeScript');
        if (keys.includes('vitest') || keys.includes('jest')) stack.tools.push('Vitest/Jest');
        if (keys.includes('eslint')) stack.tools.push('ESLint');
        if (keys.includes('prettier')) stack.tools.push('Prettier');
        if (keys.includes('graphql') || keys.includes('@apollo/server')) stack.frameworks.push('GraphQL');
        if (keys.includes('trpc') || keys.includes('@trpc/server')) stack.frameworks.push('tRPC');
        if (keys.includes('@xenova/transformers')) stack.tools.push('Xenova Transformers (AI/ML)');
        if (keys.includes('zod')) stack.tools.push('Zod');
      }

      if (name === 'requirements.txt' || name === 'pyproject.toml') {
        const content = readFileSync(f, 'utf-8');
        if (/django/i.test(content)) stack.frameworks.push('Django');
        if (/flask/i.test(content)) stack.frameworks.push('Flask');
        if (/fastapi/i.test(content)) stack.frameworks.push('FastAPI');
        if (/sqlalchemy/i.test(content)) stack.tools.push('SQLAlchemy');
        if (/pydantic/i.test(content)) stack.tools.push('Pydantic');
        if (/celery/i.test(content)) stack.tools.push('Celery');
      }
    } catch {}
  }

  return stack;
}

// ═══════════════════════════════════════════════════════════════════
// ORIGINAL PARSERS (enhanced roles)
// ═══════════════════════════════════════════════════════════════════

function parseExports(content, filePath) {
  const exports = [];
  const ext = extname(filePath);
  
  const namedPattern = /export\s+(?:const|let|var|function|class|async\s+function|interface|type|enum)\s+(\w+)/g;
  let match;
  while ((match = namedPattern.exec(content)) !== null) {
    exports.push(match[1]);
  }

  if (/export\s+default\s+(?:function|class|async\s+function)\s+(\w+)/.test(content)) {
    exports.push(content.match(/export\s+default\s+(?:function|class|async\s+function)\s+(\w+)/)[1]);
  }
  if (/export\s+default\s+\w+/.test(content) && !/export\s+default\s+(?:function|class)/.test(content)) {
    exports.push('default');
  }

  const base = filePath.split(/[\\/]/).pop();
  if (['page.tsx', 'layout.tsx', 'route.ts', 'route.tsx'].includes(base)) {
    exports.push('(route handler)');
  }

  if (ext === '.prisma') {
    const modelPattern = /model\s+(\w+)/g;
    while ((match = modelPattern.exec(content)) !== null) {
      exports.push(`model:${match[1]}`);
    }
  }

  return [...new Set(exports)];
}

function parseImports(content, filePath) {
  const imports = [];
  const pattern = /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const mod = match[1];
    if (mod.startsWith('node:')) continue;
    imports.push(mod);
  }
  return [...new Set(imports)];
}

function detectRole(filePath) {
  const rel = normalizePath(relative(PROJECT_ROOT, filePath));
  const lower = rel.toLowerCase();
  const base = basename(filePath);

  // Framework-agnostic role detection
  if ((lower.includes('/api/') || lower.includes('/routes/')) && (base.includes('route') || base.includes('controller'))) return 'api-route';
  if (lower.includes('/components/') || lower.includes('/ui/') || base.includes('.component.')) return 'component';
  if (lower.includes('/lib/') || lower.includes('/utils/') || lower.includes('/helpers/') || lower.startsWith('src/core/')) return 'library';
  if (lower.includes('/app/') && base === 'page.tsx') return 'page';
  if (lower.includes('/app/') && base === 'layout.tsx') return 'layout';
  if (lower.includes('/hooks/') || base.startsWith('use')) return 'hook';
  if (lower.includes('/types/') || base.endsWith('.d.ts')) return 'types';
  if (lower.startsWith('prisma/') || base.endsWith('.prisma')) return 'schema';
  if (lower.includes('/models/')) {
    if (base.endsWith('.py')) return 'schema';
    return 'types';
  }
  if (lower.startsWith('scripts/')) return 'script';
  if (lower.includes('/services/') || lower.includes('/repositories/')) return 'library';
  if (lower.includes('/controllers/')) return 'api-route';
  if (lower.includes('/pages/') || lower.includes('/views/')) return 'page';
  if (lower.includes('/middleware/')) return 'library';
  if (lower.includes('/config/') || base.includes('.config.')) return 'types';
  
  return 'source';
}

function detectApiRoutes(files) {
  const routes = [];
  for (const f of files) {
    const rel = normalizePath(relative(PROJECT_ROOT, f));
    // Next.js App Router
    const apiMatch = rel.match(/src\/app\/api\/(.+?)\/route\.[jt]sx?$/);
    if (apiMatch) {
      const routePath = '/api/' + apiMatch[1];
      const content = readFileSync(f, 'utf-8');
      const methods = [];
      if (/export\s+(?:async\s+)?function\s+GET/.test(content)) methods.push('GET');
      if (/export\s+(?:async\s+)?function\s+POST/.test(content)) methods.push('POST');
      if (/export\s+(?:async\s+)?function\s+PUT/.test(content)) methods.push('PUT');
      if (/export\s+(?:async\s+)?function\s+DELETE/.test(content)) methods.push('DELETE');
      if (/export\s+(?:async\s+)?function\s+PATCH/.test(content)) methods.push('PATCH');
      routes.push({ path: routePath, methods: methods.length > 0 ? methods : ['GET'] });
    }
    // Express-style routes
    if (rel.includes('/routes/') || rel.includes('/controllers/')) {
      try {
        const content = readFileSync(f, 'utf-8');
        const routeRe = /\.(?:get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
        let rm;
        while ((rm = routeRe.exec(content)) !== null) {
          const method = rm[0].match(/\.(\w+)/)[1].toUpperCase();
          routes.push({ path: rm[1], methods: [method], file: rel });
        }
      } catch {}
    }
    // Python FastAPI/Flask routes
    if (f.endsWith('.py')) {
      try {
        const content = readFileSync(f, 'utf-8');
        const pyRe = /@(?:app|router|bp)\.(?:get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
        let rm;
        while ((rm = pyRe.exec(content)) !== null) {
          const methodMatch = rm[0].match(/\.(\w+)/);
          const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
          routes.push({ path: rm[1], methods: [method], file: rel });
        }
      } catch {}
    }
  }
  return routes;
}

function detectServices(graph) {
  const services = {};
  for (const [filePath, node] of Object.entries(graph)) {
    if (node.role === 'api-route') {
      for (const imp of node.imports) {
        if (imp.startsWith('@/lib/') || imp.startsWith('../') || imp.startsWith('./')) {
          const serviceName = imp.split('/').pop();
          if (!services[serviceName]) services[serviceName] = [];
          services[serviceName].push(node.path);
        }
      }
    }
  }
  return services;
}

// ═══════════════════════════════════════════════════════════════════
// XML FORMATTER — agent-optimized, token-efficient
// ═══════════════════════════════════════════════════════════════════

function formatGraphAsXML(output) {
  let xml = `<codebase_graph files="${output.fileCount}" api_routes="${output.apiRoutes.length}" generated="${output.generated}">\n`;

  // Architecture
  if (output.paradigms && output.paradigms.length > 0) {
    xml += `  <architecture patterns="${xmlEscape(output.paradigms.join(', '))}"`;
    if (output.techStack) {
      const ts = output.techStack;
      const parts = [];
      if (ts.runtime.length) parts.push(`Language: ${ts.runtime.join(', ')}`);
      if (ts.frameworks.length) parts.push(`Frameworks: ${ts.frameworks.join(', ')}`);
      if (ts.databases.length) parts.push(`Databases: ${ts.databases.join(', ')}`);
      if (ts.tools.length) parts.push(`Tools: ${ts.tools.join(', ')}`);
      if (parts.length) xml += ` stack="${xmlEscape(parts.join(' | '))}"`;
    }
    xml += `/>\n`;
  }

  // Data flow layers
  if (output.layerMap && output.layerMap.requestPath) {
    const lc = output.layerMap.layerCounts;
    xml += `  <layers dataflow="${xmlEscape(output.layerMap.requestPath)}" ui="${lc.UI}" api="${lc.API}" service="${lc.Service}" data="${lc.Data}"/>\n`;
    if (output.layerMap.hubFiles && output.layerMap.hubFiles.length > 0) {
      xml += `  <hub_files>${output.layerMap.hubFiles.slice(0, 8).map(h => xmlEscape(h.path)).join(', ')}</hub_files>\n`;
    }
  }

  // API Routes
  if (output.apiRoutes.length > 0) {
    xml += `  <api_routes>\n`;
    for (const route of output.apiRoutes.sort((a, b) => (a.path || '').localeCompare(b.path || '')).slice(0, 15)) {
      const fileAttr = route.file ? ` file="${xmlEscape(route.file)}"` : '';
      xml += `    <route methods="${route.methods.join(',')}" path="${xmlEscape(route.path)}"${fileAttr}/>\n`;
    }
    xml += `  </api_routes>\n`;
  }

  // Database Schema
  if (output.prismaSchema && output.prismaSchema.models.length > 0) {
    xml += `  <schema>\n`;
    for (const model of output.prismaSchema.models) {
      xml += `    <model name="${xmlEscape(model.name)}">\n`;
      for (const field of model.fields) {
        const attrs = [];
        if (field.isId) attrs.push('pk');
        if (!field.isRequired) attrs.push('optional');
        if (field.isList) attrs.push('list');
        if (field.isUnique) attrs.push('unique');
        const attrStr = attrs.length ? ` attrs="${attrs.join(',')}"` : '';
        const relStr = field.relation ? ` ref="${field.relation.model}"` : '';
        xml += `      <field name="${xmlEscape(field.name)}" type="${xmlEscape(field.type)}"${attrStr}${relStr}/>\n`;
      }
      xml += `    </model>\n`;
    }
    const allRels = output.prismaSchema.models.flatMap(m => m.relations);
    if (allRels.length > 0) {
      const uniqueRels = [...new Set(allRels.map(r => `${r.from}→${r.to}`))];
      xml += `    <relations>${uniqueRels.join(', ')}</relations>\n`;
    }
    xml += `  </schema>\n`;
  }

  // Core Libraries
  const libs = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'library')
    .sort(([a], [b]) => a.localeCompare(b));
  if (libs.length > 0) {
    xml += `  <libraries>\n`;
    for (const [libPath, node] of libs.slice(0, 15)) {
      const exports = node.exports.filter(e => !e.startsWith('model:')).slice(0, 10);
      const expStr = exports.length ? ` exports="${xmlEscape(exports.join(', '))}"` : '';
      // Include key function signatures
      let fnStr = '';
      if (node.functions && node.functions.length > 0) {
        const sigs = node.functions.slice(0, 6).map(f => {
          let sig = f.name + '(';
          if (f.params.length) sig += f.params.map(p => p.name).join(',');
          sig += ')';
          return sig;
        });
        fnStr = ` fns="${xmlEscape(sigs.join('; '))}"`;
      }
      xml += `    <file path="${xmlEscape(libPath)}" layer="${node.layer || 'Service'}"${expStr}${fnStr}/>\n`;
    }
    xml += `  </libraries>\n`;
  }

  // Scripts
  const scripts = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'script')
    .sort(([a], [b]) => a.localeCompare(b));
  if (scripts.length > 0) {
    xml += `  <scripts>\n`;
    for (const [scriptPath] of scripts) {
      xml += `    <file path="${xmlEscape(scriptPath)}"/>\n`;
    }
    xml += `  </scripts>\n`;
  }

  // API Dependencies
  if (output.services && Object.keys(output.services).length > 0) {
    xml += `  <service_deps>\n`;
    for (const [service, routes] of Object.entries(output.services)) {
      xml += `    <service name="${xmlEscape(service)}" used_by="${xmlEscape(routes.map(r => r.replace('src/app', '')).join(', '))}"/>\n`;
    }
    xml += `  </service_deps>\n`;
  }

  xml += `</codebase_graph>`;
  return xml;
}

function xmlEscape(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════
// MARKDOWN FORMATTER
// ═══════════════════════════════════════════════════════════════════

function formatGraphAsMarkdown(output) {
  let md = `## Codebase Graph\n`;
  md += `*${output.fileCount} source files | ${output.apiRoutes.length} API routes | Generated ${output.generated}*\n\n`;

  // ── Architecture Profile ──
  if (output.paradigms && output.paradigms.length > 0) {
    md += `### Architecture\n`;
    md += `**Patterns:** ${output.paradigms.join(', ')}\n`;
  }
  if (output.techStack) {
    const ts = output.techStack;
    const parts = [];
    if (ts.runtime.length) parts.push(`Language: ${ts.runtime.join(', ')}`);
    if (ts.frameworks.length) parts.push(`Frameworks: ${ts.frameworks.join(', ')}`);
    if (ts.databases.length) parts.push(`Databases: ${ts.databases.join(', ')}`);
    if (ts.tools.length) parts.push(`Tools: ${ts.tools.join(', ')}`);
    if (parts.length) md += `**Stack:** ${parts.join(' | ')}\n`;
  }
  md += `\n`;

  // ── Data Flow ──
  if (output.layerMap && output.layerMap.requestPath) {
    md += `### Data Flow\n`;
    md += `\`${output.layerMap.requestPath}\`\n`;
    const lc = output.layerMap.layerCounts;
    md += `Files per layer: UI=${lc.UI} API=${lc.API} Service=${lc.Service} Data=${lc.Data}\n`;

    if (output.layerMap.hubFiles && output.layerMap.hubFiles.length > 0) {
      md += `**Hub files (most imported):** `;
      md += output.layerMap.hubFiles.slice(0, 5).map(h => `\`${h.path}\``).join(', ');
      md += `\n`;
    }
    md += `\n`;
  }

  // ── API Routes ──
  if (output.apiRoutes.length > 0) {
    md += `### API Routes (${output.apiRoutes.length})\n`;
    for (const route of output.apiRoutes.sort((a, b) => (a.path || '').localeCompare(b.path || '')).slice(0, 15)) {
      const loc = route.file ? ` (${route.file})` : '';
      md += `- \`${route.methods.join('/')} ${route.path}\`${loc}\n`;
    }
    md += `\n`;
  }

  // ── Database Schema ──
  if (output.prismaSchema && output.prismaSchema.models.length > 0) {
    md += `### Database Schema\n`;
    for (const model of output.prismaSchema.models) {
      const fieldList = model.fields
        .filter(f => !f.relation || f.relation.field)
        .map(f => {
          let s = `${f.name}: ${f.type}`;
          if (!f.isRequired) s += '?';
          if (f.isId) s += ' (PK)';
          if (f.relation && f.relation.model) s += ` → ${f.relation.model}`;
          return s;
        })
        .join(', ');
      md += `- **${model.name}** — ${fieldList}\n`;
    }

    // Relations
    const allRels = output.prismaSchema.models.flatMap(m => m.relations);
    if (allRels.length > 0) {
      const uniqueRels = [...new Set(allRels.map(r => `${r.from}→${r.to}`))];
      md += `- **Relations:** ${uniqueRels.join(', ')}\n`;
    }
    md += `\n`;
  }

  // ─── Core Libraries ──
  const libs = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'library')
    .sort(([a], [b]) => a.localeCompare(b));
  
  if (libs.length > 0) {
    md += `### Core Libraries (${libs.length})\n`;
    for (const [path, node] of libs.slice(0, 12)) {
      const parts = [];
      const exports = node.exports.filter(e => !e.startsWith('model:')).slice(0, 8);
      if (exports.length > 0) parts.push(`exports: ${exports.join(', ')}`);

      // Show key functions with signatures
      if (node.functions && node.functions.length > 0) {
        const sigs = node.functions.slice(0, 5).map(f => {
          let sig = f.name + '(';
          if (f.params.length) sig += f.params.map(p => p.name).join(', ');
          sig += ')';
          return sig;
        });
        if (sigs.length) parts.push(`fns: ${sigs.join(', ')}`);
      }

      if (parts.length > 0) {
        md += `- \`${path}\` — ${parts.join(' | ')}\n`;
      } else {
        md += `- \`${path}\`\n`;
      }
    }
    md += `\n`;
  }

  // ── Scripts ──
  const scripts = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'script')
    .sort(([a], [b]) => a.localeCompare(b));
  
  if (scripts.length > 0) {
    md += `### Scripts\n`;
    for (const [path] of scripts) {
      md += `- \`${path}\`\n`;
    }
    md += `\n`;
  }

  // ── Components & Pages ──
  const components = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'component' || n.role === 'page' || n.role === 'layout')
    .sort(([a], [b]) => a.localeCompare(b));
  
  if (components.length > 0) {
    md += `### UI Components & Pages (${components.length})\n`;
    for (const [path, node] of components.slice(0, 10)) {
      md += `- \`${path}\` (${node.role})\n`;
    }
    md += `\n`;
  }

  // ── Service Dependencies ──
  if (output.services && Object.keys(output.services).length > 0) {
    md += `### API → Service Dependencies\n`;
    for (const [service, routes] of Object.entries(output.services)) {
      md += `- \`${service}\` used by: ${routes.map(r => r.replace('src/app', '')).join(', ')}\n`;
    }
    md += `\n`;
  }

  return md;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

/** Parse a single source file into a graph node (used by full + partial builds). */
function parseSourceFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const relPath = normalizePath(relative(PROJECT_ROOT, filePath));
  return {
    path: relPath,
    role: detectRole(filePath),
    exports: parseExports(content, filePath),
    imports: parseImports(content, filePath).map(i => i.replace(/\\/g, '/')),
    functions: parseFunctionSignatures(content, filePath),
    symbols: extractSymbolBodies(content, filePath),
    size: content.length,
  };
}

function main() {
  const skipCache = process.argv.includes('--skip-cache');
  let onlyFiles = null;
  const ofIdx = process.argv.indexOf('--only-files');
  if (ofIdx >= 0 && process.argv[ofIdx + 1]) {
    onlyFiles = new Set(process.argv[ofIdx + 1].split(',').filter(Boolean).map(f => normalizePath(f)));
  }
  const outputFormat = process.argv.includes('--output') 
    ? process.argv[process.argv.indexOf('--output') + 1] 
    : 'json';

  // Discover source files
  const files = [];
  for (const f of walkDir(PROJECT_ROOT)) {
    files.push(f);
  }

  let cached = null;
  if (existsSync(GRAPH_CACHE)) {
    try { cached = JSON.parse(readFileSync(GRAPH_CACHE, 'utf-8')); } catch { cached = null; }
  }

  // ── Partial update mode: re-parse only the given files, keep the rest ──
  if (onlyFiles && cached && !skipCache) {
    const graph = cached.graph || {};
    let changed = 0;
    for (const f of files) {
      const rel = normalizePath(relative(PROJECT_ROOT, f));
      if (onlyFiles.has(rel)) {
        try { graph[rel] = parseSourceFile(f); changed++; } catch { /* unreadable, keep old */ }
      }
    }
    // Recompute derived views (cheap, keeps layerMap/services/routes fresh)
    let layerMap = { layerCounts: { UI: 0, API: 0, Service: 0, Data: 0 }, crossLayerEdges: {}, requestPath: '', hubFiles: [] };
    try { layerMap = buildLayerMap(graph); } catch {}
    let services = {};
    try { services = detectServices(graph); } catch {}
    let apiRoutes = [];
    try { apiRoutes = detectApiRoutes(files); } catch {}
    let prismaSchema = { models: [], enums: [] };
    for (const f of files) {
      if (f.endsWith('.prisma')) {
        try { prismaSchema = parsePrismaSchema(readFileSync(f, 'utf-8')); } catch {}
      }
    }
    const output = {
      generated: new Date().toISOString(),
      fingerprint: projectFingerprint(files),
      fileCount: Object.keys(graph).length,
      apiRoutes,
      services,
      prismaSchema,
      layerMap,
      paradigms: cached.paradigms || [],
      techStack: cached.techStack || { runtime: [], frameworks: [], databases: [], tools: [] },
      graph,
    };
    try { writeFileSync(GRAPH_CACHE, JSON.stringify(output, null, 2)); } catch {}
    if (outputFormat === 'json') console.log(JSON.stringify(output));
    else if (outputFormat === 'xml') console.log(formatGraphAsXML(output));
    else console.log(formatGraphAsMarkdown(output));
    return;
  }

  // ── Full cache check ──
  if (!skipCache && cached) {
    if (cached.fingerprint === projectFingerprint(files)) {
      if (outputFormat === 'json') {
        console.log(JSON.stringify(cached));
      } else {
        console.log(formatGraphAsMarkdown(cached));
      }
      return;
    }
  }

  // ── Full build ──
  const graph = {};
  for (const filePath of files) {
    try {
      graph[normalizePath(relative(PROJECT_ROOT, filePath))] = parseSourceFile(filePath);
    } catch { /* binary or unreadable, skip */ }
  }

  // Extract Prisma schema from .prisma files
  let prismaSchema = { models: [], enums: [] };
  for (const f of files) {
    if (f.endsWith('.prisma')) {
      try {
        prismaSchema = parsePrismaSchema(readFileSync(f, 'utf-8'));
      } catch { /* skip broken prisma file */ }
    }
  }

  // Build data flow layer map
  let layerMap = { layerCounts: { UI: 0, API: 0, Service: 0, Data: 0 }, crossLayerEdges: {}, requestPath: '', hubFiles: [] };
  try { layerMap = buildLayerMap(graph); } catch { /* layer map failed */ }

  // Detect paradigms and tech stack
  let paradigms = [];
  try { paradigms = detectParadigms(files, graph); } catch { /* paradigm detection failed */ }

  let techStack = { runtime: [], frameworks: [], databases: [], tools: [] };
  try { techStack = detectTechStack(); } catch { /* tech stack detection failed */ }

  let services = {};
  try { services = detectServices(graph); } catch { /* service detection failed */ }

  let apiRoutes = [];
  try { apiRoutes = detectApiRoutes(files); } catch { /* api route detection failed */ }

  // Build final output
  const output = {
    generated: new Date().toISOString(),
    fingerprint: projectFingerprint(files),
    fileCount: Object.keys(graph).length,
    apiRoutes,
    services,
    prismaSchema,
    layerMap,
    paradigms,
    techStack,
    graph,
  };

  // Cache
  try { writeFileSync(GRAPH_CACHE, JSON.stringify(output, null, 2)); } catch {}

  if (outputFormat === 'json') {
    console.log(JSON.stringify(output));
  } else if (outputFormat === 'xml') {
    console.log(formatGraphAsXML(output));
  } else {
    console.log(formatGraphAsMarkdown(output));
  }
}

main();

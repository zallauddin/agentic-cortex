#!/usr/bin/env node
/**
 * generate-graph.mjs — Deterministic codebase structure graph generator.
 *
 * Walks the project tree, parses source files to extract exports, imports,
 * and structural metadata. Produces a compact JSON graph that can be
 * saved as an agentic-cortex observation and injected into knowledge.md.
 *
 * No LLM needed — this is pure static analysis. Same input → same output.
 * Only re-runs when files change (fingerprint-based caching).
 *
 * Usage:
 *   node scripts/generate-graph.mjs [--skip-cache] [--output json|md]
 *
 * The output is designed to be compact enough (~2-5K chars for an 80-file
 * project) to inject into knowledge.md without bloating the context window.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';

const PROJECT_ROOT = process.cwd();
const GRAPH_CACHE = join(PROJECT_ROOT, '.infinit-graph.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.understand-anything', '.turbo', 'coverage', 'out']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.prisma', '.py']);
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
        const base = entry.name;
        if (SKIP_PATTERNS.some(p => p.test(base))) continue;
        yield fullPath;
      }
    }
  } catch { /* permission errors, skip */ }
}

// ─── Parsers: extract exports and imports from source files ──────

function parseExports(content, filePath) {
  const exports = [];
  const ext = extname(filePath);
  
  // Named exports: export const/function/class/async function NAME
  const namedPattern = /export\s+(?:const|let|var|function|class|async\s+function|interface|type|enum)\s+(\w+)/g;
  let match;
  while ((match = namedPattern.exec(content)) !== null) {
    exports.push(match[1]);
  }

  // Default exports
  if (/export\s+default\s+(?:function|class|async\s+function)\s+(\w+)/.test(content)) {
    exports.push(content.match(/export\s+default\s+(?:function|class|async\s+function)\s+(\w+)/)[1]);
  }
  if (/export\s+default\s+\w+/.test(content) && !/export\s+default\s+(?:function|class)/.test(content)) {
    exports.push('default');
  }

  // Next.js App Router: page.tsx, layout.tsx, route.ts => implicit exports
  const basename = filePath.split(/[\\/]/).pop();
  if (['page.tsx', 'layout.tsx', 'route.ts', 'route.tsx'].includes(basename)) {
    exports.push('(route handler)');
  }

  // Prisma schema
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
  // import { X } from 'Y' or import X from 'Y' or import type { X } from 'Y'
  const pattern = /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const mod = match[1];
    // Skip node builtins and type-only imports
    if (mod.startsWith('node:')) continue;
    // Normalize local imports
    imports.push(mod);
  }
  return [...new Set(imports)];
}

// ─── Role detection from file path ───────────────────────────────

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function detectRole(filePath) {
  const rel = normalizePath(relative(PROJECT_ROOT, filePath));
  const lower = rel.toLowerCase();

  if (lower.includes('/api/') && (lower.endsWith('route.ts') || lower.endsWith('route.tsx'))) return 'api-route';
  if (lower.includes('/components/')) return 'component';
  if (lower.includes('/lib/') || lower.includes('/utils/')) return 'library';
  if (lower.includes('/app/') && lower.endsWith('page.tsx')) return 'page';
  if (lower.includes('/app/') && lower.endsWith('layout.tsx')) return 'layout';
  if (lower.startsWith('prisma/')) return 'schema';
  if (lower.startsWith('scripts/')) return 'script';
  if (lower.includes('/hooks/')) return 'hook';
  if (lower.includes('/types/')) return 'types';
  if (lower.endsWith('.prisma')) return 'schema';
  return 'source';
}

// ─── API route detection ─────────────────────────────────────────

function detectApiRoutes(files) {
  const routes = [];
  for (const f of files) {
    const rel = normalizePath(relative(PROJECT_ROOT, f));
    const apiMatch = rel.match(/src\/app\/api\/(.+?)\/route\.[jt]sx?$/);
    if (apiMatch) {
      const routePath = '/api/' + apiMatch[1];
      const content = readFileSync(f, 'utf-8');
      // Detect HTTP methods
      const methods = [];
      if (/export\s+(?:async\s+)?function\s+GET/.test(content)) methods.push('GET');
      if (/export\s+(?:async\s+)?function\s+POST/.test(content)) methods.push('POST');
      if (/export\s+(?:async\s+)?function\s+PUT/.test(content)) methods.push('PUT');
      if (/export\s+(?:async\s+)?function\s+DELETE/.test(content)) methods.push('DELETE');
      if (/export\s+(?:async\s+)?function\s+PATCH/.test(content)) methods.push('PATCH');
      routes.push({ path: routePath, methods: methods.length > 0 ? methods : ['GET'] });
    }
  }
  return routes;
}

// ─── Service detection ───────────────────────────────────────────

function detectServices(graph) {
  // Identify key services from import patterns and role clusters
  const services = {};
  for (const [filePath, node] of Object.entries(graph)) {
    if (node.role === 'api-route') {
      for (const imp of node.imports) {
        if (imp.startsWith('@/lib/') || imp.startsWith('../')) {
          const serviceName = imp.split('/').pop();
          if (!services[serviceName]) services[serviceName] = [];
          services[serviceName].push(node.path);
        }
      }
    }
  }
  return services;
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
  const skipCache = process.argv.includes('--skip-cache');
  const outputFormat = process.argv.includes('--output') 
    ? process.argv[process.argv.indexOf('--output') + 1] 
    : 'json';

  // Discover source files
  const files = [];
  for (const f of walkDir(PROJECT_ROOT)) {
    files.push(f);
  }

  // Cache check
  if (!skipCache && existsSync(GRAPH_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(GRAPH_CACHE, 'utf-8'));
      if (cached.fingerprint === projectFingerprint(files)) {
        if (outputFormat === 'json') {
          console.log(JSON.stringify(cached));
        } else {
          console.log(formatGraphAsMarkdown(cached));
        }
        return;
      }
    } catch { /* cache corrupt, regenerate */ }
  }

  // Build graph
  const graph = {};
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const relPath = normalizePath(relative(PROJECT_ROOT, filePath));

      graph[relPath] = {
        path: relPath,
        role: detectRole(filePath),
        exports: parseExports(content, filePath),
        imports: parseImports(content, filePath).map(i => i.replace(/\\/g, '/')),
        size: content.length,
      };
    } catch { /* binary or unreadable, skip */ }
  }

  // Detect API routes
  const apiRoutes = detectApiRoutes(files);

  // Detect services
  const services = detectServices(graph);

  // Build final output
  const output = {
    generated: new Date().toISOString(),
    fingerprint: projectFingerprint(files),
    fileCount: Object.keys(graph).length,
    apiRoutes,
    services,
    graph,
  };

  // Cache
  try { writeFileSync(GRAPH_CACHE, JSON.stringify(output, null, 2)); } catch {}

  if (outputFormat === 'json') {
    console.log(JSON.stringify(output));
  } else {
    console.log(formatGraphAsMarkdown(output));
  }
}

// ─── Markdown formatter ─────────────────────────────────────────

function formatGraphAsMarkdown(output) {
  let md = `## Codebase Graph\n`;
  md += `Generated: ${output.generated} | ${output.fileCount} source files | ${output.apiRoutes.length} API routes\n\n`;

  // API Routes section
  if (output.apiRoutes.length > 0) {
    md += `### API Routes\n`;
    for (const route of output.apiRoutes.sort((a, b) => a.path.localeCompare(b.path))) {
      md += `- \`${route.methods.join('/')} ${route.path}\`\n`;
    }
    md += `\n`;
  }

  // Core libraries section
  const libs = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'library')
    .sort(([a], [b]) => a.localeCompare(b));
  
  if (libs.length > 0) {
    md += `### Core Libraries\n`;
    for (const [path, node] of libs) {
      const exports = node.exports.filter(e => !e.startsWith('model:')).slice(0, 8);
      if (exports.length > 0) {
        md += `- \`${path}\` — exports: ${exports.join(', ')}\n`;
      } else {
        md += `- \`${path}\`\n`;
      }
    }
    md += `\n`;
  }

  // Scripts
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

  // Components
  const components = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'component' || n.role === 'page' || n.role === 'layout')
    .sort(([a], [b]) => a.localeCompare(b));
  
  if (components.length > 0) {
    md += `### UI Components & Pages\n`;
    for (const [path, node] of components) {
      md += `- \`${path}\` (${node.role})\n`;
    }
    md += `\n`;
  }

  // Schema
  const schemas = Object.entries(output.graph)
    .filter(([, n]) => n.role === 'schema');
  
  if (schemas.length > 0) {
    md += `### Database Schema\n`;
    for (const [path, node] of schemas) {
      const models = node.exports.filter(e => e.startsWith('model:')).map(e => e.slice(6));
      if (models.length > 0) {
        md += `- \`${path}\` — models: ${models.join(', ')}\n`;
      }
    }
    md += `\n`;
  }

  // Service dependency map
  if (output.services && Object.keys(output.services).length > 0) {
    md += `### API → Service Dependencies\n`;
    for (const [service, routes] of Object.entries(output.services)) {
      md += `- \`${service}\` used by: ${routes.map(r => r.replace('src/app', '')).join(', ')}\n`;
    }
    md += `\n`;
  }

  return md;
}

main();

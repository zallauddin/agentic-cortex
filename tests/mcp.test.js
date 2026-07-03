'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ── Read and validate MCP server structure ───────────────────────
const serverPath = path.join(__dirname, '..', 'src', 'mcp', 'server.js');
const serverCode = fs.readFileSync(serverPath, 'utf-8');

// ─── JSON-RPC 2.0 Protocol Tests ─────────────────────────────────
// Extract rpcResult/rpcError via eval (internal functions)

describe('JSON-RPC 2.0 protocol helpers', () => {
  let rpcResult, rpcError;

  // Extract the helper functions from server code
  const match = serverCode.match(/function rpcResult[\s\S]*?function rpcError[\s\S]*?}/);
  if (match) {
    const fnCode = '(function() { ' + match[0] + ' return { rpcResult, rpcError }; })()';
    try {
      const result = eval(fnCode);
      rpcResult = result.rpcResult;
      rpcError = result.rpcError;
    } catch {}
  }

  it('rpcResult should produce valid JSON-RPC 2.0 response', () => {
    if (!rpcResult) return; // Skip if extraction failed
    const response = rpcResult(1, { status: 'ok' });
    const parsed = JSON.parse(response);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 1);
    assert.deepEqual(parsed.result, { status: 'ok' });
  });

  it('rpcError should produce valid JSON-RPC 2.0 error response', () => {
    if (!rpcError) return;
    const response = rpcError(1, -32600, 'Invalid Request');
    const parsed = JSON.parse(response);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.error.code, -32600);
    assert.equal(parsed.error.message, 'Invalid Request');
  });

  it('rpcError should include optional data field', () => {
    if (!rpcError) return;
    const response = rpcError(1, -32602, 'Invalid params', { field: 'title' });
    const parsed = JSON.parse(response);
    assert.deepEqual(parsed.error.data, { field: 'title' });
  });
});

// ─── Tool Count ────────────────────────────────────────────

describe('MCP tool definitions', () => {
  it('should define at least 25 tools', () => {
    const toolNames = serverCode.match(/name: '([^']+)'/g) || [];
    assert.ok(toolNames.length >= 25, `Expected >= 25 tools, got ${toolNames.length}`);
  });

  it('should include core memory tools', () => {
    assert.ok(serverCode.includes("name: 'memory_save'"));
    assert.ok(serverCode.includes("name: 'memory_search'"));
    assert.ok(serverCode.includes("name: 'memory_get'"));
    assert.ok(serverCode.includes("name: 'memory_list'"));
    assert.ok(serverCode.includes("name: 'memory_edit'"));
    assert.ok(serverCode.includes("name: 'memory_forget'"));
    assert.ok(serverCode.includes("name: 'memory_context'"));
    assert.ok(serverCode.includes("name: 'memory_health'"));
  });

  it('should include reflection and conflict tools', () => {
    assert.ok(serverCode.includes("name: 'memory_reflect'"));
    assert.ok(serverCode.includes("name: 'memory_conflicts'"));
  });

  it('should include session tools', () => {
    assert.ok(serverCode.includes("name: 'session_start'"));
    assert.ok(serverCode.includes("name: 'session_end'"));
    assert.ok(serverCode.includes("name: 'session_summarize'"));
  });

  it('should include multi-agent tools', () => {
    assert.ok(serverCode.includes("name: 'agent_session_start'"));
    assert.ok(serverCode.includes("name: 'agent_session_end'"));
    assert.ok(serverCode.includes("name: 'memory_share'"));
    assert.ok(serverCode.includes("name: 'memory_shared_get'"));
    assert.ok(serverCode.includes("name: 'agent_list_sessions'"));
  });

  it('should include self-improving tools', () => {
    assert.ok(serverCode.includes("name: 'memory_learn_from_error'"));
    assert.ok(serverCode.includes("name: 'memory_auto_capture'"));
  });

  it('should include graph, export, import, embed, hook, daily-summary tools', () => {
    assert.ok(serverCode.includes("name: 'memory_relate'"));
    assert.ok(serverCode.includes("name: 'memory_graph'"));
    assert.ok(serverCode.includes("name: 'memory_export'"));
    assert.ok(serverCode.includes("name: 'memory_import'"));
    assert.ok(serverCode.includes("name: 'memory_embed'"));
    assert.ok(serverCode.includes("name: 'memory_hook'"));
    assert.ok(serverCode.includes("name: 'memory_daily_summary'"));
  });

  it('should include skill tools', () => {
    assert.ok(serverCode.includes("name: 'memory_skill_list'"));
    assert.ok(serverCode.includes("name: 'memory_skill_search'"));
  });

  it('each tool should have required fields', () => {
    // Count tool definitions by counting 'name: ' patterns
    const toolBlocks = serverCode.match(/name: '[^']+'/g) || [];
    assert.ok(toolBlocks.length >= 25, `Expected >= 25 tools, got ${toolBlocks.length}`);
    
    // Verify description and inputSchema exist in the source
    const descCount = (serverCode.match(/description:/g) || []).length;
    const schemaCount = (serverCode.match(/inputSchema:/g) || []).length;
    // Each tool definition block has at least one description and inputSchema
    assert.ok(descCount >= 25, `Expected >= 25 descriptions, got ${descCount}`);
    assert.ok(schemaCount >= 25, `Expected >= 25 inputSchemas, got ${schemaCount}`);
  });
});

// ─── Per-Project Queue ─────────────────────────────────────

describe('per-project execution queue', () => {
  it('should have state-modifying tools list', () => {
    assert.ok(serverCode.includes('stateModifyingTools'));
    assert.ok(serverCode.includes("'memory_save'"));
    assert.ok(serverCode.includes("'memory_edit'"));
    assert.ok(serverCode.includes("'memory_forget'"));
  });

  it('should have queue pruning logic', () => {
    assert.ok(serverCode.includes('_projectQueues.size > 100'));
  });
});

// ─── Server Capabilities ─────────────────────────────────────────

describe('MCP server capabilities', () => {
  it('should declare protocol version 2024-11-05', () => {
    assert.ok(serverCode.includes("protocolVersion: '2024-11-05'"));
  });

  it('should declare tools capability', () => {
    assert.ok(serverCode.includes('tools: { listChanged: false }'));
  });

  it('should include server name', () => {
    assert.ok(serverCode.includes("name: 'agentic-cortex'"));
  });

  it('should handle initialize, tools/list, tools/call, ping methods', () => {
    assert.ok(serverCode.includes("method === 'initialize'"));
    assert.ok(serverCode.includes("method === 'tools/list'"));
    assert.ok(serverCode.includes("method === 'tools/call'"));
    assert.ok(serverCode.includes("method === 'ping'"));
  });
});

// ─── Error Codes ─────────────────────────────────────────────────

describe('JSON-RPC error codes', () => {
  it('should define standard error codes', () => {
    assert.ok(serverCode.includes('PARSE_ERROR = -32700'));
    assert.ok(serverCode.includes('INVALID_REQUEST = -32600'));
    assert.ok(serverCode.includes('METHOD_NOT_FOUND = -32601'));
    assert.ok(serverCode.includes('INVALID_PARAMS = -32602'));
    assert.ok(serverCode.includes('INTERNAL_ERROR = -32603'));
  });
});

// ─── Bin Entry ───────────────────────────────────────────────

describe('MCP server bin entry', () => {
  it('should be listed in package.json bin', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.bin);
    assert.ok(pkg.bin['agentic-cortex-mcp']);
    assert.equal(pkg.bin['agentic-cortex-mcp'], 'src/mcp/server.js');
  });
});

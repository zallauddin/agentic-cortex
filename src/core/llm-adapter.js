/**
 * llm-adapter.js — Pluggable model-provider adapter API for agentic-cortex.
 *
 * AC's reasoning modules (tree-search, PRM, reflexion, compactor, session
 * summarization, …) all funnel through one entry point: `callProvider()`.
 * A provider adapter answers two questions:
 *
 *   available()               — can we serve a completion right now?
 *   complete(messages, opts)  — chat-style completion, returns text or null
 *
 * Built-in adapters:
 *
 *   openai    — any OpenAI-compatible /v1/chat/completions endpoint:
 *               llama.cpp, LM Studio, Ollama (/v1), vLLM, OpenRouter, OpenAI.
 *               Selected by default. Base URL + model + key via env:
 *                 AGENTIC_CORTEX_LLM_BASE_URL  (or legacy LLAMA_CPP_BASE_URL)
 *                 AGENTIC_CORTEX_LLM_MODEL
 *                 AGENTIC_CORTEX_LLM_API_KEY
 *   xenova    — fully local/offline generation via @xenova/transformers
 *               (text2text-generation). No network, no API key, no telemetry.
 *               Model via AGENTIC_CORTEX_LLM_LOCAL_MODEL
 *               (default: Xenova/LaMini-Flan-T5-77M — small, CPU-friendly).
 *   off       — deterministic mode: always returns null so callers use their
 *               template/deterministic fallbacks. Zero LLM dependency.
 *
 * Selection: AGENTIC_CORTEX_LLM_PROVIDER = openai | xenova | off  (default openai)
 *
 * Contract: `callProvider()` NEVER throws for "provider unavailable" — it
 * returns null and the caller falls back (same semantics as the original
 * session.callLLM). Misconfiguration throws once, loudly, at resolve time.
 */

'use strict';

const { LLAMA_URL } = require('./constants');

// ─── Provider registry ───────────────────────────────────────────────────────

const PROVIDERS = {};

/**
 * Register an adapter. Exposed for third-party/custom providers:
 *   require('agentic-cortex/src/core/llm-adapter')
 *     .registerProvider('my-cloud', myAdapter);
 */
function registerProvider(name, adapter) {
  if (!adapter || typeof adapter.complete !== 'function') {
    throw new Error('adapter for "' + name + '" must implement complete(messages, opts)');
  }
  PROVIDERS[name] = { name, available: adapter.available || (() => true), complete: adapter.complete };
}

// ─── openai (OpenAI-compatible HTTP endpoints) ───────────────────────────────

function openaiBaseUrl() {
  return process.env.AGENTIC_CORTEX_LLM_BASE_URL || LLAMA_URL;
}

function openaiModel(opts) {
  return opts.model || process.env.AGENTIC_CORTEX_LLM_MODEL || null;
}

registerProvider('openai', {
  available() {
    return !!openaiBaseUrl();
  },
  async complete(messages, opts = {}) {
    const body = {
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2000,
      stream: false,
    };
    const model = openaiModel(opts);
    if (model) body.model = model;

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.AGENTIC_CORTEX_LLM_API_KEY;
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    const res = await fetch(openaiBaseUrl().replace(/\/+$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? 300000),
    });

    if (!res.ok) {
      throw new Error('LLM error ' + res.status + ': ' + (await res.text()));
    }

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content || '';

    // Qwen 3.5 thinking models put output in reasoning_content when
    // max_tokens is exhausted on thinking tokens, leaving content empty.
    if (!content) {
      const rc = data.choices?.[0]?.message?.reasoning_content;
      if (typeof rc === 'string' && rc.length > 0) content = rc;
    }

    return content;
  },
});

// ─── xenova (fully local, offline generation) ────────────────────────────────

let _localPipeline = null;
let _localModel = null;

function localModelName() {
  return process.env.AGENTIC_CORTEX_LLM_LOCAL_MODEL || 'Xenova/LaMini-Flan-T5-77M';
}

async function getLocalPipeline() {
  const model = localModelName();
  if (_localPipeline && _localModel === model) return _localPipeline;
  const { pipeline } = require('@xenova/transformers');
  _localPipeline = await pipeline('text2text-generation', model);
  _localModel = model;
  return _localPipeline;
}

/** Flatten a chat conversation into a single instruction prompt for T5-style models. */
function flattenMessages(messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const dialogue = turns.map((m) => (m.role === 'user' ? m.content : 'Answer: ' + m.content)).join('\n');
  return sys ? sys + '\n\n' + dialogue : dialogue;
}

registerProvider('xenova', {
  available() {
    try {
      require.resolve('@xenova/transformers');
      return true;
    } catch {
      return false;
    }
  },
  async complete(messages, opts = {}) {
    const pipe = await getLocalPipeline();
    const out = await pipe(flattenMessages(messages), {
      max_new_tokens: Math.min(opts.maxTokens ?? 512, 1024),
      temperature: opts.temperature ?? 0.3,
      do_sample: (opts.temperature ?? 0.3) > 0,
      no_repeat_ngram_size: 3,
    });
    const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  },
});

// ─── off (deterministic mode) ────────────────────────────────────────────────

registerProvider('off', {
  available() { return true; },
  async complete() { return null; },
});

// ─── Resolution + entry point ────────────────────────────────────────────────

function providerName() {
  const p = (process.env.AGENTIC_CORTEX_LLM_PROVIDER || 'openai').toLowerCase();
  if (!PROVIDERS[p]) {
    throw new Error(
      'Unknown AGENTIC_CORTEX_LLM_PROVIDER "' + p + '". Known: ' + Object.keys(PROVIDERS).join(', ')
    );
  }
  return p;
}

/**
 * The single LLM entry point for all AC reasoning modules.
 * Returns generated text, or null when the provider is unavailable
 * (callers then use their deterministic/template fallbacks).
 */
async function callProvider(messages, opts = {}) {
  const provider = PROVIDERS[providerName()];
  try {
    const text = await provider.complete(messages, opts);
    return typeof text === 'string' && text.trim().length > 0 ? text : null;
  } catch (err) {
    if (
      err.code === 'ECONNREFUSED' ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('fetch failed') ||
      err.name === 'TimeoutError'
    ) {
      return null; // Signal provider unavailable — caller handles fallback
    }
    throw err;
  }
}

/**
 * Health/diagnostics snapshot used by `cli llm-status`, /health and /metrics.
 */
async function llmStatus() {
  const name = providerName();
  const provider = PROVIDERS[name];
  const base = {
    provider: name,
    configured: true,
    model: name === 'openai' ? (openaiModel({}) || '(server default)')
         : name === 'xenova' ? localModelName()
         : null,
  };
  if (name === 'openai') base.baseUrl = openaiBaseUrl();
  try {
    base.available = await provider.available();
  } catch (err) {
    base.available = false;
    base.error = err.message;
  }
  return base;
}

module.exports = {
  callProvider,
  registerProvider,
  providerName,
  llmStatus,
  // exported for tests
  _providers: PROVIDERS,
  _flattenMessages: flattenMessages,
};

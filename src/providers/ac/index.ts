import { mkdir } from "node:fs/promises"
import { statSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

// CJS interop: agentic-cortex is a CommonJS module; bare `require` is
// unavailable in ESM under Node, so create one scoped to this file.
const require = createRequire(import.meta.url)
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"

const BASE_DIR = join(process.cwd(), "data", "providers", "agentic-cortex")

export class ACProvider implements Provider {
  name = "agentic-cortex"
  // NOTE: deliberately no `prompts` override. The harness's ProviderPrompts
  // shape is `{ answerPrompt?, judgePrompt? }`; AC's own extract/answer prompt
  // vocabulary (see ./prompts.ts) does not map onto it, so claiming the field
  // would type-error AND silently swap the harness's default answer prompt out
  // from under reported benchmark numbers. Leaving it unset keeps every
  // provider on the harness default — the controlled configuration.
  concurrency = {
    default: 50,
    ingest: 200,
    indexing: 200,
  }

  private api: any = null
  private projectPath: string = ""
  private initialized = false

  async initialize(config: ProviderConfig): Promise<void> {
    this.projectPath = config.baseUrl || process.cwd()

    // Load agentic-cortex API from config or auto-discover
    // ProviderConfig is `{ apiKey: string; [key: string]: unknown }`, so the
    // extension key arrives as `unknown` — narrow it before handing it to
    // require(), otherwise a non-string value throws deep in module loading.
    const acApiPath = config.acApiPath
    if (typeof acApiPath === "string" && acApiPath.length > 0) {
      this.api = require(acApiPath)
    } else {
      // Try to find agentic-cortex API in common locations
      const candidates = [
        join(this.projectPath, "src", "api", "index.js"),
        join(this.projectPath, "node_modules", "agentic-cortex", "src", "api", "index.js"),
        join(process.env.AGENTIC_CORTEX_PATH || "", "src", "api", "index.js"),
      ]
      for (const c of candidates) {
        try {
          const stat = statSync(c)
          if (stat.isFile()) {
            this.api = require(c)
            logger.info(`Auto-discovered agentic-cortex API at ${c}`)
            break
          }
        } catch {}
      }
      if (!this.api) {
        throw new Error(
          "agentic-cortex API not found. Set config.acApiPath or AGENTIC_CORTEX_PATH " +
          "to the project root containing src/api/index.js"
        )
      }
    }

    await mkdir(BASE_DIR, { recursive: true })
    logger.info(`Initialized agentic-cortex provider (project: ${this.projectPath})`)
    this.initialized = true
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.initialized) throw new Error("Provider not initialized")

    const project = join(this.projectPath, options.containerTag)
    const documentIds: string[] = []

    for (const session of sessions) {
      const messages = session.messages
      const date = (session.metadata?.formattedDate as string) || (session.metadata?.date as string) || "unknown"
      const speakerA = session.metadata?.speaker_a || "Speaker A"
      const speakerB = session.metadata?.speaker_b || "Speaker B"

      const turns = messages.map((m) => {
        const speaker = m.role === "user" ? speakerA : speakerB
        return `[${speaker}]: ${m.content}`
      })
      const transcript = turns.join("\n")
      const sessionId = session.sessionId
      const safeId = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)

      await this.api.save({
        title: `${sessionId} (${date})`,
        content: transcript,
        type: "fact",
        tags: ["memorybench", "locomo", options.containerTag, "session-transcript"],
        project,
        session: sessionId,
        importance: 3,
        confidence: 100,
        provenance: "observed",
      })
      documentIds.push(safeId)

      for (const m of messages) {
        const text = (m.content || "").trim()
        if (text.length < 30) continue
        await this.api.save({
          title: `${sessionId} - turn`,
          content: `[${m.role === "user" ? speakerA : speakerB}]: ${text}`,
          type: "observation",
          tags: ["memorybench", "locomo", options.containerTag, "dialog-turn"],
          project,
          session: sessionId,
          importance: 1,
          confidence: 100,
          provenance: "observed",
        })
      }
    }

    logger.info(`Ingested ${sessions.length} sessions (${documentIds.length} docs)`)
    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback,
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.initialized) throw new Error("Provider not initialized")

    const project = join(this.projectPath, options.containerTag)

    const results = await this.api.search(query, {
      project,
      limit: options.limit || 10,
      rerank: true,
      // Breadth control: cap fragments per conversation so one long session
      // cannot fill every k slot with near-duplicate turns. Measured in
      // scripts/strategy-sweep.js to raise recall on BOTH benchmark corpora;
      // strict per-session deduplication instead *lost* 13 points on LoCoMo,
      // whose answers need several turns of the same conversation.
      maxPerSession: 3,
    })

    // Hydrate full content by id: AC's search returns only a 300-char
    // preview (substr(o.content, 1, 300)), which would silently truncate
    // retrieved evidence before the judge/metric ever sees it. Ranking is
    // unchanged — only the payload is completed, exactly as a real consumer
    // does (memory_search -> memory_get).
    const hydrate = (r: any): string => {
      if (r.content && !r.preview) return r.content
      try {
        const full = this.api.get?.(Number(r.id))
        if (full && typeof full.content === "string" && full.content.length > 0) {
          return full.content
        }
      } catch { /* fall back to preview */ }
      return r.preview || r.content || r.title || ""
    }

    return results.map((r: any) => ({
      id: String(r.id),
      content: hydrate(r),
      score: r.rerank_score ?? r.combined_score ?? r.semantic_score ?? 0,
      metadata: {
        type: r.type,
        confidence: r.confidence,
        provenance: r.provenance,
      },
    }))
  }

  async clear(containerTag: string): Promise<void> {
    const project = join(this.projectPath, containerTag)
    const rows = this.api.list({ project, limit: 10000 })
    for (const r of rows) {
      try { await this.api.forget(r.id, { hard: true }) } catch {}
    }
    logger.info(`Cleared agentic-cortex data for: ${containerTag}`)
  }
}

export default ACProvider

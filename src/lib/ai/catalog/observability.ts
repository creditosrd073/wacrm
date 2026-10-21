// ============================================================
// Mission D audit (Oct 2026), Fase 7 ("OBSERVABILIDAD Y DIAGNÓSTICO") —
// derives a structured, PII-free trace of this turn's catalog searches
// from `toolCalls[]` alone — never a new query, never raw conversation
// text. Written to `ai_usage_log` (migration 063) by usage.ts, so a
// brand/category search that comes back empty/partial, or a reply the
// commercial-claims verifier had to intercept, leaves a queryable
// record of WHERE it happened: the DB query itself (status: 'error'),
// pagination/classification (status: 'vacia'/'parcial' +
// productKindSplit), or neither — the model just didn't use the real
// results it got (that last case is NOT diagnosable from this trace
// alone; it shows up as `search_completion_status: 'completa'`
// alongside `commercial_validation_passed: false` on the SAME row,
// which is itself the diagnostic signal: the data was fine, the
// generation wasn't).
//
// Never logs: raw conversation text, customer name/phone, credentials,
// tokens. A product search's query text is business data about the
// CATALOG, not personal data about the customer.
// ============================================================

import type { ToolCallLogEntry } from '../types'
import { SEARCH_CATALOG } from '../tools/catalog-tools'

export type SearchCompletionStatus = 'completa' | 'parcial' | 'vacia' | 'error'

export interface CatalogSearchTraceEntry {
  query: string
  offset: number
  limit?: number
  returned?: number
  total: number | null
  hasMore?: boolean
  status: SearchCompletionStatus
  /** Same shape as facets.ts's CatalogFacets['productKindSplit'] — the
   *  honest "why some of this didn't look like a real smartphone"
   *  signal, carried straight through from this call's own result,
   *  never recomputed. Absent when the result had no facets at all
   *  (e.g. zero products, or a provider that doesn't compute them). */
  productKindSplit?: { likelyAccessoryOrPart: number; likelyResidentialPhone: number; likelyDevice: number }
}

const STATUS_SEVERITY: Record<SearchCompletionStatus, number> = { error: 3, parcial: 2, vacia: 1, completa: 0 }

function traceOneSearchCall(call: ToolCallLogEntry): CatalogSearchTraceEntry {
  const input = (call.input ?? {}) as Record<string, unknown>
  const result = (call.result ?? {}) as Record<string, unknown>
  const query = typeof input.query === 'string' ? input.query : ''
  const offset = typeof input.offset === 'number' ? input.offset : 0
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  const returned = typeof result.returned === 'number' ? result.returned : undefined
  const total = typeof result.total === 'number' ? result.total : null
  const hasMore = typeof result.has_more === 'boolean' ? result.has_more : undefined

  let status: SearchCompletionStatus
  if (typeof result.error === 'string') {
    status = 'error'
  } else if ((returned ?? 0) === 0 && total === 0) {
    status = 'vacia'
  } else if (hasMore === true) {
    status = 'parcial'
  } else {
    status = 'completa'
  }

  const facets = result.facets as Record<string, unknown> | undefined
  const productKindSplit = facets?.productKindSplit as CatalogSearchTraceEntry['productKindSplit'] | undefined

  return { query, offset, limit, returned, total, hasMore, status, productKindSplit }
}

/**
 * One entry per `search_catalog` call this turn, plus the single WORST
 * (most actionable) status across all of them — `error` > `parcial` >
 * `vacia` > `completa` — so a turn that made 3 searches and only ONE
 * failed/partial is never summarized as if every search succeeded.
 *
 * Other catalog tools (`get_product`/`get_availability`/
 * `get_product_media`) are intentionally excluded: they're single-item
 * lookups with no pagination/partial-result concept to diagnose here.
 */
export function buildCatalogSearchTrace(toolCalls: ToolCallLogEntry[]): {
  entries: CatalogSearchTraceEntry[]
  overallStatus: SearchCompletionStatus | null
} {
  const entries = toolCalls.filter((c) => c.name === SEARCH_CATALOG).map(traceOneSearchCall)
  if (entries.length === 0) return { entries, overallStatus: null }
  const overallStatus = entries.reduce<SearchCompletionStatus>(
    (worst, e) => (STATUS_SEVERITY[e.status] > STATUS_SEVERITY[worst] ? e.status : worst),
    entries[0].status,
  )
  return { entries, overallStatus }
}

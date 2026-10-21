import { describe, it, expect } from 'vitest'
import { buildCatalogSearchTrace } from './observability'
import type { ToolCallLogEntry } from '../types'

// ============================================================
// Mission D audit (Oct 2026), Fase 7 — pure function, no DB, no
// network. Every case is a plain input (toolCalls, the exact shape
// search_catalog already returns to the model) / output assertion.
// ============================================================

function searchCall(input: Record<string, unknown>, result: Record<string, unknown>): ToolCallLogEntry {
  return { name: 'search_catalog', input, result }
}

describe('buildCatalogSearchTrace', () => {
  it('no search_catalog call this turn → empty trace, overallStatus null', () => {
    const trace = buildCatalogSearchTrace([{ name: 'get_availability', input: { id: 'x' }, result: { productId: 'x', available: true, availableQuantity: 3 } }])
    expect(trace.entries).toEqual([])
    expect(trace.overallStatus).toBeNull()
  })

  it('a genuinely complete search (no more pages) is "completa"', () => {
    const trace = buildCatalogSearchTrace([
      searchCall({ query: 'samsung a26', limit: 10 }, { products: [{}], returned: 1, total: 1, has_more: false }),
    ])
    expect(trace.entries).toEqual([{ query: 'samsung a26', offset: 0, limit: 10, returned: 1, total: 1, hasMore: false, status: 'completa' }])
    expect(trace.overallStatus).toBe('completa')
  })

  it('has_more: true is "parcial" regardless of how many were returned', () => {
    const trace = buildCatalogSearchTrace([searchCall({ query: 'tv', limit: 5 }, { products: [{}], returned: 5, total: 20, has_more: true })])
    expect(trace.entries[0].status).toBe('parcial')
    expect(trace.overallStatus).toBe('parcial')
  })

  it('a confirmed zero-match search (returned: 0, total: 0) is "vacia", not "error" or "parcial"', () => {
    const trace = buildCatalogSearchTrace([searchCall({ query: 'producto-inexistente' }, { products: [], returned: 0, total: 0, has_more: false })])
    expect(trace.entries[0].status).toBe('vacia')
  })

  it('a tool-level error ({ error: "catalog_unavailable" }) is "error", never confused with a confirmed empty result', () => {
    const trace = buildCatalogSearchTrace([searchCall({ query: 'tv' }, { error: 'catalog_unavailable' })])
    expect(trace.entries[0]).toMatchObject({ status: 'error', total: null })
  })

  it('a scan cut short by the time budget (total: null, has_more: true) is "parcial", never silently "completa"', () => {
    const trace = buildCatalogSearchTrace([searchCall({ query: 'televisor' }, { products: [{}], returned: 1, total: null, has_more: true })])
    expect(trace.entries[0].status).toBe('parcial')
  })

  it('carries facets.productKindSplit through unchanged when present', () => {
    const productKindSplit = { likelyAccessoryOrPart: 5, likelyResidentialPhone: 1, likelyDevice: 1 }
    const trace = buildCatalogSearchTrace([
      searchCall({ query: 'samsung' }, { products: [{}], returned: 7, total: 7, has_more: false, facets: { productKindSplit } }),
    ])
    expect(trace.entries[0].productKindSplit).toEqual(productKindSplit)
  })

  it('overallStatus is the WORST status across multiple searches this turn, not just the last one', () => {
    const trace = buildCatalogSearchTrace([
      searchCall({ query: 'samsung a36' }, { products: [{}], returned: 1, total: 1, has_more: false }), // completa
      searchCall({ query: 'samsung a26' }, { error: 'catalog_unavailable' }), // error
      searchCall({ query: 'samsung a56' }, { products: [{}], returned: 1, total: 1, has_more: false }), // completa
    ])
    expect(trace.overallStatus).toBe('error')
    expect(trace.entries).toHaveLength(3)
  })

  it('a partial result among otherwise-complete ones still surfaces as "parcial" overall', () => {
    const trace = buildCatalogSearchTrace([
      searchCall({ query: 'a' }, { products: [{}], returned: 1, total: 1, has_more: false }),
      searchCall({ query: 'b' }, { products: [{}], returned: 5, total: 50, has_more: true }),
    ])
    expect(trace.overallStatus).toBe('parcial')
  })

  it('get_product/get_availability/get_product_media calls are excluded from the trace entirely', () => {
    const trace = buildCatalogSearchTrace([
      { name: 'get_product', input: { id: 'x' }, result: { product: {} } },
      { name: 'get_product_media', input: { id: 'x' }, result: { error: 'not_found' } },
      searchCall({ query: 'tv' }, { products: [{}], returned: 1, total: 1, has_more: false }),
    ])
    expect(trace.entries).toHaveLength(1)
    expect(trace.entries[0].query).toBe('tv')
  })
})

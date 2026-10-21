import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DataSourceCatalogProvider } from './data-source-provider'

// ============================================================
// AI Sales Agent audit, Part 2/24 ("RESULTADOS PARCIALES"): this
// provider is the ONE place that turns a raw ai_catalog_products query
// into { products, total, hasMore } — the signal the agent needs to
// know it's looking at a partial page rather than "all we have".
// Previously untested directly (only indirectly, through a mocked
// stand-in, via resolver.test.ts).
// ============================================================

interface RpcCall {
  fn: string
  params: Record<string, unknown>
}

function fakeDb(opts: {
  rpcRows?: Record<string, unknown>[]
  rpcError?: { message: string } | null
  scanRows?: Record<string, unknown>[]
  scanError?: { message: string } | null
}) {
  const rpcCalls: RpcCall[] = []
  const db = {
    rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      if (opts.rpcError) return { data: null, error: opts.rpcError }
      return { data: opts.rpcRows ?? [], error: null }
    }),
    from: (table: string) => {
      if (table !== 'ai_catalog_products') throw new Error(`unexpected table ${table}`)
      const filters: [string, unknown][] = []
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          filters.push([col, val])
          return api
        },
        order: () => api,
        // Broad-search reliability audit (Oct 2026) — the fallback tier
        // now paginates via .range() instead of a single .limit() call
        // (see data-source-provider.ts's FALLBACK_SCAN_PAGE_SIZE doc).
        // Faithfully slices `scanRows` so a fixture larger than one page
        // (see the dedicated pagination test below) is actually
        // exercised across multiple simulated round trips, not just
        // returned whole on the first call.
        range: (from: number, to: number) =>
          Promise.resolve(
            opts.scanError ? { data: null, error: opts.scanError } : { data: (opts.scanRows ?? []).slice(from, to + 1), error: null },
          ),
        maybeSingle: () => {
          if (opts.scanError) return Promise.resolve({ data: null, error: opts.scanError })
          const sourceProductId = filters.find(([c]) => c === 'source_product_id')?.[1]
          const match = (opts.scanRows ?? []).find((r) => r.source_product_id === sourceProductId)
          return Promise.resolve({ data: match ?? null, error: null })
        },
      }
      return api
    },
  }
  return { db: db as unknown as SupabaseClient, rpcCalls }
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-1',
    source_product_id: 'row-1',
    sku: null,
    name: 'TV TCL GOOGLE TV 50 4K',
    brand: 'TCL',
    model: null,
    description: null,
    color: null,
    variant_label: null,
    capacity: null,
    size: null,
    price: 25000,
    currency: 'DOP',
    available: true,
    available_quantity: 5,
    primary_image_url: null,
    images: [],
    ...over,
  }
}

describe('DataSourceCatalogProvider.searchCatalog — DB tier pagination', () => {
  it('Caso "resultados parciales": total=25, limit=10 → hasMore=true, total reported honestly', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${i}`, source_product_id: `r${i}`, total_count: 25 }))
    const { db, rpcCalls } = fakeDb({ rpcRows: rows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'tv', limit: 10, offset: 0 })
    expect(result.products).toHaveLength(10)
    expect(result.total).toBe(25)
    expect(result.hasMore).toBe(true)
    expect(rpcCalls[0].params).toMatchObject({ p_match_count: 10, p_offset: 0, p_available_only: false })
  })

  it('the next page (offset=10) reflects the remaining rows and eventually hasMore=false', async () => {
    // Page 2 of 25: rows 10-19, still 5 more after this page.
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${10 + i}`, source_product_id: `r${10 + i}`, total_count: 25 }))
    const { db, rpcCalls } = fakeDb({ rpcRows: rows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'tv', limit: 10, offset: 10 })
    expect(result.total).toBe(25)
    expect(result.hasMore).toBe(true) // 10 + 10 = 20 < 25
    expect(rpcCalls[0].params).toMatchObject({ p_offset: 10 })
  })

  it('the last page reports hasMore=false once offset+returned reaches total', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `r${20 + i}`, source_product_id: `r${20 + i}`, total_count: 25 }))
    const { db } = fakeDb({ rpcRows: rows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'tv', limit: 10, offset: 20 })
    expect(result.hasMore).toBe(false) // 20 + 5 = 25, nothing left
    expect(result.total).toBe(25)
  })

  it('passes availableOnly through to the RPC as p_available_only', async () => {
    const { db, rpcCalls } = fakeDb({ rpcRows: [row({ total_count: 1 })] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    await provider.searchCatalog({ query: 'tv', availableOnly: true })
    expect(rpcCalls[0].params.p_available_only).toBe(true)
  })

  it('a genuinely empty result at offset 0 reports total=0, not null (a real "no matches")', async () => {
    const { db } = fakeDb({ rpcRows: [] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    const result = await provider.searchCatalog({ query: 'producto-inexistente-xyz' })
    expect(result.products).toEqual([])
    expect(result.total).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('an RPC error degrades to an empty, honestly-unknown-total result instead of throwing, flagged as a real failure (not a confirmed no-match)', async () => {
    const { db } = fakeDb({ rpcError: { message: 'db down' } })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    const result = await provider.searchCatalog({ query: 'tv' })
    // hadError: true (AI agent audit) — distinguishes this from the
    // genuinely-empty case above, which has NO such flag. Without it,
    // catalog-tools.ts/the model cannot tell a real query failure apart
    // from a confirmed "no existe" and could wrongly deny the product.
    expect(result).toEqual({ products: [], total: null, hasMore: false, hadError: true })
  })
})

describe('DataSourceCatalogProvider.searchCatalog — model-code queries never match a longer, unrelated code (real audit, Oct 2026)', () => {
  it('CRITICAL: "a26" excludes an unrelated "A2603" row even though migration 047\'s ILIKE matched it — real names from the "Consultas KC" catalog', async () => {
    const realMatch = row({ id: 'r1', source_product_id: 'r1', name: 'SAMSUNG A26 5G 128GB + 6GB NEGRO', total_count: 2 })
    const falsePositive = row({
      id: 'r2',
      source_product_id: 'r2',
      name: 'Touch Screen Digitizer For iPad 9 10.2 9th Gen A2603 A2604 A2602 2021',
      total_count: 2,
    })
    const { db } = fakeDb({ rpcRows: [realMatch, falsePositive] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'a26', limit: 10, offset: 0 })
    expect(result.products).toHaveLength(1)
    expect(result.products[0].name).toBe('SAMSUNG A26 5G 128GB + 6GB NEGRO')
    // Last/only page (offset+rows=2 === total=2) — the post-filter total
    // is still exactly knowable: 2 - 1 false positive = 1.
    expect(result.total).toBe(1)
    expect(result.hasMore).toBe(false)
  })

  it('a non-model-code query (a plain brand/word) is never filtered by the word-boundary check', async () => {
    const rows = [row({ id: 'r1', source_product_id: 'r1', name: 'SAMSUNG A26 5G 128GB + 6GB NEGRO', total_count: 1 })]
    const { db } = fakeDb({ rpcRows: rows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    const result = await provider.searchCatalog({ query: 'samsung', limit: 10 })
    expect(result.products).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  it('when a filtered page still has MORE pages left, the total becomes honestly unknown rather than wrong', async () => {
    const realMatch = row({ id: 'r1', source_product_id: 'r1', name: 'SAMSUNG A26 5G 128GB + 6GB NEGRO', total_count: 50 })
    const falsePositive = row({ id: 'r2', source_product_id: 'r2', name: 'IPAD PART A2603', total_count: 50 })
    const { db } = fakeDb({ rpcRows: [realMatch, falsePositive] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'a26', limit: 2, offset: 0 })
    expect(result.products).toHaveLength(1)
    expect(result.total).toBeNull()
    expect(result.hasMore).toBe(true)
  })

  it('if EVERY row on the page is a false positive, falls through to the tolerant fallback tier instead of reporting "not found"', async () => {
    const onlyFalsePositive = row({ id: 'r2', source_product_id: 'r2', name: 'IPAD PART A2603', total_count: 1 })
    const realRowInFallbackScan = row({ id: 'r3', source_product_id: 'r3', name: 'SAMSUNG A26 5G 128GB + 6GB AZUL' })
    const { db } = fakeDb({ rpcRows: [onlyFalsePositive], scanRows: [realRowInFallbackScan] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'a26', limit: 10 })
    expect(result.products).toHaveLength(1)
    expect(result.products[0].name).toBe('SAMSUNG A26 5G 128GB + 6GB AZUL')
  })
})

describe('DataSourceCatalogProvider.searchCatalog — fallback tier (DB-side FTS found nothing)', () => {
  it('falls through to the tolerant ranker and reports a real total/hasMore for it too', async () => {
    const scanRows = [
      row({ id: 'r1', source_product_id: 'r1', name: 'TV TCL GOOGLE TV SMART 50 4K ULTRA HD' }),
      row({ id: 'r2', source_product_id: 'r2', name: 'TV TCL 55 QLED' }),
      row({ id: 'r3', source_product_id: 'r3', name: 'NEVERA WHIRLPOOL 15 PIES' }), // not a match
    ]
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    // "TCL de 50 pulgadas" has no literal "pulgadas" in either TCL row —
    // exercises the exact scenario the fallback tier exists for.
    const result = await provider.searchCatalog({ query: 'tcl de 50 pulgadas', limit: 10 })
    expect(result.products.length).toBeGreaterThan(0)
    expect(result.products.every((p) => p.brand === 'TCL')).toBe(true)
    expect(result.total).toBe(result.products.length)
    expect(result.hasMore).toBe(false)
  })

  it('paginates within the fallback tier too (offset/limit applied after ranking)', async () => {
    const scanRows = Array.from({ length: 8 }, (_, i) =>
      row({ id: `r${i}`, source_product_id: `r${i}`, name: `TV TCL MODELO ${i} 50 PULGADAS` }),
    )
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const page1 = await provider.searchCatalog({ query: 'tcl', limit: 5, offset: 0 })
    expect(page1.products).toHaveLength(5)
    expect(page1.total).toBe(8)
    expect(page1.hasMore).toBe(true)

    const page2 = await provider.searchCatalog({ query: 'tcl', limit: 5, offset: 5 })
    expect(page2.products).toHaveLength(3)
    expect(page2.hasMore).toBe(false)
  })

  it('availableOnly excludes agotados from the fallback tier without hiding them from a specific lookup', async () => {
    const scanRows = [
      row({ id: 'r1', source_product_id: 'r1', name: 'TV TCL 50 DISPONIBLE', available: true, available_quantity: 3 }),
      row({ id: 'r2', source_product_id: 'r2', name: 'TV TCL 50 AGOTADA', available: false, available_quantity: 0 }),
    ]
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const onlyAvailable = await provider.searchCatalog({ query: 'tcl 50', availableOnly: true })
    expect(onlyAvailable.products).toHaveLength(1)
    expect(onlyAvailable.products[0].available).toBe(true)

    const everything = await provider.searchCatalog({ query: 'tcl 50' })
    expect(everything.products).toHaveLength(2) // the agotado one is still findable
  })

  it('without availableOnly, an available match still sorts BEFORE an agotado one — never hidden behind it (AI Sales Agent audit re-pass, Part 9)', async () => {
    // Deliberately inserted agotado-first, and the agotado row is a
    // "better" textual match (appears earlier alphabetically / matches
    // more tokens) than the available one, so a naive score-only sort
    // would put it first. Availability must win as the primary key,
    // same as the DB tier's `ORDER BY available DESC` (migration 047).
    const scanRows = [
      row({ id: 'r1', source_product_id: 'r1', name: 'TV TCL 50 4K AGOTADA', brand: 'TCL', available: false, available_quantity: 0 }),
      row({ id: 'r2', source_product_id: 'r2', name: 'TV TCL 50 QLED', brand: 'TCL', available: true, available_quantity: 4 }),
    ]
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'tcl 50' })
    expect(result.products).toHaveLength(2) // both still findable...
    expect(result.products[0].available).toBe(true) // ...but the available one leads
  })
})

describe('DataSourceCatalogProvider.searchCatalog — no-omission across brands (Part 24 "NO OMISIÓN" dataset)', () => {
  it('a broad "tv" query is not arbitrarily limited to the first brand — every real brand is reachable', async () => {
    // Reproduces the reported real-world bug: "qué TVs tienen" only
    // showing KOOLHOME when Samsung/TCL rows existed too. This dataset
    // has 3 real brands; the fallback tier's tolerant ranker must
    // surface all of them for a plain "tv" query, not silently prefer
    // one.
    const scanRows = [
      row({ id: 'k1', source_product_id: 'k1', name: 'TV KOOLHOME 32 SMART', brand: 'KOOLHOME' }),
      row({ id: 'k2', source_product_id: 'k2', name: 'TV KOOLHOME 43 4K', brand: 'KOOLHOME' }),
      row({ id: 's1', source_product_id: 's1', name: 'TV SAMSUNG 50 QLED', brand: 'Samsung' }),
      row({ id: 's2', source_product_id: 's2', name: 'TV SAMSUNG 55 CRYSTAL UHD', brand: 'Samsung' }),
      row({ id: 't1', source_product_id: 't1', name: 'TV TCL GOOGLE TV 50 4K ULTRA HD', brand: 'TCL' }),
      row({ id: 't2', source_product_id: 't2', name: 'TV TCL 65 QLED', brand: 'TCL' }),
      row({ id: 'n1', source_product_id: 'n1', name: 'NEVERA WHIRLPOOL 15 PIES', brand: 'Whirlpool' }), // not a TV
    ]
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'tv', limit: 20 })
    const brands = new Set(result.products.map((p) => p.brand))
    expect(brands.has('KOOLHOME')).toBe(true)
    expect(brands.has('Samsung')).toBe(true)
    expect(brands.has('TCL')).toBe(true)
    expect(brands.has('Whirlpool')).toBe(false) // the nevera correctly excluded
    expect(result.total).toBe(6) // all 6 TVs, not just one brand's
  })

  it('the same coverage holds for the "televisor"/"tele" synonyms, not just the literal word "tv"', async () => {
    const scanRows = [
      row({ id: 'k1', source_product_id: 'k1', name: 'TV KOOLHOME 32 SMART', brand: 'KOOLHOME' }),
      row({ id: 's1', source_product_id: 's1', name: 'TV SAMSUNG 50 QLED', brand: 'Samsung' }),
    ]
    const { db } = fakeDb({ rpcRows: [], scanRows })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    for (const query of ['televisor', 'tele', 'television']) {
      const result = await provider.searchCatalog({ query, limit: 20 })
      const brands = new Set(result.products.map((p) => p.brand))
      expect(brands.has('KOOLHOME')).toBe(true)
      expect(brands.has('Samsung')).toBe(true)
    }
  })
})

describe('DataSourceCatalogProvider — getProduct/getAvailability/getMedia untouched by the pagination changes', () => {
  it('getProduct still resolves a single row by source_product_id', async () => {
    const { db } = fakeDb({ scanRows: [row({ id: 'r1', source_product_id: 'row-42', name: 'Producto X' })] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    const product = await provider.getProduct('row-42')
    expect(product?.name).toBe('Producto X')
  })
})

// ============================================================
// Bug #4 fix (service.ts's toCatalogProductRows — see service.test.ts
// for the persistence-side dedup tests) resolved through the ACTUAL
// consumer path: once two originally-duplicate-SKU rows are persisted
// with distinct `source_product_id`s, search_catalog must surface both
// with distinct composite ids, and a follow-up get_product/
// getAvailability on EACH of those ids must resolve to the CORRECT,
// distinct product — never "not_found" for either, and never one
// answer bleeding into the other.
// ============================================================
describe('DataSourceCatalogProvider — Bug #4 fix: two originally-duplicate-SKU rows resolve independently', () => {
  const rowA = row({ id: 'row-A', source_product_id: 'DUP1', sku: 'DUP1', name: 'Producto Negro', color: 'Negro', total_count: 2 })
  const rowB = row({ id: 'row-B', source_product_id: 'row-1', sku: 'DUP1', name: 'Producto Blanco', color: 'Blanco', total_count: 2 })

  it('search_catalog returns BOTH rows with DISTINCT composite ids, even though their sku is identical', async () => {
    const { db } = fakeDb({ rpcRows: [rowA, rowB] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'producto' })
    expect(result.products).toHaveLength(2)
    const ids = result.products.map((p) => p.id)
    expect(new Set(ids).size).toBe(2) // distinct ids — this is what the fix guarantees
    expect(result.products.every((p) => p.sku === 'DUP1')).toBe(true) // sku itself still shown, duplicated, on both
  })

  it('getProduct resolves EACH id to its own, correct, distinct product — never "not found", never crossed', async () => {
    const { db } = fakeDb({ scanRows: [rowA, rowB] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const productA = await provider.getProduct('DUP1')
    const productB = await provider.getProduct('row-1')
    expect(productA?.name).toBe('Producto Negro')
    expect(productB?.name).toBe('Producto Blanco')
    expect(productA?.id).not.toBe(productB?.id)
  })

  it('getAvailability resolves EACH id independently too', async () => {
    const { db } = fakeDb({
      scanRows: [
        { ...rowA, available: true, available_quantity: 3 },
        { ...rowB, available: false, available_quantity: 0 },
      ],
    })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const availA = await provider.getAvailability('DUP1')
    const availB = await provider.getAvailability('row-1')
    expect(availA?.available).toBe(true)
    expect(availA?.availableQuantity).toBe(3)
    expect(availB?.available).toBe(false)
    expect(availB?.availableQuantity).toBe(0)
  })
})

// ============================================================
// Broad-search reliability audit (Oct 2026) — real, demonstrated
// incident: against the live "Consultas KC" catalog (1,143 rows), a
// plain "televisor" query (0 hits at the DB/FTS tier, since no product
// name literally contains that word) fell to this fallback tier and
// could never find the one real KOOLHOME TV — confirmed directly: its
// row sits at `id`-ascending position 1054, past the OLD fixed
// `FALLBACK_SCAN_LIMIT=500` cutoff. Fixed by paginating through the
// WHOLE data source instead of one capped call. Fixture here is
// synthetic/deterministic (never real inventory, per this audit's own
// "no depender del inventario cambiante de producción" rule) but
// reproduces the exact mechanism: 1,200 rows (over both the old 500
// cutoff AND the 1,000-row PostgREST page size), with the one matching
// row placed at position 1054 — the real KOOLHOME row's own position.
// ============================================================
describe('DataSourceCatalogProvider — fallback tier scans the WHOLE data source, not just a fixed first slice', () => {
  it('finds a row placed at position 1054 of 1200 — past the OLD 500-row cutoff AND past one 1000-row page', async () => {
    const filler = Array.from({ length: 1200 }, (_, i) =>
      row({ id: `row-${String(i).padStart(4, '0')}`, source_product_id: `row-${i}`, name: `PRODUCTO DE RELLENO ${i}` }),
    )
    filler[1054] = row({ id: 'row-1054', source_product_id: 'row-1054', name: 'TV SMART TV KOOLHOME GOOGLE TV 32" FHD' })
    const { db } = fakeDb({ scanRows: filler })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

    const result = await provider.searchCatalog({ query: 'televisor', limit: 20 })
    const names = result.products.map((p) => p.name)
    expect(names.some((n) => n.includes('KOOLHOME'))).toBe(true)
  })

  it('still works correctly for a fixture that fits within a single 1000-row page (regression guard — the common case)', async () => {
    const { db } = fakeDb({ scanRows: [row({ name: 'TV TCL GOOGLE TV 50 4K' })] })
    const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')
    const result = await provider.searchCatalog({ query: 'televisor' })
    expect(result.products).toHaveLength(1)
  })
})

// ============================================================
// Broad-search reliability audit (Oct 2026), Phase 3.7 — paginating
// through the whole data source (above) trades the old fixed 500-row
// blind spot for unbounded latency if Supabase is slow/degraded across
// several pages. This proves the time-budget cutoff actually engages
// and reports the result as honestly partial, never as complete.
// ============================================================
describe('DataSourceCatalogProvider — fallback scan time budget: a slow multi-page scan is cut short honestly, never silently presented as complete', () => {
  it('stops paginating once the time budget is exceeded, and reports hasMore: true / total: null instead of a false "complete" result', async () => {
    vi.useFakeTimers()
    try {
      // Each simulated page "takes" 5s of wall-clock time — the second
      // page alone pushes elapsed time past the 8s budget, so a THIRD
      // page must never be fetched.
      let rangeCalls = 0
      const db = {
        // The DB/FTS tier is tried first — empty, non-error, so
        // searchCatalog falls through to fallbackSearch exactly as the
        // real "0 literal hits" case does.
        rpc: async () => ({ data: [], error: null }),
        from: (table: string) => {
          if (table !== 'ai_catalog_products') throw new Error(`unexpected table ${table}`)
          const api = {
            select: () => api,
            eq: () => api,
            order: () => api,
            range: async (from: number, to: number) => {
              rangeCalls++
              vi.advanceTimersByTime(5_000)
              // Always a FULL page (1000 rows) — an endlessly "more
              // data available" data source, so the loop would keep
              // going forever if the time budget didn't cut it off.
              const page = Array.from({ length: 1000 }, (_, i) =>
                row({ id: `row-${from + i}`, source_product_id: `row-${from + i}`, name: `PRODUCTO ${from + i}` }),
              )
              void to
              return { data: page, error: null }
            },
          }
          return api
        },
      } as unknown as SupabaseClient
      const provider = new DataSourceCatalogProvider(db, 'acct-1', 'ds-1', 'PRUEBA')

      const result = await provider.searchCatalog({ query: 'nonexistent-term-forces-fallback' })

      // Cut off after exactly 2 pages (0ms, then 5s, then the 3rd
      // iteration's pre-check sees 10s > 8s budget and stops BEFORE a
      // 3rd network call).
      expect(rangeCalls).toBe(2)
      expect(result.hasMore).toBe(true) // never silently "complete"
      expect(result.total).toBeNull() // honestly unknown, not a false count of only what was scanned
    } finally {
      vi.useRealTimers()
    }
  })
})

// ============================================================
// CatalogProvider backed by a structured Google Sheets / CSV data
// source (usage: catalog | both). Reads `ai_catalog_products`, the
// table `src/lib/ai/data-sources/service.ts` populates on refresh.
//
// This is the "GoogleSheetsCatalogProvider" from
// docs/integrations/ai-data-integration/01_MASTER_EXECUTION.md
// ("CATALOG PROVIDER") — named generically here because the same table
// backs any of the three source types (google_sheets/remote_csv/
// uploaded_csv), not just Sheets.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { encodeCatalogId } from '../id'
import { toCatalogProduct } from '../whitelist'
import {
  rankBySignificantTokens,
  rankBySignificantTokensMultiCategory,
  isBarePhoneCategoryQuery,
  splitCategorySegments,
  type ScoredMatch,
} from '../normalize'
import { classifyProductConfidence } from '../classify'
import type {
  CatalogAvailability,
  CatalogMedia,
  CatalogProduct,
  CatalogProvider,
  CatalogSearchArgs,
  CatalogSearchResult,
} from '../types'

/** Page size the in-memory fallback tier (normalize.ts) paginates
 *  through when the DB-side exact/FTS search finds nothing — see the
 *  module doc in normalize.ts for why this tier is TypeScript-side
 *  rather than SQL. 1000 matches PostgREST's own per-request row cap on
 *  this project, so a catalog at or under that size needs only one
 *  round trip.
 *
 *  Broad-search reliability audit (Oct 2026) — this tier used to be a
 *  SINGLE capped `.limit(FALLBACK_SCAN_LIMIT)` call (500), which made
 *  any row past that fixed cutoff structurally invisible to it,
 *  independent of how well it would have ranked. Confirmed directly
 *  against the real "Consultas KC" catalog (1,143 rows): the one
 *  KOOLHOME TV sits at `id`-ascending position 1054 — a plain
 *  "televisor" query (0 hits at the DB tier, since no product name
 *  literally contains that word) fell to this tier and could never
 *  find it, no matter the ranking, because the scan itself stopped at
 *  500. Now paginates through the WHOLE data source instead of one
 *  fixed-size page — see the loop in `fallbackSearch` below. */
const FALLBACK_SCAN_PAGE_SIZE = 1000
/** Hard ceiling on total rows scanned across every page, purely as a
 *  sanity backstop against a pathologically large data source — not a
 *  tuning knob for any catalog size seen in production so far (the
 *  real one is 1,143 rows; this is ~9x that). Should this ever start
 *  truncating a real account's catalog, that itself is the signal this
 *  tier needs a different design (e.g. a server-side trigram/fuzzy
 *  index), not a larger constant here. */
const FALLBACK_SCAN_MAX_ROWS = 10_000
/** Wall-clock budget for the WHOLE paginated scan, not any one page —
 *  broad-search reliability audit (Oct 2026), Phase 3.7: paginating
 *  through the whole data source (above) trades the old fixed 500-row
 *  blind spot for unbounded latency if Supabase itself is slow/
 *  degraded, since this tier can now issue several round trips instead
 *  of one. 8s leaves comfortable room under the provider call's own
 *  ~30s timeout (defaults.ts::aiRequestTimeoutMs) for the rest of that
 *  turn's work, while still covering a real multi-page scan (the real
 *  1,143-row catalog needs only 2 pages). Hitting this cuts the scan
 *  short HONESTLY — `hasMore` is forced `true` in that case (see
 *  `fallbackSearch` below), never silently presented as the complete
 *  catalog. */
const FALLBACK_SCAN_TIME_BUDGET_MS = 8_000

interface CatalogProductRow {
  id: string
  source_product_id: string
  sku: string | null
  name: string
  brand: string | null
  model: string | null
  description: string | null
  color: string | null
  variant_label: string | null
  capacity: string | null
  size: string | null
  price: number | string | null
  currency: string | null
  available: boolean
  available_quantity: number | null
  primary_image_url: string | null
  images: { url: string; alt?: string }[] | null
}

/** Only present on rows returned by the search_ai_catalog_products RPC
 *  (migration 047) — count(*) OVER() computed over the FULL filtered
 *  set before LIMIT/OFFSET, so every row in one response carries the
 *  same true total. Absent (undefined) on rows read via plain
 *  `.select('*')` (getProduct, the fallback-tier scan). */
interface CatalogProductRowWithTotal extends CatalogProductRow {
  total_count?: number | string
}

/** Provider key prefix for structured-data-source-backed providers. See
 *  catalog/id.ts — must never contain a colon. */
export function dataSourceProviderKey(dataSourceId: string): string {
  return `ds_${dataSourceId}`
}

/** A short letter-prefix + digit-suffix token ("a26", "a07", "s24") —
 *  the shape of a real model code. Audit (Oct 2026): confirmed directly
 *  against the real "Consultas KC" catalog that a bare query like "A26"
 *  returns, among real Samsung A26 rows, an UNRELATED iPad touch
 *  digitizer part whose name contains "A2603" — migration 047's
 *  `name ILIKE '%A26%'` is a plain substring match, so it can't tell a
 *  real model code from one that's merely a prefix of a longer,
 *  different code. Two different model codes must never be presented
 *  as the same product (the mandatory "A26, A36, A37, A56" test case). */
const MODEL_CODE_QUERY_PATTERN = /^[a-z]{1,3}\d{1,4}$/i

/** A short (<=3 letters), bare alphabetic query — "TV", "AC". Mission F
 *  audit (Oct 2026): confirmed directly against the real "Consultas
 *  KC" catalog that querying "TV" via migration 047's
 *  `name ILIKE '%TV%'` matches 41 rows, mostly unrelated accessories
 *  whose name merely CONTAINS "tv" embedded in a longer run (e.g.
 *  "...VGA2HDTV", "...EP-TVA8") — the exact same substring-embedding
 *  defect as the model-code case above, just without any digit.
 *  Longer words (brand names) are deliberately excluded: a longer
 *  token embedded inside an unrelated word is far less evidenced as a
 *  real problem, and the extra strictness isn't worth risking a
 *  genuine partial-name match. */
const SHORT_BARE_WORD_QUERY_PATTERN = /^[a-z]{1,3}$/i

/** True when `token` appears in `name` at a genuine word boundary —
 *  bounded by the string's edges or a non-alphanumeric character on
 *  each side — never merely as a substring of a longer alphanumeric
 *  run (so "a26" matches "SAMSUNG A26 5G" but not "iPad...A2603"). */
function hasWordBoundaryMatch(name: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(name)
}

function rowToProduct(row: CatalogProductRow, providerKey: string, label: string): CatalogProduct {
  return toCatalogProduct({
    id: encodeCatalogId(providerKey, row.source_product_id),
    name: row.name,
    brand: row.brand,
    model: row.model,
    sku: row.sku,
    description: row.description,
    variants: row.variant_label ? [row.variant_label] : [],
    colors: row.color ? [row.color] : [],
    capacity: row.capacity,
    size: row.size,
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    available: row.available,
    available_quantity: row.available_quantity,
    primary_image: row.primary_image_url ? { url: row.primary_image_url } : null,
    images: row.images ?? [],
    source: label,
  })
}

export class DataSourceCatalogProvider implements CatalogProvider {
  readonly key: string
  readonly label: string

  constructor(
    private readonly db: SupabaseClient,
    private readonly accountId: string,
    private readonly dataSourceId: string,
    displayName: string,
  ) {
    this.key = dataSourceProviderKey(dataSourceId)
    this.label = displayName
  }

  async searchCatalog(args: CatalogSearchArgs): Promise<CatalogSearchResult> {
    // Mission E/F audit (Oct 2026) — a bare phone-category query
    // ("celulares", "teléfonos", "smartphones") has no real anchor to
    // text-match: confirmed directly against the real "Consultas KC"
    // catalog that NO real phone name contains any of these words, and
    // that the one accidental hit that DOES exist ("TOUCH SAMSUNG
    // S6810 MUNDO MOVIL" — "MOVIL" there is a reseller-name fragment,
    // not a category word) gets wrongly presented as if it were the
    // only/representative phone in stock. Skip BOTH the SQL ILIKE/FTS
    // tier and the normal text-ranking fallback tier entirely for this
    // narrow, well-evidenced query shape, and go straight to a
    // STRUCTURAL selection instead (classify.ts's device-naming
    // heuristic / real brand+model fields) — see
    // searchByInferredDeviceCategory below.
    const bareQuery = (args.query ?? '').trim()
    if (isBarePhoneCategoryQuery(bareQuery)) {
      return this.searchByInferredDeviceCategory(args)
    }
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0
    const { data, error } = await this.db.rpc('search_ai_catalog_products', {
      p_account_id: this.accountId,
      p_data_source_ids: [this.dataSourceId],
      p_query: args.query ?? '',
      p_color: args.color ?? null,
      p_match_count: limit,
      p_offset: offset,
      p_available_only: args.availableOnly ?? false,
    })
    if (error) {
      console.error('[catalog] data-source search failed:', error.message)
      // hadError: true — this is a genuine query failure, never a
      // confirmed "nothing matches" (see CatalogSearchResult's doc).
      return { products: [], total: null, hasMore: false, hadError: true }
    }
    const rows = (data ?? []) as CatalogProductRowWithTotal[]
    const trimmedQuery = (args.query ?? '').trim()
    const needsWordBoundaryFilter =
      MODEL_CODE_QUERY_PATTERN.test(trimmedQuery) || SHORT_BARE_WORD_QUERY_PATTERN.test(trimmedQuery)
    if (rows.length > 0) {
      const total = Number(rows[0].total_count ?? rows.length)
      const hasMoreFromDb = offset + rows.length < total
      if (!needsWordBoundaryFilter) {
        return { products: rows.map((r) => rowToProduct(r, this.key, this.label)), total, hasMore: hasMoreFromDb }
      }
      // ILIKE's plain substring match let a short/model-code query
      // match a longer, unrelated word/code — drop rows that aren't a
      // genuine word-boundary hit before this ever reaches the model.
      const boundaryMatched = rows.filter((r) => hasWordBoundaryMatch(r.name, trimmedQuery))
      const removed = rows.length - boundaryMatched.length
      if (boundaryMatched.length > 0) {
        if (removed === 0) {
          return { products: boundaryMatched.map((r) => rowToProduct(r, this.key, this.label)), total, hasMore: hasMoreFromDb }
        }
        if (!hasMoreFromDb) {
          // Last/only page — the exact post-filter total is still knowable.
          return {
            products: boundaryMatched.map((r) => rowToProduct(r, this.key, this.label)),
            total: total - removed,
            hasMore: false,
          }
        }
        // More pages exist AND this page needed filtering — later pages
        // may hide the same false-positive shape, so the true total is
        // no longer reliably known. Honest "partial", never a wrong number.
        return { products: boundaryMatched.map((r) => rowToProduct(r, this.key, this.label)), total: null, hasMore: true }
      }
      // Every row on this page was a false positive — fall through to
      // the tolerant tier instead of reporting "nothing found" outright.
    }
    if (!args.query || !trimmedQuery) {
      return { products: [], total: 0, hasMore: false }
    }

    // Progressive fallback (AI_Catalog_Fix_Kit FASE 5): the DB-side
    // exact/FTS pass found nothing, e.g. `TCL de 50 pulgadas` against a
    // stored name of `TV TCL ... 50 ...` with no literal "pulgadas".
    // Scan this source's rows and rank by normalized/tolerant token
    // overlap instead of failing straight to "no encontrado".
    //
    // Falls through regardless of `offset`: the DB tier's WHERE clause
    // doesn't depend on offset for WHETHER anything matches, only which
    // slice is returned — so if it found zero rows at this query, it
    // would find zero at ANY offset too, and this is never reached in
    // practice with a non-zero offset anyway (the resolver, the only
    // real caller, always asks each provider for its own rows from 0 —
    // see catalog/resolver.ts's module doc). A direct caller that does
    // pass a non-zero offset here gets the tolerant tier's own
    // [offset, offset+limit) slice below, which is internally
    // consistent (same ranking every call for the same query).
    return this.fallbackSearch(args)
  }

  /**
   * Paginates through the WHOLE data source (bounded only by
   * FALLBACK_SCAN_MAX_ROWS as a sanity backstop, not by a fixed page
   * that silently hides everything past it) — see
   * FALLBACK_SCAN_PAGE_SIZE's doc for the real incident this fixes.
   * Deterministic base order (`id` ascending) preserved exactly as
   * before — without it Postgres doesn't guarantee the same row order
   * across separate calls, and since both rankBySignificantTokens' and
   * searchByInferredDeviceCategory's sorts are stable, a
   * nondeterministic scan would make pagination within either tier
   * flaky across separate calls.
   *
   * Shared by `fallbackSearch` (text-ranking tier) and
   * `searchByInferredDeviceCategory` (structural-selection tier) —
   * extracted so the two tiers can never silently diverge in how they
   * scan/paginate/time-bound the same underlying rows.
   */
  private async scanAllRows(): Promise<{ rows: CatalogProductRow[]; scanIncomplete: boolean; hadError: boolean }> {
    const allRows: CatalogProductRow[] = []
    const scanStartedAt = Date.now()
    // True only if the time budget cut the scan short WHILE more pages
    // likely remained — never set just because the loop finished
    // normally (page.length < FALLBACK_SCAN_PAGE_SIZE, or MAX_ROWS).
    let scanIncomplete = false
    for (let from = 0; from < FALLBACK_SCAN_MAX_ROWS; from += FALLBACK_SCAN_PAGE_SIZE) {
      if (Date.now() - scanStartedAt > FALLBACK_SCAN_TIME_BUDGET_MS) {
        console.warn(
          `[catalog] fallback scan time budget (${FALLBACK_SCAN_TIME_BUDGET_MS}ms) exceeded after ${allRows.length} rows — reporting as partial, never as complete`,
        )
        scanIncomplete = true
        break
      }
      const { data, error } = await this.db
        .from('ai_catalog_products')
        .select('*')
        .eq('account_id', this.accountId)
        .eq('data_source_id', this.dataSourceId)
        .order('id', { ascending: true })
        .range(from, from + FALLBACK_SCAN_PAGE_SIZE - 1)
      if (error) {
        console.error('[catalog] fallback scan failed:', error.message)
        return { rows: [], scanIncomplete: false, hadError: true }
      }
      const page = (data ?? []) as CatalogProductRow[]
      allRows.push(...page)
      if (page.length < FALLBACK_SCAN_PAGE_SIZE) break
    }
    return { rows: allRows, scanIncomplete, hadError: false }
  }

  /**
   * Real rows classified as `classifyProductConfidence() ===
   * 'likely_device'` (real brand/model fields, or the real
   * "<storage>GB + <RAM>GB" device-naming pattern), deterministically
   * sorted. Shared by `searchByInferredDeviceCategory` (the standalone
   * bare-category bypass) and `rankRowsForSegment` (one segment of a
   * comma-separated multi-category query, Mission F.2) so the two
   * never silently diverge in what counts as a real device.
   */
  private selectDeviceRows(rows: CatalogProductRow[]): CatalogProductRow[] {
    return rows.filter((r) => classifyProductConfidence(r) === 'likely_device').sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Structural fallback for a bare phone-category query (see
   * isBarePhoneCategoryQuery's doc) — selects rows by
   * classifyProductConfidence() === 'likely_device' instead of any
   * textual match against the query. Every returned product is a REAL
   * row with real price/stock — this only changes the SELECTION
   * criterion, never invents a product. Accessories, residential
   * phones, and anything merely "uncertain" are excluded by
   * construction (classifyProductConfidence's own priority order),
   * which is what keeps the real incident (a residential-phone-
   * adjacent accessory mislabeled as "the only celular") from
   * recurring here.
   */
  private async searchByInferredDeviceCategory(args: CatalogSearchArgs): Promise<CatalogSearchResult> {
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0
    const { rows: allRows, scanIncomplete, hadError } = await this.scanAllRows()
    if (hadError) return { products: [], total: null, hasMore: false, hadError: true }

    const rows = allRows.filter((r) => !args.availableOnly || r.available)
    const deviceRows = this.selectDeviceRows(rows)
    const colorFiltered = args.color
      ? deviceRows.filter((r) => !r.color || r.color.toLowerCase().includes(args.color!.toLowerCase()))
      : deviceRows
    const filtered = [...colorFiltered.filter((r) => r.available), ...colorFiltered.filter((r) => !r.available)]
    const page = filtered.slice(offset, offset + limit).map((r) => rowToProduct(r, this.key, this.label))
    return {
      products: page,
      total: scanIncomplete ? null : filtered.length,
      hasMore: scanIncomplete || offset + page.length < filtered.length,
      matchedByInferredCategory: true,
    }
  }

  /**
   * Ranks ONE segment of a (possibly comma-separated) query against
   * `rows` — the per-segment strategy `rankBySignificantTokensMultiCategory`
   * (normalize.ts) delegates to. Mission F.2 audit (Oct 2026): a
   * combined query like "celulares, neveras" must resolve EACH
   * category with its OWN correct strategy — the "celulares" segment
   * structurally (classify.ts, same as the standalone bypass; real
   * phone names never contain that word literally — see
   * isBarePhoneCategoryQuery's doc), the "neveras" segment textually
   * (real nevera names DO contain that word) — never forcing one
   * strategy on both. `isBarePhoneCategoryQuery` itself is NEVER
   * loosened: it still requires the SEGMENT to carry no other anchor,
   * so "celular samsung" (as its own segment) still resolves textually.
   */
  private rankRowsForSegment(segmentQuery: string, rows: CatalogProductRow[]): ScoredMatch<CatalogProductRow>[] {
    if (isBarePhoneCategoryQuery(segmentQuery)) {
      return this.selectDeviceRows(rows).map((item) => ({ item, score: 0, matchedTokens: 0 }))
    }
    return rankBySignificantTokens(
      segmentQuery,
      rows,
      (r) => [r.name, r.sku, r.brand, r.model, r.color, r.capacity, r.size].filter(Boolean).join(' '),
    )
  }

  private async fallbackSearch(args: CatalogSearchArgs): Promise<CatalogSearchResult> {
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0

    const { rows: allRows, scanIncomplete, hadError } = await this.scanAllRows()
    if (hadError) return { products: [], total: null, hasMore: false, hadError: true }

    const rows = allRows.filter((r) => !args.availableOnly || r.available)
    const ranked = rankBySignificantTokensMultiCategory(
      args.query,
      rows,
      (r) => [r.name, r.sku, r.brand, r.model, r.color, r.capacity, r.size].filter(Boolean).join(' '),
      (segmentQuery, items) => this.rankRowsForSegment(segmentQuery, items),
    )
    const colorFiltered = args.color
      ? ranked.filter((m) => !m.item.color || m.item.color.toLowerCase().includes(args.color!.toLowerCase()))
      : ranked
    // Stable partition: available matches first, agotados after —
    // relative ranking order preserved within each group. Mirrors the
    // DB tier's `ORDER BY available DESC, rank DESC` (migration 047)
    // so a customer browsing ("qué tienen") never sees an agotado item
    // pushed ahead of an available one just because this particular
    // query happened to miss the DB-side FTS pass and land here
    // instead (AI Sales Agent audit, Part 9).
    const filtered = [...colorFiltered.filter((m) => m.item.available), ...colorFiltered.filter((m) => !m.item.available)]
    const page = filtered.slice(offset, offset + limit).map((m) => rowToProduct(m.item, this.key, this.label))
    // `total` now reflects the WHOLE data source (paginated above), not
    // just a fixed first slice — honestly bounded only by
    // FALLBACK_SCAN_MAX_ROWS, a sanity backstop no real catalog has hit.
    // `scanIncomplete` (the time-budget cutoff) forces `hasMore: true`
    // regardless of the local count — `filtered`/`total` only reflect
    // what was actually scanned before the cutoff, so presenting them
    // as the complete catalog would be dishonest.
    //
    // Mission F.2 — honestly flagged when ANY segment of a combined
    // query ("celulares, neveras") was resolved structurally rather
    // than textually, same discipline as searchByInferredDeviceCategory
    // — never silently hidden just because other segments resolved
    // normally.
    const anySegmentIsBarePhoneCategory = splitCategorySegments(args.query).some((s) => isBarePhoneCategoryQuery(s))
    return {
      products: page,
      total: scanIncomplete ? null : filtered.length,
      hasMore: scanIncomplete || offset + page.length < filtered.length,
      ...(anySegmentIsBarePhoneCategory ? { matchedByInferredCategory: true } : {}),
    }
  }

  async getProduct(nativeId: string): Promise<CatalogProduct | null> {
    const { data, error } = await this.db
      .from('ai_catalog_products')
      .select('*')
      .eq('account_id', this.accountId)
      .eq('data_source_id', this.dataSourceId)
      .eq('source_product_id', nativeId)
      .maybeSingle()
    if (error || !data) return null
    return rowToProduct(data as CatalogProductRow, this.key, this.label)
  }

  async getAvailability(nativeId: string): Promise<CatalogAvailability | null> {
    const product = await this.getProduct(nativeId)
    if (!product) return null
    return {
      productId: product.id,
      available: product.available,
      availableQuantity: product.availableQuantity,
    }
  }

  async getMedia(nativeId: string): Promise<CatalogMedia | null> {
    const product = await this.getProduct(nativeId)
    if (!product) return null
    return { productId: product.id, primaryImage: product.primaryImage, images: product.images }
  }
}

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
import { rankBySignificantTokens } from '../normalize'
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
    if (rows.length > 0) {
      const total = Number(rows[0].total_count ?? rows.length)
      return {
        products: rows.map((r) => rowToProduct(r, this.key, this.label)),
        total,
        hasMore: offset + rows.length < total,
      }
    }
    if (!args.query || !args.query.trim()) {
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

  private async fallbackSearch(args: CatalogSearchArgs): Promise<CatalogSearchResult> {
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0

    // Broad-search reliability audit (Oct 2026) — paginates through the
    // WHOLE data source (bounded only by FALLBACK_SCAN_MAX_ROWS as a
    // sanity backstop, not by a fixed page that silently hid everything
    // past it) rather than one capped `.limit()` call — see
    // FALLBACK_SCAN_PAGE_SIZE's doc for the real incident this fixes.
    // Deterministic base order (`id` ascending) preserved exactly as
    // before — without it Postgres doesn't guarantee the same row order
    // across separate calls, and since rankBySignificantTokens' sort is
    // stable (ties keep INPUT order), an undeterministic scan would
    // make pagination within this tier flaky across separate calls.
    const allRows: CatalogProductRow[] = []
    for (let from = 0; from < FALLBACK_SCAN_MAX_ROWS; from += FALLBACK_SCAN_PAGE_SIZE) {
      const { data, error } = await this.db
        .from('ai_catalog_products')
        .select('*')
        .eq('account_id', this.accountId)
        .eq('data_source_id', this.dataSourceId)
        .order('id', { ascending: true })
        .range(from, from + FALLBACK_SCAN_PAGE_SIZE - 1)
      if (error) {
        console.error('[catalog] fallback scan failed:', error.message)
        return { products: [], total: null, hasMore: false, hadError: true }
      }
      const page = (data ?? []) as CatalogProductRow[]
      allRows.push(...page)
      if (page.length < FALLBACK_SCAN_PAGE_SIZE) break
    }

    const rows = allRows.filter((r) => !args.availableOnly || r.available)
    const ranked = rankBySignificantTokens(
      args.query,
      rows,
      (r) => [r.name, r.sku, r.brand, r.model, r.color, r.capacity, r.size].filter(Boolean).join(' '),
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
    return { products: page, total: filtered.length, hasMore: offset + page.length < filtered.length }
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

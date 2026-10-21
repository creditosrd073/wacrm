// ============================================================
// Catalog facets — AI optimization project, FASE 11.
//
// Computed EXCLUSIVELY from `CatalogProduct[]` rows a search already
// fetched — never a second query, never a second HTTP call to Budun,
// never a new RPC. This is a deliberate design choice (not a shortcut):
// docs/integrations/ai-data-integration audits and this phase's own
// authorization both prioritize "reuse what was already obtained" over
// a technically-more-complete-but-costlier full-catalog aggregation.
// Every value here is read straight off the whitelisted CatalogProduct
// shape (catalog/whitelist.ts already stripped everything not on that
// allow-list) — a facet can therefore never surface a field the
// whitelist wouldn't already allow onto a product.
//
// HONESTY: facets reflect only the products THIS search call actually
// examined (catalog/resolver.ts passes it the same `collected` array
// used to build the page/total/has_more result) — exactly the same
// "partial view, not the whole catalog" caveat `has_more` already
// carries for `products` itself. Never treat facets as an exhaustive
// list of every value that could ever exist in the catalog.
// ============================================================

import { guessBrandFromName, isLikelyAccessoryOrPart } from './classify'
import type { CatalogProduct } from './types'

/** Cap on how many distinct values one facet reports — keeps the tool
 *  result small/stable even for a data source with an unusually wide
 *  spread of brands/colors (analogous in spirit to MAX_SEARCH_LIMIT,
 *  but deliberately a SEPARATE constant: this bounds a facet array's
 *  size, not a page of products, and the two must never be conflated
 *  or accidentally share a knob). */
const MAX_FACET_VALUES = 50

export interface CatalogPriceRange {
  min: number
  max: number
}

export interface CatalogStockSummary {
  inStock: number
  outOfStock: number
}

/**
 * Real, distinct aggregations over one search's matching products.
 * Every field is OPTIONAL and omitted (never an empty array/zero-ed
 * object) when there is nothing real to report — e.g. no product in
 * this result had a brand, or none had a price — so the agent can tell
 * "not asked for" apart from "confirmed absent" apart from "no data".
 * There is deliberately NO `categories` field: `CatalogProduct` has no
 * category column anywhere in the provider contract (see catalog/
 * types.ts) — inventing one here would violate the "no fabricar datos"
 * rule this phase was explicitly built to protect. `brandGuesses` and
 * `productKindSplit` below (broad-search reliability audit, Oct 2026)
 * do NOT violate that rule the same way `categories` would have:
 * neither invents a structured field that doesn't exist — both are
 * computed from the real `name` text already on the product, clearly
 * labeled as a guess/heuristic (never merged into a "confirmed data"
 * field like `brands`), for the specific, demonstrated case of a real
 * data source where `brand` is null on every row and roughly half the
 * catalog is repair parts with nothing else distinguishing them.
 */
export interface CatalogFacets {
  brands?: string[]
  /** Broad-search reliability audit (Oct 2026) — a HEURISTIC fallback,
   *  computed from each product's real `name` text (catalog/classify.ts),
   *  used ONLY when `brands` above is absent because every product in
   *  this result has a null `brand` column — confirmed the real state
   *  of the live "Consultas KC" data source, which has no brand data at
   *  all. Never merged into `brands` itself and never present alongside
   *  it, so a reader can never mistake a guess for confirmed data. */
  brandGuesses?: string[]
  colors?: string[]
  capacities?: string[]
  sizes?: string[]
  priceRange?: CatalogPriceRange
  stock?: CatalogStockSummary
  /** Broad-search reliability audit (Oct 2026) — how many of THESE
   *  results look like repair parts/accessories vs. not, by the same
   *  heuristic as `is_likely_accessory_or_part` on each product
   *  (catalog/classify.ts). Lets the agent tell the customer honestly
   *  that e.g. "most of what matched looks like repair parts, not
   *  phones" instead of presenting a parts-polluted list as a clean
   *  device listing. `likelyDevice` is a NEGATIVE-signal count (did
   *  NOT match a known part/accessory keyword) — never a positive
   *  confirmation every one of those is actually a phone. */
  productKindSplit?: { likelyAccessoryOrPart: number; likelyDevice: number }
}

function distinctSorted(values: (string | null | undefined)[]): string[] | undefined {
  const set = new Set<string>()
  for (const raw of values) {
    const v = raw?.trim()
    if (v) set.add(v)
  }
  if (set.size === 0) return undefined
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, MAX_FACET_VALUES)
}

/**
 * Aggregate real facets from a set of already-fetched products. Returns
 * `undefined` (never an empty `{}`) when there's nothing to report —
 * callers should omit the `facets` field entirely in that case, the
 * same discipline already used for `externalLimitReached`.
 */
export function computeFacets(products: CatalogProduct[]): CatalogFacets | undefined {
  if (products.length === 0) return undefined

  const facets: CatalogFacets = {}

  const brands = distinctSorted(products.map((p) => p.brand))
  if (brands) {
    facets.brands = brands
  } else {
    // Real `brand` data is absent across this whole result — fall back
    // to a clearly-labeled guess from the real name text, rather than
    // leaving the agent with zero brand signal at all (see this file's
    // `brandGuesses` doc for why this never coexists with `brands`).
    const brandGuesses = distinctSorted(products.map((p) => guessBrandFromName(p.name)))
    if (brandGuesses) facets.brandGuesses = brandGuesses
  }

  const colors = distinctSorted(products.flatMap((p) => p.colors))
  if (colors) facets.colors = colors

  const capacities = distinctSorted(products.map((p) => p.capacity))
  if (capacities) facets.capacities = capacities

  const sizes = distinctSorted(products.map((p) => p.size))
  if (sizes) facets.sizes = sizes

  const prices = products
    .map((p) => p.price)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  if (prices.length > 0) {
    facets.priceRange = { min: Math.min(...prices), max: Math.max(...prices) }
  }

  // Stock is a plain count, not a "distinct values" facet — always
  // computable (every product has a real boolean `available`), so
  // unlike the string facets above it's included whenever there's at
  // least one product, even if every one of them is in (or out of)
  // stock.
  const inStock = products.filter((p) => p.available).length
  facets.stock = { inStock, outOfStock: products.length - inStock }

  const likelyAccessoryOrPart = products.filter((p) => isLikelyAccessoryOrPart(p.name)).length
  facets.productKindSplit = { likelyAccessoryOrPart, likelyDevice: products.length - likelyAccessoryOrPart }

  return facets
}

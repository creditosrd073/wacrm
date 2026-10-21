// ============================================================
// Commercial-claims verification — real incident (Oct 2026): in one
// conversation, the agent first said no Samsung phones were available,
// then later stated the Samsung A16 was available "in 3 colors, 24
// units, DOP 10,000" with no real tool result backing those specific
// numbers. adversarial-scenarios.test.ts already proved there was no
// second layer validating a fabricated price against the real tool
// result — this module is that layer.
//
// Scope, deliberately narrow: this does NOT parse arbitrary commercial
// prose. It extracts two specific, reliably-anchored claim shapes the
// agent is ALREADY instructed (defaults.ts) to phrase consistently —
// a currency-prefixed price, and the exact "N unidad(es) disponible(s)"
// quantity phrase — and cross-checks each extracted number against the
// REAL prices/quantities this turn's tool calls (plus, for price only,
// the carried-over catalog context — see below for why) actually
// produced. A price/quantity number that matches NOTHING real is
// reported as unverified; the caller (auto-reply.ts/playground route)
// decides what to do with that — this module never rewrites text or
// decides to hand off, it only reports facts.
// ============================================================

import { parseLocaleNumber } from '../inventory-parser'
import type { ToolCallLogEntry } from '../types'
import type { CatalogTurnContext } from './context'

export interface ClaimVerificationResult {
  /** False only when at least one extracted price/quantity claim
   *  matched nothing real this turn (plus context, for price). True
   *  whenever there was nothing to check (no currency/quantity phrases
   *  found) — this is NOT the same as "every claim confirmed", see
   *  `issues`. */
  verified: boolean
  /** Human-readable description of each unverified claim found, empty
   *  when `verified` is true. Never includes secrets — only numbers
   *  already present in the model's own (customer-facing) text. */
  issues: string[]
}

/** Pulls every real, numeric price/quantity this turn's tool results
 *  actually returned — search_catalog's `products[]`, get_product's
 *  `product`, get_availability's own result shape. Never reads
 *  anything from outside these structured results. Prices are kept at
 *  full precision (never rounded) — a real catalog CAN have genuine
 *  cents (confirmed by a real pre-existing test fixture, $19.99), so
 *  rounding here would itself create a false mismatch. */
function collectRealValuesFromToolCalls(toolCalls: ToolCallLogEntry[]): { prices: Set<number>; quantities: Set<number> } {
  const prices = new Set<number>()
  const quantities = new Set<number>()

  const addProduct = (p: unknown) => {
    if (!p || typeof p !== 'object') return
    const rec = p as Record<string, unknown>
    if (typeof rec.price === 'number' && Number.isFinite(rec.price) && rec.price_confirmed !== false) {
      prices.add(rec.price)
    }
    const qty = rec.available_quantity ?? rec.availableQuantity
    if (typeof qty === 'number' && Number.isFinite(qty)) quantities.add(qty)
  }

  for (const call of toolCalls) {
    const result = call.result as Record<string, unknown> | null
    if (!result) continue
    if (Array.isArray(result.products)) {
      for (const p of result.products) addProduct(p)
    }
    if (result.product) addProduct(result.product)
    // get_availability's own top-level shape (CatalogAvailability) —
    // not wrapped in a `product` key.
    addProduct(result)
    if (Array.isArray(result.byVariant)) {
      for (const v of result.byVariant as Record<string, unknown>[]) {
        const q = v.availableQuantity
        if (typeof q === 'number' && Number.isFinite(q)) quantities.add(q)
      }
    }
  }
  return { prices, quantities }
}

/** Prices only (context never carries quantity/stock — see context.ts's
 *  own doc on why: it's explicitly disambiguation-only, "last seen",
 *  and the model is told to re-verify before confirming price/stock).
 *  Included here, for price only, so a model correctly reusing a
 *  remembered price per the system's own design isn't flagged as
 *  unverified — this module targets outright fabrication (a number
 *  that matches NOTHING, ever), not legitimate context reuse. */
function collectRealPricesFromContext(context: CatalogTurnContext | null | undefined): Set<number> {
  const prices = new Set<number>()
  if (!context) return prices
  for (const p of context.products) {
    if (typeof p.price === 'number' && Number.isFinite(p.price)) prices.add(p.price)
  }
  return prices
}

// Currency-prefixed number — RD$10,000 / DOP 10.000 / $10,000.00 /
// 10,000 DOP / 10.000 pesos / $19.99.
const PRICE_PATTERN = /(?:RD\$|DOP|US\$|\$)\s*([\d.,]{2,})|([\d.,]{2,})\s*(?:DOP|RD\$|pesos|dólares)/gi
const QUANTITY_PATTERN = /(\d+)\s+unidad(?:es)?\s+disponible/gi

/** Every plausible numeric reading of a matched price string — never
 *  commits to exactly one interpretation of an ambiguous separator.
 *  `parseLocaleNumber` (inventory-parser.ts, already proven against
 *  real Spanish/English-locale catalog data in this project) gives the
 *  disambiguated reading; the "every separator is a thousands grouping,
 *  no decimal at all" reading is added alongside it so a real whole-
 *  number price ($10,000 vs. a stray $10.000 typo-style input) is never
 *  missed just because the two conventions disagree on one string. */
function priceCandidates(raw: string): number[] {
  // The capture group is greedy over [\d.,] so it can swallow a
  // sentence-ending period right after the number ("...DOP 38,500.") —
  // strip any trailing separator(s) with nothing after them first, or
  // that stray punctuation gets misread as a decimal point below.
  const trimmed = raw.replace(/[.,]+$/, '')
  const candidates = new Set<number>()
  const disambiguated = parseLocaleNumber(trimmed)
  if (disambiguated !== null) candidates.add(disambiguated)
  const allThousands = Number(trimmed.replace(/\D/g, ''))
  if (Number.isFinite(allThousands)) candidates.add(allThousands)
  return [...candidates]
}

function quantityCandidate(raw: string): number | null {
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Real catalog prices are never literally fractional-cent-exact to
 *  floating point by accident, but comparing floats for equality is
 *  still unsafe in general — a small epsilon absorbs that without
 *  risking a false match between two genuinely different prices (the
 *  real catalog's amounts are always >= 1 unit apart). */
const PRICE_EPSILON = 0.005

function matchesAny(claimedCandidates: number[], real: Set<number>): boolean {
  return claimedCandidates.some((claimed) => [...real].some((r) => Math.abs(r - claimed) < PRICE_EPSILON))
}

/**
 * Cross-checks every price/quantity claim found in `text` against the
 * real data this turn gathered. Pure, synchronous, no I/O — called
 * once per turn, right after `generateReply()` returns, before the
 * reply is ever sent to a real customer.
 */
export function verifyCommercialClaims(
  text: string,
  toolCalls: ToolCallLogEntry[],
  previousCatalogContext?: CatalogTurnContext | null,
): ClaimVerificationResult {
  const { prices: realPrices, quantities: realQuantities } = collectRealValuesFromToolCalls(toolCalls)
  for (const p of collectRealPricesFromContext(previousCatalogContext)) realPrices.add(p)

  const issues: string[] = []

  for (const match of text.matchAll(PRICE_PATTERN)) {
    const raw = match[1] ?? match[2]
    if (!raw) continue
    const candidates = priceCandidates(raw)
    if (candidates.length === 0) continue
    if (!matchesAny(candidates, realPrices)) {
      issues.push(`precio no respaldado: "${match[0].trim()}" no coincide con ningún precio real de esta conversación`)
    }
  }

  for (const match of text.matchAll(QUANTITY_PATTERN)) {
    const claimed = quantityCandidate(match[1])
    if (claimed === null) continue
    if (!matchesAny([claimed], realQuantities)) {
      issues.push(`cantidad no respaldada: "${match[0].trim()}" no coincide con ninguna existencia real confirmada esta conversación`)
    }
  }

  return { verified: issues.length === 0, issues }
}

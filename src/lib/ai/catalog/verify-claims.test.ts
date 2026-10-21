import { describe, it, expect } from 'vitest'
import { verifyCommercialClaims } from './verify-claims'
import type { ToolCallLogEntry } from '../types'
import type { CatalogTurnContext } from './context'

// ============================================================
// Real incident (Oct 2026): the agent said "no Samsung phones" then
// later claimed the A16 was available "en 3 colores, 24 unidades,
// DOP 10,000" with nothing real backing those specific numbers —
// adversarial-scenarios.test.ts already proved this exact gap exists
// (a fabricated price passes through unchanged). These are the
// regression tests for the fix.
// ============================================================

function searchCall(products: Record<string, unknown>[]): ToolCallLogEntry {
  return { name: 'search_catalog', input: { query: 'samsung a16' }, result: { products, returned: products.length, total: products.length, has_more: false } }
}
function availabilityCall(availableQuantity: number): ToolCallLogEntry {
  return { name: 'get_availability', input: { id: 'x' }, result: { productId: 'x', available: availableQuantity > 0, availableQuantity } }
}

describe('verifyCommercialClaims — the real incident: an invented price/quantity is caught', () => {
  it('flags a price that matches NOTHING real this turn — the exact reported case (A16, DOP 10,000)', () => {
    const toolCalls = [searchCall([{ id: 'a16', name: 'Samsung A16', price: 9500, price_confirmed: true, available_quantity: 7 }])]
    const result = verifyCommercialClaims(
      'El Samsung A16 está disponible en 3 colores, con 24 unidades disponibles, a DOP 10,000.',
      toolCalls,
    )
    expect(result.verified).toBe(false)
    expect(result.issues.some((i) => i.includes('precio no respaldado'))).toBe(true)
    expect(result.issues.some((i) => i.includes('cantidad no respaldada'))).toBe(true)
  })

  it('does NOT flag a price/quantity that DOES match a real tool result this turn', () => {
    const toolCalls = [searchCall([{ id: 'a16', name: 'Samsung A16', price: 10000, price_confirmed: true, available_quantity: 24 }])]
    const result = verifyCommercialClaims('El Samsung A16 cuesta DOP 10,000 y tiene 24 unidades disponibles.', toolCalls)
    expect(result.verified).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('verified: true (nothing to check) when the text makes no price/quantity claim at all', () => {
    const result = verifyCommercialClaims('¿En qué más puedo ayudarte?', [])
    expect(result.verified).toBe(true)
  })

  it('a price_confirmed: false product never counts as a real, verifiable price', () => {
    const toolCalls = [searchCall([{ id: 'a16', name: 'Samsung A16', price: 10000, price_confirmed: false, available_quantity: 5 }])]
    const result = verifyCommercialClaims('El Samsung A16 cuesta DOP 10,000.', toolCalls)
    expect(result.verified).toBe(false)
  })

  it('a quantity claim is verified against get_availability\'s own result shape, not just search_catalog', () => {
    const toolCalls = [availabilityCall(12)]
    const result = verifyCommercialClaims('Quedan 12 unidades disponibles.', toolCalls)
    expect(result.verified).toBe(true)
  })

  it('a quantity claim NOT backed by get_availability\'s real number is flagged', () => {
    const toolCalls = [availabilityCall(3)]
    const result = verifyCommercialClaims('Quedan 50 unidades disponibles.', toolCalls)
    expect(result.verified).toBe(false)
  })

  it('a price legitimately carried over from the previous-turn catalog context is NOT flagged (reuse, not fabrication)', () => {
    const context: CatalogTurnContext = {
      lastQuery: 'a16',
      products: [{ id: 'a16', name: 'Samsung A16', brand: 'Samsung', model: 'A16', color: null, capacity: null, size: null, price: 10000, currency: 'DOP', fromQuery: 'a16' }],
      updatedAt: new Date().toISOString(),
    }
    const result = verifyCommercialClaims('El Samsung A16 cuesta DOP 10,000.', [], context)
    expect(result.verified).toBe(true)
  })

  it('a price matching NEITHER this turn\'s tools NOR the carried context is still flagged', () => {
    const context: CatalogTurnContext = {
      lastQuery: 'a16',
      products: [{ id: 'a16', name: 'Samsung A16', brand: 'Samsung', model: 'A16', color: null, capacity: null, size: null, price: 9500, currency: 'DOP', fromQuery: 'a16' }],
      updatedAt: new Date().toISOString(),
    }
    const result = verifyCommercialClaims('El Samsung A16 cuesta DOP 10,000.', [], context)
    expect(result.verified).toBe(false)
  })

  it('tolerates both locale number formats (comma and dot thousands separators) for the SAME real price', () => {
    const toolCalls = [searchCall([{ id: 'a16', name: 'Samsung A16', price: 38500, price_confirmed: true }])]
    for (const phrasing of ['DOP 38,500', 'DOP 38.500', '$38500', 'RD$38,500.00']) {
      const result = verifyCommercialClaims(`El precio es ${phrasing}.`, toolCalls)
      expect(result.verified).toBe(true)
    }
  })

  it('a genuinely fractional real price ($19.99) is matched correctly — regression guard: an earlier version of this module misread cents as thousands and broke a real pre-existing test', () => {
    const toolCalls = [searchCall([{ id: 'p', name: 'Producto', price: 19.99, price_confirmed: true }])]
    const result = verifyCommercialClaims('El producto cuesta $19.99.', toolCalls)
    expect(result.verified).toBe(true)
  })

  it('a fractional-looking claim that does NOT match the real (also fractional) price is still flagged', () => {
    const toolCalls = [searchCall([{ id: 'p', name: 'Producto', price: 19.99, price_confirmed: true }])]
    const result = verifyCommercialClaims('El producto cuesta $29.99.', toolCalls)
    expect(result.verified).toBe(false)
  })

  it('multiple real products this turn: a claim matching ANY one of them is verified, not just the first', () => {
    const toolCalls = [searchCall([
      { id: 'a', name: 'Samsung A16 Negro', price: 10000, price_confirmed: true },
      { id: 'b', name: 'Samsung A16 Azul', price: 10500, price_confirmed: true },
    ])]
    const result = verifyCommercialClaims('El azul cuesta DOP 10,500.', toolCalls)
    expect(result.verified).toBe(true)
  })
})

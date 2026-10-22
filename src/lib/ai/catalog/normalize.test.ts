import { describe, it, expect } from 'vitest'
import {
  levenshtein,
  normalizeText,
  rankBySignificantTokens,
  rankBySignificantTokensMultiCategory,
  significantTokens,
  isBarePhoneCategoryQuery,
  splitCategorySegments,
} from './normalize'

describe('normalizeText', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalizeText('Cámara Réflex')).toBe('camara reflex')
  })

  it('collapses hyphens/underscores/slashes to spaces', () => {
    expect(normalizeText('Samsung-A07')).toBe('samsung a07')
    expect(normalizeText('A_07')).toBe('a 07')
  })

  it('reduces every inch expression to a bare number, matching a source with NO unit at all', () => {
    // This is the exact AI_Catalog_Fix_Kit FASE 8 scenario: the real
    // product name never says "pulgadas" — it must still be reachable.
    for (const q of ['50"', '50in', '50 in', '50 inch', '50 inches', '50 pulgadas', '50 pulgada']) {
      expect(normalizeText(q)).toContain('50')
      expect(normalizeText(q)).not.toMatch(/pulgada|inch|"/)
    }
  })

  it('glues storage/RAM units (they already appear glued in real catalog names)', () => {
    expect(normalizeText('64 GB')).toBe('64gb')
    expect(normalizeText('64GB')).toBe('64gb')
    expect(normalizeText('4 GB RAM')).toBe('4gb ram')
  })

  it('does NOT alter the numeric value itself (no "50 → 500" style corruption)', () => {
    expect(normalizeText('50 pulgadas')).not.toContain('500')
    expect(normalizeText('64GB')).not.toContain('128')
  })

  it('treats the spelled-out "gigas"/"giga" colloquialism the same as "GB" (Part 10)', () => {
    expect(normalizeText('64 gigas')).toBe('64gb')
    expect(normalizeText('64 giga')).toBe('64gb')
    expect(normalizeText('64GB')).toBe(normalizeText('64 gigas'))
  })
})

describe('significantTokens — model code recovery', () => {
  it('produces the glued form for a spaced/hyphenated model code, without dropping the split form', () => {
    for (const raw of ['Samsung A07', 'Samsung-A07', 'A 07', 'A-07', 'A07']) {
      const tokens = significantTokens(normalizeText(raw))
      expect(tokens).toContain('a07')
    }
  })

  it('drops filler stopwords but keeps meaningful short tokens like a bare size number', () => {
    const tokens = significantTokens(normalizeText('la tcl de 50 pulgadas'))
    expect(tokens).toContain('tcl')
    expect(tokens).toContain('50')
    expect(tokens).not.toContain('la')
    expect(tokens).not.toContain('de')
  })

  it('applies the controlled tv synonym group', () => {
    expect(significantTokens(normalizeText('televisor'))).toContain('tv')
    expect(significantTokens(normalizeText('smart tv'))).toContain('tv')
    expect(significantTokens(normalizeText('tele'))).toContain('tv') // Part 9's example list
  })

  // Part 10 — generic synonym groups (not product/brand-specific; must
  // work for any future product line that uses these same category
  // words). Each group's members all normalize to the group's first
  // entry, so two customers using different words for the same thing
  // become the same searchable token.
  it('applies the aire/acondicionador/ac group', () => {
    const canonical = 'aire'
    for (const word of ['aire', 'acondicionador', 'ac']) {
      expect(significantTokens(normalizeText(word))).toContain(canonical)
    }
  })

  it('applies the nevera/refrigerador group (incl. the Dominican colloquialism "frigider")', () => {
    const canonical = 'nevera'
    for (const word of ['nevera', 'refrigerador', 'refrigeradora', 'frigider']) {
      expect(significantTokens(normalizeText(word))).toContain(canonical)
    }
  })

  it('applies the abanico/ventilador group', () => {
    const canonical = 'abanico'
    for (const word of ['abanico', 'ventilador']) {
      expect(significantTokens(normalizeText(word))).toContain(canonical)
    }
  })

  it('applies the celular/telefono/smartphone group, including the "cel" abbreviation', () => {
    const canonical = 'celular'
    for (const word of ['celular', 'telefono', 'movil', 'smartphone', 'cel']) {
      expect(significantTokens(normalizeText(word))).toContain(canonical)
    }
  })
})

describe('levenshtein', () => {
  it('is 0 for identical strings and correct for simple edits', () => {
    expect(levenshtein('disponible', 'disponible')).toBe(0)
    expect(levenshtein('dispnible', 'disponible')).toBe(1) // one dropped letter
  })
})

describe('rankBySignificantTokens — the reported real-world scenarios', () => {
  const CATALOG = [
    { name: 'TV TCL GOOGLE TV SMART 50 4K ULTRA HD RESOLUTION' },
    { name: 'TV TCL GOOGLE TV SMART 65 4K ULTRA HD RESOLUTION' },
    { name: 'SAMSUNG A07 128GB + 4GB NEGRO' },
    { name: 'SAMSUNG A07 128GB + 4GB MORADO' },
    { name: 'SAMSUNG A07 64GB + 4GB NEGRO' },
    { name: 'SAMSUNG A05 128GB + 4GB NEGRO' }, // decoy — must NOT rank for "A07" queries
    { name: 'AIRE ACONDICIONADO DLC INVERTER 12000 BTU' },
  ]
  const text = (p: { name: string }) => p.name

  it('"la tcl de 50 pulgadas" finds the 50" TCL even though the name never says "pulgadas"', () => {
    const ranked = rankBySignificantTokens('la tcl de 50 pulgadas', CATALOG, text)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].item.name).toContain('TV TCL')
    expect(ranked[0].item.name).toContain('50')
    // The 65" TCL must not outrank (or worse, silently replace) the 50" one.
    expect(ranked[0].item.name).not.toContain('65')
  })

  it('"TCL 50\\"" and "smart tv tcl" and the exact name all resolve to the same product', () => {
    for (const q of ['TCL 50"', 'tcl de 50 pulgadas', 'smart tv tcl 50', 'TV TCL GOOGLE TV SMART 50 4K ULTRA HD RESOLUTION']) {
      const ranked = rankBySignificantTokens(q, CATALOG, text)
      expect(ranked[0]?.item.name).toBe('TV TCL GOOGLE TV SMART 50 4K ULTRA HD RESOLUTION')
    }
  })

  it('"a 07" and "a-07" resolve to Samsung A07 rows, never to the A05 decoy', () => {
    for (const q of ['a 07', 'a-07', 'A07', 'samsung a 07']) {
      const ranked = rankBySignificantTokens(q, CATALOG, text)
      const names = ranked.map((r) => r.item.name)
      expect(names.some((n) => n.includes('A07'))).toBe(true)
      expect(names).not.toContain('SAMSUNG A05 128GB + 4GB NEGRO')
    }
  })

  it('tolerates a minor typo ("A07" vs a hypothetical "A0O7" style slip) without matching an unrelated model', () => {
    const ranked = rankBySignificantTokens('samsng a07', CATALOG, text) // "samsng" missing a letter
    expect(ranked[0]?.item.name).toContain('A07')
  })

  it('returns nothing for a query with no real overlap — never a false positive', () => {
    const ranked = rankBySignificantTokens('bicicleta electrica', CATALOG, text)
    expect(ranked).toEqual([])
  })

  it('never lets "50" match "500" or "5" — numeric values are not fuzzy', () => {
    const withDecoys = [...CATALOG, { name: 'REFRIGERADOR 500 LITROS' }, { name: 'CABLE HDMI 5 METROS' }]
    const ranked = rankBySignificantTokens('tcl 50 pulgadas', withDecoys, text)
    const names = ranked.map((r) => r.item.name)
    expect(names).not.toContain('REFRIGERADOR 500 LITROS')
    expect(names).not.toContain('CABLE HDMI 5 METROS')
  })
})

// ============================================================
// AI Sales Agent audit (re-pass) — Part 10's "una laptop barata"
// example: a subjective qualifier that never appears in a real
// product name must not silently zero out an otherwise-good query.
// Guarded closely against reopening the A07≠A05 regression above —
// a token WITH a digit (a model code, a size) must never be relaxed
// away just because that exact model/size happens to be absent.
// ============================================================
describe('rankBySignificantTokens — subjective qualifiers do not veto real matches (Part 10)', () => {
  const LAPTOPS = [
    { name: 'LAPTOP HP 15 CORE I5 8GB 256GB SSD' },
    { name: 'LAPTOP LENOVO IDEAPAD 14 CORE I3 8GB 256GB' },
    { name: 'NEVERA WHIRLPOOL 15 PIES' }, // not a laptop
  ]
  const text = (p: { name: string }) => p.name

  it('"una laptop barata" still finds real laptops even though no name literally says "barata"', () => {
    const ranked = rankBySignificantTokens('una laptop barata', LAPTOPS, text)
    expect(ranked.length).toBe(2)
    expect(ranked.map((r) => r.item.name)).not.toContain('NEVERA WHIRLPOOL 15 PIES')
  })

  it('same relaxation for "quiero algo bueno y economico" style qualifiers, still scoped to the right category', () => {
    const ranked = rankBySignificantTokens('laptop buena y economica', LAPTOPS, text)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked.every((r) => r.item.name.includes('LAPTOP'))).toBe(true)
  })

  it('a genuinely irrelevant query (nothing matches at all) still correctly returns nothing — relaxation cannot invent a match', () => {
    const ranked = rankBySignificantTokens('bicicleta barata', LAPTOPS, text)
    expect(ranked).toEqual([])
  })

  it('CRITICAL: a missing MODEL NUMBER is never relaxed away — "Samsung A07" must not match "Samsung A05" even when A07 does not exist anywhere in this catalog', () => {
    // Deliberately a catalog with ONLY the A05 decoy — no real A07 row
    // at all, unlike the CATALOG above. If "a07" (a digit-bearing
    // token) were relaxed away just because it matches nothing here,
    // "samsung" alone would incorrectly qualify the A05.
    const onlyA05 = [{ name: 'SAMSUNG A05 128GB + 4GB NEGRO' }, { name: 'SAMSUNG A05 64GB + 4GB NEGRO' }]
    for (const q of ['samsung a07', 'a 07', 'a-07']) {
      expect(rankBySignificantTokens(q, onlyA05, text)).toEqual([])
    }
  })

  it('a missing SIZE is never relaxed away either — "TCL de 55" must not match a TCL 50 just because 55 does not exist', () => {
    const onlySize50 = [{ name: 'TV TCL GOOGLE TV SMART 50 4K' }]
    expect(rankBySignificantTokens('tcl de 55 pulgadas', onlySize50, text)).toEqual([])
  })

  it('a missing BRAND (no digit) IS relaxed away — a store without Asus can still surface real laptops as alternatives', () => {
    // "asus" matches nothing anywhere in this catalog, but "laptop"
    // (literally present in both real product names) is the real
    // signal — surfacing the HP/Lenovo laptops as alternatives is
    // desired retail behavior (Part 7), not a precision bug the way a
    // model-number substitution (the two CRITICAL cases above) would
    // be, precisely because "asus" has no digit.
    const ranked = rankBySignificantTokens('asus laptop', LAPTOPS, text)
    expect(ranked.length).toBe(2)
    expect(ranked.every((r) => r.item.name.includes('LAPTOP'))).toBe(true)
  })

  it('CRITICAL: a model-code query ("a26") must NOT match a longer, unrelated code ("a2603") — real catalog audit (Oct 2026)', () => {
    // Taken verbatim from a direct, read-only query against the real
    // "Consultas KC" catalog: searching "A26" (the real Samsung A26)
    // also textually contains "A2603", an unrelated iPad touch
    // digitizer part's SKU-ish fragment. Two different model codes are
    // two different products — this must never be presented as a match.
    const realCatalog = [
      { name: 'SAMSUNG A26 5G 128GB + 6GB NEGRO' },
      { name: 'Touch Screen Digitizer For iPad 9 10.2 9th Gen A2603 A2604 A2602 2021' },
    ]
    const ranked = rankBySignificantTokens('a26', realCatalog, text)
    expect(ranked.length).toBe(1)
    expect(ranked[0].item.name).toBe('SAMSUNG A26 5G 128GB + 6GB NEGRO')
  })
})

// ============================================================
// FASE FINAL DE AUDITORÍA — every query variant explicitly listed for
// review, run against a MULTI-CATEGORY catalog (phones, TVs, A/C, fans)
// to prove the logic is generic, not hardcoded for any one brand/kind.
// Each group asserts every equivalent phrasing resolves to the same
// top result, and that distinct real variants (different price/stock)
// are never conflated.
// ============================================================
describe('rankBySignificantTokens — full audit query list (generic across categories)', () => {
  const STORE = [
    // Phones — model code + capacity + color, no dedicated columns
    { name: 'SAMSUNG A07 128GB NEGRO', price: 9000, stock: 5 },
    { name: 'SAMSUNG A07 128GB MORADO', price: 9000, stock: 3 },
    { name: 'SAMSUNG A07 128GB VERDE', price: 9000, stock: 0 },
    { name: 'SAMSUNG A07 64GB NEGRO', price: 7500, stock: 2 },
    { name: 'SAMSUNG A07 64GB MORADO', price: 7500, stock: 0 },
    { name: 'SAMSUNG A05 128GB NEGRO', price: 8500, stock: 4 }, // decoy: different model
    // TVs — size with no unit at all in the real name
    { name: 'TV TCL GOOGLE TV SMART 50 4K ULTRA HD RESOLUTION', price: 24500, stock: 6 },
    { name: 'TV TCL GOOGLE TV SMART 65 4K ULTRA HD RESOLUTION', price: 38500, stock: 1 },
    // Appliances — proves the logic isn't phone/TV-specific
    { name: 'AIRE ACONDICIONADO VIDVIE 12000 BTU SPLIT INVERTER', price: 26500, stock: 4 },
    { name: 'ABANICO RECARGABLE STARZ', price: 3000, stock: 10 },
  ]
  const text = (p: { name: string }) => p.name

  const samsungA07Queries = ['Samsung A07', 'Samsung A 07', 'Samsung A-07', 'A07', 'a 07', 'a-07']
  it.each(samsungA07Queries)('%s → Samsung A07 rows, never the A05 decoy', (q) => {
    const ranked = rankBySignificantTokens(q, STORE, text)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked.every((r) => r.item.name.includes('A07'))).toBe(true)
    expect(ranked.some((r) => r.item.name.includes('A05'))).toBe(false)
  })

  const tcl50Queries = ['50 pulgadas', '50"', '50 pulgadas TCL', 'TCL 50', 'TV TCL de 50', 'la TCL de 50']
  it.each(tcl50Queries)('%s → the 50" TCL, never the 65" one', (q) => {
    const ranked = rankBySignificantTokens(q, STORE, text)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].item.name).toContain('50')
    expect(ranked[0].item.name).not.toContain('65')
  })

  it('"esa TCL" / "esa de 50" alone are pure anaphora — outside a normalizer\'s job', () => {
    // Neither phrase names a brand/attribute a text search can act on;
    // resolving them requires the conversational catalog CONTEXT (see
    // context.test.ts), not the search layer. Documented here so the
    // boundary between the two mechanisms is explicit, not assumed.
    expect(rankBySignificantTokens('esa', STORE, text)).toEqual([])
  })

  const capacityQueries = ['64GB', '64 GB', 'de 64', 'el negro de 64']
  it.each(capacityQueries)('%s → actually finds the 64GB row, with its own price — never the 128GB one', (q) => {
    const ranked = rankBySignificantTokens(q, STORE, text)
    const a07_64 = ranked.find((r) => r.item.name === 'SAMSUNG A07 64GB NEGRO')
    // Must genuinely be found, not just "if present" — this is the real
    // regression check: "de 64" bare must resolve, not silently return
    // nothing because its own merge-noise token ("de64") can't match.
    expect(a07_64).toBeDefined()
    expect(a07_64!.item.price).toBe(7500)
    // The 128GB variant must NEVER appear for an explicit "64" query —
    // that would be exactly the capacity-merge bug this guards against.
    expect(ranked.some((r) => r.item.name === 'SAMSUNG A07 128GB NEGRO')).toBe(false)
  })

  it('"la morada" / "el verde" match on color alone across different products (generic, not Samsung-specific)', () => {
    const morada = rankBySignificantTokens('morado', STORE, text)
    expect(morada.some((r) => r.item.name.includes('MORADO'))).toBe(true)
    const verde = rankBySignificantTokens('verde', STORE, text)
    expect(verde.some((r) => r.item.name.includes('VERDE'))).toBe(true)
  })

  it('a non-phone, non-TV category (A/C, fan) is found the same way — the logic is generic', () => {
    const ac = rankBySignificantTokens('aire acondicionado vidvie 12000', STORE, text)
    expect(ac[0]?.item.name).toContain('AIRE ACONDICIONADO')
    const fan = rankBySignificantTokens('abanico starz', STORE, text)
    expect(fan[0]?.item.name).toContain('ABANICO')
  })

  it('every 128GB variant keeps its OWN price/stock — never inherited from another color', () => {
    const results = rankBySignificantTokens('samsung a07 128gb', STORE, text)
    const negro = results.find((r) => r.item.name.includes('NEGRO'))!
    const verde = results.find((r) => r.item.name.includes('VERDE'))!
    expect(negro.item.price).toBe(9000)
    expect(verde.item.price).toBe(9000) // same price here, but from ITS OWN row
    expect(negro.item.stock).toBe(5)
    expect(verde.item.stock).toBe(0) // different stock — proves rows are independent, not merged
  })
})

// ============================================================
// Mission E/F audit (Oct 2026) — generic category queries. Real
// incident: NO phone name in the real "Consultas KC" catalog contains
// "celular"/"telefono"/"smartphone"/"movil" literally (confirmed by
// direct, read-only query), so a bare category query like "celulares"
// previously found nothing, or — worse — accidentally matched the one
// unrelated product whose name happens to contain "MOVIL" as part of
// a reseller-name suffix ("TOUCH SAMSUNG S6810 MUNDO MOVIL").
// ============================================================
describe('isBarePhoneCategoryQuery', () => {
  it('recognizes singular and plural phone-category words, in Spanish and their synonyms', () => {
    for (const q of ['celular', 'celulares', 'telefono', 'telefonos', 'teléfono', 'teléfonos', 'smartphone', 'smartphones', 'movil', 'moviles', 'cel', 'celes']) {
      expect(isBarePhoneCategoryQuery(q)).toBe(true)
    }
  })

  it('is false when the query has a real anchor (brand/model) alongside the category word', () => {
    // "celular samsung" has a real, text-matchable anchor ("samsung")
    // — this must go through the NORMAL ranking path, not the bare-
    // category structural bypass.
    expect(isBarePhoneCategoryQuery('celular samsung')).toBe(false)
    expect(isBarePhoneCategoryQuery('samsung a07')).toBe(false)
  })

  it('is false for an unrelated category (TVs, appliances) or an empty query', () => {
    expect(isBarePhoneCategoryQuery('televisor')).toBe(false)
    expect(isBarePhoneCategoryQuery('nevera')).toBe(false)
    expect(isBarePhoneCategoryQuery('')).toBe(false)
    expect(isBarePhoneCategoryQuery('   ')).toBe(false)
  })
})

describe('splitCategorySegments', () => {
  it('a query with no comma is returned as its own single-element array, unchanged', () => {
    expect(splitCategorySegments('Samsung A07')).toEqual(['Samsung A07'])
  })

  it('splits an explicit comma-separated category list into trimmed segments', () => {
    expect(splitCategorySegments('neveras, estufas, lavadoras')).toEqual(['neveras', 'estufas', 'lavadoras'])
  })

  it('drops empty segments from stray/trailing commas', () => {
    expect(splitCategorySegments('neveras, , estufas,')).toEqual(['neveras', 'estufas'])
  })
})

describe('rankBySignificantTokensMultiCategory — multi-category OR semantics (Mission F)', () => {
  const APPLIANCES = [
    { name: 'NEVERA MARCA1 10 PIES' },
    { name: 'ESTUFA MARCA2 5 HORNILLAS' },
    { name: 'LAVADORA MARCA3 11KG' },
  ]
  const text = (p: { name: string }) => p.name

  it('CRITICAL: "neveras, estufas, lavadoras" recovers all three real categories — the strict-majority threshold alone would find none', () => {
    // Direct proof of the bug this fixes: the single-query path finds
    // NOTHING, because no product is ever both a nevera AND an estufa.
    expect(rankBySignificantTokens('neveras, estufas, lavadoras', APPLIANCES, text)).toEqual([])

    const merged = rankBySignificantTokensMultiCategory('neveras, estufas, lavadoras', APPLIANCES, text)
    expect(merged.map((m) => m.item.name).sort()).toEqual(
      ['ESTUFA MARCA2 5 HORNILLAS', 'LAVADORA MARCA3 11KG', 'NEVERA MARCA1 10 PIES'],
    )
  })

  it('a 2-category OR query ("neveras, lavadoras") recovers both, excluding the unrelated estufa', () => {
    const merged = rankBySignificantTokensMultiCategory('neveras, lavadoras', APPLIANCES, text)
    expect(merged.map((m) => m.item.name).sort()).toEqual(['LAVADORA MARCA3 11KG', 'NEVERA MARCA1 10 PIES'])
  })

  it('CRITICAL: a single query with NO comma delegates unchanged — "Samsung A07" still never returns "Samsung A05"', () => {
    const PHONES = [
      { name: 'SAMSUNG A07 128GB NEGRO' },
      { name: 'SAMSUNG A05 128GB NEGRO' }, // decoy: different model
    ]
    const result = rankBySignificantTokensMultiCategory('Samsung A07', PHONES, text)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((r) => r.item.name.includes('A07'))).toBe(true)
    expect(result.some((r) => r.item.name.includes('A05'))).toBe(false)
    // Byte-for-byte the same result the single-query function alone gives.
    expect(result).toEqual(rankBySignificantTokens('Samsung A07', PHONES, text))
  })
})

// ============================================================
// Mission F.2 audit (Oct 2026) — confirmed regression, reproduced by
// direct execution: the FIRST version of the comma-handling fix
// (Mission F) treated any non-empty whole-query result as reliable,
// but plain rankBySignificantTokens on "Samsung A07, el negro" (and
// even on "Samsung A07 negro" with NO comma at all) already admits
// "Samsung A05 ... NEGRO" — "samsung" + "negro" alone (2 of 3 tokens)
// clears the strict-majority threshold without "a07" needing to match
// anything. This closes that gap WITHOUT touching
// rankBySignificantTokens itself (see matchesEveryDigitToken's doc).
// ============================================================
describe('rankBySignificantTokensMultiCategory — comma as a QUALIFIER for one item, not a category list (Mission F.2)', () => {
  const MIXED = [
    { name: 'SAMSUNG A07 128GB NEGRO' },
    { name: 'SAMSUNG A05 128GB NEGRO' }, // decoy: different model, SAME color
    { name: 'TV TCL GOOGLE TV SMART 50 4K ULTRA HD NEGRO' }, // unrelated category, also black
    { name: 'NEVERA GHOME 10 PIES NEGRO' }, // unrelated category, also black
  ]
  const text = (p: { name: string }) => p.name

  it('CRITICAL (the confirmed regression): "Samsung A07, el negro" excludes the A05 decoy, the TV, and the nevera — ALL of them share "negro"', () => {
    // Pre-fix, plain rankBySignificantTokens on this exact string
    // already returns both A07 and A05 (verified directly) — proving
    // the gap is NOT introduced by comma-splitting itself, only
    // exposed by it. The multi-category wrapper must correct it.
    const result = rankBySignificantTokensMultiCategory('Samsung A07, el negro', MIXED, text)
    expect(result.map((r) => r.item.name)).toEqual(['SAMSUNG A07 128GB NEGRO'])
  })

  it('the SAME gap is already present with no comma at all — confirms this is a pre-existing rankBySignificantTokens characteristic, not something comma-handling introduced', () => {
    const plain = rankBySignificantTokens('Samsung A07 negro', MIXED, text)
    expect(plain.map((r) => r.item.name)).toContain('SAMSUNG A05 128GB NEGRO') // the gap, unmodified
  })

  it('"neveras, estufas, lavadoras" is unaffected by the digit-token guard — none of its tokens carry a digit, and the whole query already finds nothing', () => {
    const APPLIANCES = [
      { name: 'NEVERA MARCA1 10 PIES' },
      { name: 'ESTUFA MARCA2 5 HORNILLAS' },
      { name: 'LAVADORA MARCA3 11KG' },
    ]
    const merged = rankBySignificantTokensMultiCategory('neveras, estufas, lavadoras', APPLIANCES, text)
    expect(merged.map((m) => m.item.name).sort()).toEqual(
      ['ESTUFA MARCA2 5 HORNILLAS', 'LAVADORA MARCA3 11KG', 'NEVERA MARCA1 10 PIES'],
    )
  })

  it('a non-model qualifier with no digit at all ("Samsung, el negro") still excludes unrelated categories via the ordinary majority threshold', () => {
    const result = rankBySignificantTokensMultiCategory('Samsung, el negro', MIXED, text)
    expect(result.every((r) => r.item.name.startsWith('SAMSUNG'))).toBe(true)
    expect(result.some((r) => r.item.name.includes('TV') || r.item.name.includes('NEVERA'))).toBe(false)
  })
})

describe('rankBySignificantTokensMultiCategory — a per-segment strategy override resolves mixed category lists (Mission F.2)', () => {
  // A minimal stand-in for DataSourceCatalogProvider's real
  // rankRowsForSegment (classify.ts-aware): the SAME real trigger
  // (isBarePhoneCategoryQuery) this function already uses internally
  // to decide whether a segment needs non-textual handling, paired
  // with a toy "structural" selector (every candidate whose name
  // contains "DEVICE") standing in for classify.ts's real
  // classifyProductConfidence — kept here purely textual so this test
  // stays scoped to normalize.ts's own contract, without importing
  // classify.ts into a normalize.ts test.
  function rankSegmentStub<T extends { name: string }>(segmentQuery: string, items: T[], getText: (i: T) => string) {
    if (isBarePhoneCategoryQuery(segmentQuery)) {
      return items.filter((i) => i.name.includes('DEVICE')).map((item) => ({ item, score: 0, matchedTokens: 0 }))
    }
    return rankBySignificantTokens(segmentQuery, items, getText)
  }

  it('CRITICAL: "celulares, neveras" resolves the "celulares" segment structurally AND the "neveras" segment textually — neither is lost', () => {
    const MIXED = [
      { name: 'DEVICE-SHAPED-ROW-1' },
      { name: 'DEVICE-SHAPED-ROW-2' },
      { name: 'NEVERA GHOME 10 PIES' },
    ]
    const text = (p: { name: string }) => p.name
    // Proof this NEEDS the per-segment path: the whole-query shortcut
    // alone (default rankSegment) finds only the nevera — the generic
    // "a token matching nothing anywhere is a droppable qualifier"
    // relaxation silently treats "celulares" as noise instead of its
    // own category (the exact Mission F.2 regression).
    const withoutOverride = rankBySignificantTokensMultiCategory('celulares, neveras', MIXED, text)
    expect(withoutOverride.map((r) => r.item.name)).toEqual(['NEVERA GHOME 10 PIES'])

    const result = rankBySignificantTokensMultiCategory('celulares, neveras', MIXED, text, rankSegmentStub)
    expect(result.map((r) => r.item.name).sort()).toEqual(['DEVICE-SHAPED-ROW-1', 'DEVICE-SHAPED-ROW-2', 'NEVERA GHOME 10 PIES'])
  })
})

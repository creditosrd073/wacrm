import { describe, it, expect } from 'vitest'
import { isLikelyAccessoryOrPart, isLikelyResidentialPhone, guessBrandFromName, classifyProductConfidence } from './classify'

// ============================================================
// Broad-search reliability audit (Oct 2026) — every fixture name below
// is taken VERBATIM from a direct, read-only query against the real
// "Consultas KC" production catalog (confirmed: brand is NULL on every
// row there, and ~51% of a 1000-row sample are repair parts/
// accessories, not sellable devices) — not invented examples.
// ============================================================

describe('isLikelyAccessoryOrPart', () => {
  it('classifies real repair-part names from the production catalog as accessory/part', () => {
    const parts = [
      'PANTALLA SAMSUNG A07',
      'BATERIA SAMSUNG A05 A055M',
      'CABLE SAMSUNG ORIGINAL USB-C TO USB-C',
      'FLEX DE MICROFONO Y AUXILIAR SAMSUNG J8 J810',
      'CONECTOR DE FLEX SAMSUNG A50',
      'CONTROL REMOTO TV SAMSUNG BN59-01315A',
      'CRISTAL DE CAMARA TRASERA SAMSUNG NOTE 20 ULTRA',
      'BASE DE CARGA SAMSUNG A50',
      'FUENTE USB-C SAMSUNG 45W',
    ]
    for (const name of parts) expect(isLikelyAccessoryOrPart(name)).toBe(true)
  })

  it('does NOT classify real sellable-phone names from the production catalog as accessory/part', () => {
    const devices = [
      'MOTOROLA G06 64GB + 4GB NARANJA',
      'HONOR PLAY 10 64GB + 3GB ELA-LX3 AZUL',
      'SAMSUNG A16 128GB + 4GB GRIS',
      'INFINIX SMART 20 64GB + 4GB AZUL',
      'M-HORSE S26 ULTRA MAX 128GB + 6GB GRIS',
      'TV SAMSUNG 65 UHD U7900FD',
    ]
    for (const name of devices) expect(isLikelyAccessoryOrPart(name)).toBe(false)
  })

  it('never positively asserts "device" — only a negative, narrow signal', () => {
    // An unrelated/ambiguous name is simply unclassified (false), never
    // a claim it IS a device — see the module's own doc on why.
    expect(isLikelyAccessoryOrPart('ALGO NUNCA VISTO XYZ123')).toBe(false)
  })
})

describe('isLikelyResidentialPhone', () => {
  it('classifies the real residential-phone names from the production catalog', () => {
    expect(isLikelyResidentialPhone('TELEFONO RESIDENCIAL DE SIM CARD HUAWEI')).toBe(true)
    expect(isLikelyResidentialPhone('TELEFONO RESIDENCIAL MODELO. SPANS')).toBe(true)
  })

  it('does NOT classify a real smartphone, TV, or repair part as a residential phone', () => {
    expect(isLikelyResidentialPhone('SAMSUNG A16 128GB + 4GB GRIS')).toBe(false)
    expect(isLikelyResidentialPhone('TV SAMSUNG 65 UHD U7900FD')).toBe(false)
    expect(isLikelyResidentialPhone('PANTALLA SAMSUNG A07')).toBe(false)
  })

  it('does NOT false-positive on an unrelated "inalambrico" product that is not a phone at all', () => {
    // Real catalog check (Oct 2026): "%INALAMBRICO%" alone matches 10
    // real rows, none of them a telephone (mice, keyboards, alarm
    // sensors) — the keyword list requires "TELEFONO" immediately
    // before it, not "inalambrico" on its own.
    expect(isLikelyResidentialPhone('MOUSE Fantech INALAMBRICO Gaming (Mod. WG12RS-NEGRO RAIGOR III)')).toBe(false)
    expect(isLikelyResidentialPhone('DAHUA SENSOR MOVIMIENTO INALAMBRICO 433MHZ - DHI-ARD1233-W2')).toBe(false)
  })
})

describe('guessBrandFromName', () => {
  it('guesses the real brand from plain device names', () => {
    expect(guessBrandFromName('MOTOROLA G06 64GB + 4GB NARANJA')).toBe('MOTOROLA')
    expect(guessBrandFromName('SAMSUNG A16 128GB + 4GB GRIS')).toBe('SAMSUNG')
    expect(guessBrandFromName('M-HORSE S26 ULTRA MAX 128GB + 6GB GRIS')).toBe('M-HORSE')
  })

  it('strips a single leading category/part word before guessing', () => {
    expect(guessBrandFromName('TV SAMSUNG 65 UHD U7900FD')).toBe('SAMSUNG')
    expect(guessBrandFromName('PANTALLA SAMSUNG A07')).toBe('SAMSUNG')
    expect(guessBrandFromName('BATERIA SAMSUNG A05 A055M')).toBe('SAMSUNG')
  })

  it('strips TWO leading phrases in a row ("CONTROL REMOTO TV SAMSUNG...")', () => {
    expect(guessBrandFromName('CONTROL REMOTO TV SAMSUNG BN59-01315A')).toBe('SAMSUNG')
  })

  it('returns null rather than guessing when the next token is a model/capacity code, not a brand word', () => {
    expect(guessBrandFromName('FUENTE 12V 5AMP - ASTRO SAMSUNG HTLVISION')).toBeNull()
  })

  it('returns null for a name with nothing plausible left after stripping', () => {
    expect(guessBrandFromName('BATERIA')).toBeNull()
  })
})

// ============================================================
// Commercial-veracity audit (Oct 2026) — the real incident this
// closes: a product was treated as a confirmed phone with stock just
// because its name contained "Samsung"/"A16". classifyProductConfidence
// must never return 'likely_device' from name-matching alone unless a
// REAL recognized device pattern (or real brand/model field) backs it.
// ============================================================
describe('classifyProductConfidence', () => {
  it('a real repair part is "accessory_or_part", never anything else, regardless of brand/model fields', () => {
    expect(classifyProductConfidence({ name: 'PANTALLA SAMSUNG A07' })).toBe('accessory_or_part')
    expect(classifyProductConfidence({ name: 'PANTALLA SAMSUNG A07', brand: 'Samsung', model: 'A07' })).toBe('accessory_or_part')
  })

  it('real structured brand/model fields are stronger evidence than any name heuristic — "likely_device"', () => {
    expect(classifyProductConfidence({ name: 'Algo sin patrón de nombre reconocible', brand: 'Samsung' })).toBe('likely_device')
    expect(classifyProductConfidence({ name: 'Algo sin patrón de nombre reconocible', model: 'A16' })).toBe('likely_device')
  })

  it('a real device-naming pattern ("<storage>GB + <ram>GB") is "likely_device" even with no structured fields', () => {
    expect(classifyProductConfidence({ name: 'MOTOROLA G06 64GB + 4GB NARANJA' })).toBe('likely_device')
  })

  it('the real incident: a name that merely MENTIONS a brand/model word, with no structured fields and no real device pattern, is "uncertain" — never "likely_device"', () => {
    expect(classifyProductConfidence({ name: 'Samsung A16' })).toBe('uncertain')
    expect(classifyProductConfidence({ name: 'Touch Samsung A16 genérico' })).toBe('uncertain')
  })

  it('blank/whitespace-only brand or model fields are NOT treated as real structured data', () => {
    expect(classifyProductConfidence({ name: 'Samsung A16', brand: '   ', model: '' })).toBe('uncertain')
  })

  it('CRITICAL (Mission D): a real residential/landline phone is its own category — never "likely_device" (implying smartphone), never "accessory_or_part"', () => {
    expect(classifyProductConfidence({ name: 'TELEFONO RESIDENCIAL DE SIM CARD HUAWEI' })).toBe('residential_phone')
  })

  it('a residential phone stays "residential_phone" even when a real brand/model field is populated for it — the category signal wins over the generic structured-data rule', () => {
    expect(classifyProductConfidence({ name: 'TELEFONO RESIDENCIAL SAMSUNG X200', brand: 'Samsung', model: 'X200' })).toBe('residential_phone')
  })
})

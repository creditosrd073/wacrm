// ============================================================
// Broad-search reliability audit (Oct 2026) — real-catalog-driven
// heuristics for the two gaps a direct read of the live "Consultas KC"
// data source demonstrated (not assumed):
//
//   1. `brand` is NULL on every single row of that real data source
//      (confirmed: `column_mapping.brand` is unset for it) — so
//      facets.ts's real `brands` aggregation is always empty for an
//      account like this one, with no way to discover brands at all.
//   2. Of a 1000-row sample of that same real catalog, ~51% are repair
//      PARTS (e.g. "PANTALLA SAMSUNG A07", "FLEX DE MICROFONO...",
//      "BATERIA SAMSUNG A05") rather than sellable devices (only ~4%
//      matched the real phone-listing pattern, e.g. "MOTOROLA G06
//      64GB + 4GB NARANJA") — and there is no field distinguishing
//      them. A plain "Samsung" search returns a flood of part listings
//      drowning out the handful of real phones, with nothing the model
//      can filter on, which is the real mechanism behind "qué
//      teléfonos tienen"/"qué marcas tienes" failing or coming back
//      incomplete — not simply the tool-call budget.
//
// Both heuristics below are derived EXCLUSIVELY from the real `name`
// text already on the product — never a second query, never an
// invented structured field. Neither is authoritative: a part/
// accessory name that happens not to contain a listed keyword is
// simply unclassified (never positively asserted as a device), and a
// brand guess is clearly labeled as a guess, never merged into the
// real `brand` facet. This is the same "additive, honestly labeled
// signal, never a replacement for real data" discipline as
// `price_confirmed` (whitelist.ts) and `facets` (facets.ts) itself.
// ============================================================

/**
 * Curated, conservative list of repair-part/accessory indicators
 * observed directly in the real catalog. Deliberately narrow (not a
 * general thesaurus) so it can't misclassify an actual device whose
 * name happens to share a word — every entry here is a term that
 * denotes a PART or ACCESSORY, never a brand, model, or color.
 */
const ACCESSORY_OR_PART_KEYWORDS = [
  'PANTALLA', 'FLEX', 'CONECTOR', 'CRISTAL', 'CONTROL REMOTO', 'FUENTE',
  'BATERIA', 'CABLE', 'FUNDA', 'BASE DE CARGA', 'CARGADOR', 'TAPA',
  'BISEL', 'MICROFONO', 'BOCINA', 'CAMARA TRASERA', 'CAMARA FRONTAL',
  'ANTENA', 'BOTON', 'PROTECTOR', 'VIDRIO', 'LAMINA', 'MICA', 'SOPORTE',
  'AURICULAR', 'AUDIFONO', 'ADAPTADOR', 'CARCASA', 'TORNILLO',
  'PIN DE CARGA', 'EMPAQUE', 'ALTAVOZ', 'VIBRADOR', 'SENSOR', 'MODULO',
  'FORRO', 'ESTUCHE',
]

/**
 * True only when `name` contains one of the curated part/accessory
 * keywords above — never a positive claim that anything else IS a
 * device. Callers must treat `false` as "not obviously a part or
 * accessory" (could be a device, could be something else entirely),
 * not as "confirmed device" — see this module's doc for why asserting
 * the positive case isn't safe without a real category field.
 */
export function isLikelyAccessoryOrPart(name: string): boolean {
  const upper = name.toUpperCase()
  return ACCESSORY_OR_PART_KEYWORDS.some((kw) => upper.includes(kw))
}

/**
 * Curated indicators of a residential/landline phone — a real, distinct
 * category this catalog actually has (confirmed directly against the
 * live "Consultas KC" data: "TELEFONO RESIDENCIAL DE SIM CARD HUAWEI",
 * "TELEFONO RESIDENCIAL MODELO. SPANS"). The incident this closes: a
 * brand matching only a residential phone must never be reported as
 * "no smartphones of that brand" (wrong — a non-smartphone product of
 * that brand DOES exist) nor as "we have a Samsung smartphone" (wrong —
 * it's a landline). "TELEFONO FIJO"/"TELEFONO DE MESA" are the same
 * real-world concept under its other common Spanish names, kept narrow
 * rather than a general thesaurus, same discipline as the accessory list.
 */
const RESIDENTIAL_PHONE_KEYWORDS = ['TELEFONO RESIDENCIAL', 'TELEFONO FIJO', 'TELEFONO DE MESA', 'TELEFONO INALAMBRICO']

/**
 * True only when `name` contains one of the curated residential-phone
 * keywords above — same "narrow, additive, never a positive claim about
 * anything else" discipline as `isLikelyAccessoryOrPart`.
 */
export function isLikelyResidentialPhone(name: string): boolean {
  const upper = name.toUpperCase()
  return RESIDENTIAL_PHONE_KEYWORDS.some((kw) => upper.includes(kw))
}

/** Category/type words that precede the brand in this catalog's real
 *  naming convention (e.g. "TV SAMSUNG...", "CONTROL REMOTO TV
 *  SAMSUNG..."). Sorted longest-first so a multi-word phrase is
 *  stripped whole, never just its first word. Same list family as
 *  normalize.ts's own SYNONYM_GROUPS first entries, kept separate
 *  because this module's job (extracting a brand candidate) differs
 *  from query-matching. */
const LEADING_NON_BRAND_PHRASES = [...ACCESSORY_OR_PART_KEYWORDS, 'TV', 'TELEVISOR', 'SMART', 'LED', 'QLED', 'UHD', 'GOOGLE']
  .sort((a, b) => b.length - a.length)

/**
 * Best-effort brand guess from the product's real name, for a catalog
 * where the structured `brand` column is unpopulated — e.g. "PANTALLA
 * SAMSUNG A07" or "CONTROL REMOTO TV SAMSUNG BN59..." → "SAMSUNG",
 * "MOTOROLA G06 64GB + 4GB NARANJA" → "MOTOROLA". Strips known leading
 * category/part phrases (whole phrases, not word-by-word — "CONTROL
 * REMOTO" must come off together), then takes the next word IF it
 * looks like a brand token (letters only, length >= 3 — excludes
 * model codes like "A07", "G06"). Returns null when nothing plausible
 * is found — never a fabricated default.
 *
 * Deliberately never merged into `CatalogFacets.brands` (the REAL
 * aggregation from the `brand` column) — see facets.ts's `brandGuesses`
 * field, which this feeds, kept visibly distinct so a model/customer
 * is never told a guess is confirmed data.
 */
export function guessBrandFromName(name: string): string | null {
  let remaining = name.trim().toUpperCase()
  // Strip every leading category/part phrase, repeatedly — handles
  // "CONTROL REMOTO TV SAMSUNG..." (two leading phrases in a row).
  for (;;) {
    const hit = LEADING_NON_BRAND_PHRASES.find((phrase) => remaining.startsWith(phrase))
    if (!hit) break
    remaining = remaining.slice(hit.length).trim()
  }
  const firstWord = remaining.split(/\s+/)[0]?.replace(/[^A-Z0-9-]/g, '') ?? ''
  if (!firstWord) return null
  // A plausible brand token: letters/hyphens only, at least 3 chars —
  // excludes model/capacity codes ("A07", "128GB"), which always
  // contain a digit.
  return /^[A-Z][A-Z-]{2,}$/.test(firstWord) ? firstWord : null
}

/** Real catalog naming pattern for a sellable phone in THIS catalog's
 *  convention — "<model> <storage>GB + <ram>GB <color>" (confirmed
 *  against real rows: "MOTOROLA G06 64GB + 4GB NARANJA", "SAMSUNG A56
 *  5G 256GB + 12GB NEGRO"). Catalogs with a different real naming
 *  convention simply won't match this — they fall back to `uncertain`
 *  below rather than a false negative being treated as "not a device". */
const DEVICE_NAME_PATTERN = /\d+GB\s*\+\s*\d+GB/i

/**
 * Commercial-veracity audit (Oct 2026), ternary product confidence —
 * never a binary "is a smartphone" claim from name-matching alone
 * (the real incident this closes: a product was treated as confirmed
 * stock because its name contained "Samsung"/"A16"). Prefers real
 * structured fields when the catalog actually has them; falls back to
 * the name-text heuristics above ONLY when those are absent, and even
 * then only ever returns 'likely_device' when there's REAL positive
 * evidence (a recognized naming pattern) — never merely "didn't match
 * a part keyword", which stays 'uncertain' instead.
 *
 * 'residential_phone' is checked BEFORE the structured brand/model
 * fields below: a residential/landline phone is never a smartphone
 * REGARDLESS of whether `brand`/`model` happen to be populated for it —
 * those fields describe WHICH brand/model, not WHAT KIND of device, and
 * conflating "has a brand field" with "likely_device" would silently
 * reintroduce the same kind of category confusion this module exists
 * to prevent.
 */
export type ProductConfidence = 'accessory_or_part' | 'residential_phone' | 'uncertain' | 'likely_device'

export function classifyProductConfidence(product: { name: string; brand?: string | null; model?: string | null }): ProductConfidence {
  if (isLikelyAccessoryOrPart(product.name)) return 'accessory_or_part'
  if (isLikelyResidentialPhone(product.name)) return 'residential_phone'
  // Real structured data, when the catalog actually has it, is
  // stronger evidence than any name heuristic — "usar campos
  // estructurados cuando existan".
  if ((product.brand && product.brand.trim()) || (product.model && product.model.trim())) return 'likely_device'
  if (DEVICE_NAME_PATTERN.test(product.name)) return 'likely_device'
  return 'uncertain'
}

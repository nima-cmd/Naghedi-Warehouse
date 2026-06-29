// Catalog service — manages SKU catalog data.
//
// Current storage: localStorage (single-device, no setup required)
//
// ── When you're ready to go online ───────────────────────────────────────────
// Replace the bodies of loadCatalog() and saveCatalog() with Airtable or
// NetSuite API calls. App.jsx, ControlPanel, and all packing logic stay
// unchanged — they only call the three functions exported below.
//
// For NetSuite API: replace parseCatalogCsv() with a fetchFromNetSuite() that
// returns the same shape: { [sku: string]: { qty: number, name: string } }

const CACHE_KEY    = 'wh_sku_catalog'
const CACHE_TS_KEY = 'wh_catalog_updated_at'
const LOC_QTYS_KEY  = 'wh_location_qtys'
const LOC_NAMES_KEY = 'wh_location_names'

// ── Parse CSV ─────────────────────────────────────────────────────────────────
// Pure function: NetSuite Warehouse Item View CSV text →
//   { catalog: { [sku]: { qty, name } }, locationBreakdown: { [sku]: { [loc]: qty } }, locationNames: string[] }
// Location names come from column headers dynamically — stripping the NetSuite
// aggregate prefix ("Maximum of", "Sum of", etc.) so users can rename them freely.
export function parseCatalogCsv(csvText) {
  const lines      = csvText.trim().split('\n')
  const catalog    = {}
  const locationBreakdown = {}
  const skuPattern = /^[A-Z][A-Z0-9-]+$/

  // Parse header row to extract location names from column 2 onwards
  const headerCols = lines[0].trim().split(',').map(h => h.trim())
  const locationNames = []
  const locationColIndices = []
  for (let ci = 2; ci < headerCols.length; ci++) {
    const locName = headerCols[ci]
      .replace(/^(Maximum|Minimum|Average|Sum|Count) of /i, '')
      .trim()
    if (locName) { locationNames.push(locName); locationColIndices.push(ci) }
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(',')
    const sku  = cols[0]?.trim()
    if (!sku || !skuPattern.test(sku)) continue
    const name = cols[1]?.trim() ?? ''

    let qty = 0
    const breakdown = {}
    for (let j = 0; j < locationColIndices.length; j++) {
      const locQty = Number(cols[locationColIndices[j]]) || 0
      qty += locQty
      if (locQty > 0) breakdown[locationNames[j]] = locQty
    }
    catalog[sku] = { qty, name }
    if (Object.keys(breakdown).length > 0) locationBreakdown[sku] = breakdown
  }

  return { catalog, locationBreakdown, locationNames }
}

// ── Location qty persistence ───────────────────────────────────────────────────
export function saveLocationQtys(locationBreakdown, locationNames) {
  try {
    localStorage.setItem(LOC_QTYS_KEY,  JSON.stringify(locationBreakdown))
    localStorage.setItem(LOC_NAMES_KEY, JSON.stringify(locationNames))
  } catch {}
}

export function loadLocationQtys() {
  try {
    return {
      locationBreakdown: JSON.parse(localStorage.getItem(LOC_QTYS_KEY))  ?? {},
      locationNames:     JSON.parse(localStorage.getItem(LOC_NAMES_KEY)) ?? [],
    }
  } catch {
    return { locationBreakdown: {}, locationNames: [] }
  }
}

// ── Load ─────────────────────────────────────────────────────────────────────
// Returns { catalog, updatedAt } or null if no catalog has been imported yet.
export async function loadCatalog() {
  try {
    const json = localStorage.getItem(CACHE_KEY)
    const ts   = localStorage.getItem(CACHE_TS_KEY)
    if (!json) return null
    const raw = JSON.parse(json)
    // Migrate old format where values were plain numbers instead of { qty, name }
    const catalog = Object.fromEntries(
      Object.entries(raw).map(([sku, val]) =>
        [sku, typeof val === 'number' ? { qty: val, name: '' } : val]
      )
    )
    return { catalog, updatedAt: ts }
  } catch {
    return null
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
// Persists catalog to localStorage and returns the ISO timestamp of the save.
// onProgress is accepted but unused (reserved for the future Airtable/API implementation).
export function saveCatalog(catalog, { onProgress } = {}) {
  const ts = new Date().toISOString()
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(catalog))
    localStorage.setItem(CACHE_TS_KEY, ts)
  } catch {}
  return ts
}

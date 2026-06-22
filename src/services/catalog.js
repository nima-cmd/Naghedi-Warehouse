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

// ── Parse CSV ─────────────────────────────────────────────────────────────────
// Pure function: NetSuite CSV text → { [sku]: { qty, name } }
// This is the only place that knows the NetSuite CSV export format.
export function parseCatalogCsv(csvText) {
  const lines      = csvText.trim().split('\n')
  const catalog    = {}
  const skuPattern = /^[A-Z][A-Z0-9-]+$/
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(',')
    const sku  = cols[0]?.trim()
    if (!sku || !skuPattern.test(sku)) continue
    const name = cols[1]?.trim() ?? ''
    // Sum all 6 quantity columns (Warehouse, Virtual WH, Bloomingdales, Nordstrom, Shopbop, Saint Bernard)
    const qty = [2, 3, 4, 5, 6, 7].reduce((s, ci) => s + (Number(cols[ci]) || 0), 0)
    catalog[sku] = { qty, name }
  }
  return catalog
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

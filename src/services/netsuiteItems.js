// NetSuite Items catalog — SKU lookup index and style-color matching index.
// Mirrors catalog.js: pure parse function + localStorage cache.
//
// styleColorIndex enables packing-slip matching:
//   packing slip has STYLE NO + COLOR → we construct 'STYLE-COLOR'
//   styleColorIndex['NS03090LD-ADOBE'] → ['NS03090LD-ADOBE-350', 'NS03090LD-ADOBE-360', ...]

const ITEMS_KEY = 'netsuite_items'
const INDEX_KEY = 'netsuite_items_sc_index'
const TS_KEY    = 'netsuite_items_updated_at'

function parseCSVLine(line) {
  const cols = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      cols.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cols.push(cur.trim())
  return cols
}

// 'NS03090LD-ADOBE-350' → 'NS03090LD-ADOBE'   (shoe: strip 3-digit size suffix)
// 'SN37043NG-CHOCOLATE' → 'SN37043NG-CHOCOLATE' (bag: unchanged)
function styleColorKey(sku) {
  const parts = sku.split('-')
  if (parts.length > 2 && /^\d{3,4}$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('-')
  }
  return sku
}

// ── Parse ─────────────────────────────────────────────────────────────────────
// Returns { itemsBySku, styleColorIndex }
export function parseNetsuiteItemsCsv(csvText) {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return { itemsBySku: {}, styleColorIndex: {} }

  // Build column map from header row
  const headers = parseCSVLine(lines[0])
  const col = {}
  headers.forEach((h, i) => {
    const k = h.trim().toLowerCase()
    if (k === 'sku')          col.sku         = i
    else if (k === 'name')    col.name        = i
    else if (k === 'color (main)' || k === 'color') col.color = i
    else if (k === 'variant size') col.variantSize = i
    else if (k === 'product type') col.productType = i
  })
  // Fallback to known fixed positions if header matching fails
  if (col.sku         === undefined) col.sku         = 1
  if (col.name        === undefined) col.name        = 3
  if (col.color       === undefined) col.color       = 7
  if (col.variantSize === undefined) col.variantSize = 13
  if (col.productType === undefined) col.productType = 14

  const itemsBySku      = {}
  const styleColorIndex = {}

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i])
    const sku  = cols[col.sku]?.trim()
    if (!sku || sku.toLowerCase() === 'sku') continue

    const name        = cols[col.name]?.trim()        ?? ''
    const color       = cols[col.color]?.trim()       ?? ''
    const variantSize = cols[col.variantSize]?.trim() ?? ''
    const productType = cols[col.productType]?.trim() ?? ''

    itemsBySku[sku] = { name, color, variantSize, productType }

    const scKey = styleColorKey(sku)
    if (!styleColorIndex[scKey]) styleColorIndex[scKey] = []
    if (!styleColorIndex[scKey].includes(sku)) styleColorIndex[scKey].push(sku)
  }

  return { itemsBySku, styleColorIndex }
}

// ── Load ──────────────────────────────────────────────────────────────────────
export function loadNetsuiteItems() {
  try {
    const raw = localStorage.getItem(ITEMS_KEY)
    if (!raw) return null
    return {
      itemsBySku:      JSON.parse(raw),
      styleColorIndex: JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}'),
      updatedAt:       localStorage.getItem(TS_KEY),
    }
  } catch {
    return null
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
export function saveNetsuiteItems(itemsBySku, styleColorIndex) {
  const ts = new Date().toISOString()
  try {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(itemsBySku))
    localStorage.setItem(INDEX_KEY, JSON.stringify(styleColorIndex))
    localStorage.setItem(TS_KEY,    ts)
  } catch {}
  return ts
}

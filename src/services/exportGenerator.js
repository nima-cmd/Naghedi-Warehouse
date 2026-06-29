// Generates NetSuite-importable CSV files from container + PO location data.
//
// Inventory Transfer CSV — moves inventory from China to destination warehouse.
// Format reverse-engineered from confirmed imports; one row per SKU per PO group.

// ── Helpers ───────────────────────────────────────────────────────────────────

// Splits a date string that uses either "." or "-" as separator.
// Handles: "2026.05.22", "2026-05-22"  →  ["2026","05","22"]
function splitDate(dateStr) {
  if (!dateStr) return ['', '', '']
  const sep = dateStr.includes('-') ? '-' : '.'
  return dateStr.split(sep)
}

// "2026.05.22" or "2026-05-22" → "2026.5.22"  (no zero-padding, as NetSuite expects in External ID)
function toNSDateLabel(dateStr) {
  const [y, m, d] = splitDate(dateStr)
  if (!y) return ''
  return `${y}.${parseInt(m)}.${parseInt(d)}`
}

// "2026.05.22" or "2026-05-22" → "05/22/2026"
function toMMDDYYYY(dateStr) {
  const [y, m, d] = splitDate(dateStr)
  if (!y) return ''
  return `${m.padStart(2, '0')}/${d.padStart(2, '0')}/${y}`
}

// Wraps a cell value in quotes if it contains commas, quotes, or newlines.
function csvCell(val) {
  const s = String(val ?? '')
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

function rowsToCSV(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\n')
}

// ── PO location cache (localStorage) ─────────────────────────────────────────
// Populated when the user imports the PO Warehouse View CSV.
// Keyed by PO number (e.g. "PO1688") → { location, vendor }

const PO_LOC_KEY = 'wh_po_locations'

export function savePOLocationsLocally(pos) {
  const map = {}
  pos.forEach(po => { map[po.poNumber] = { location: po.location, vendor: po.vendor } })
  try { localStorage.setItem(PO_LOC_KEY, JSON.stringify(map)) } catch {}
}

export function loadPOLocations() {
  try { return JSON.parse(localStorage.getItem(PO_LOC_KEY)) ?? {} } catch { return {} }
}

// ── Shared aggregation ────────────────────────────────────────────────────────

// Groups container boxes by PO number and totals qty per SKU.
// Returns { containerLabel, dateFormatted, poGroups }
// poGroups: { rawPoNumber: { sku: totalQty } }
function aggregateByPO(container) {
  const containerLabel = container.containerDate
    ? `${container.containerNum} carton ${toNSDateLabel(container.containerDate)}`
    : `${container.containerNum} carton`

  const dateFormatted = toMMDDYYYY(container.containerDate)

  const poGroups = {}
  for (const box of container.boxes) {
    const boxPo = box.poNumber
    const skuList = box.skus?.length > 0
      ? box.skus
      : box.sku ? [{ sku: box.sku, qty: box.qty ?? 0 }] : []
    for (const entry of skuList) {
      const { sku, qty } = entry
      if (!sku) continue
      // For multi-PO cartons each SKU entry carries its own poNumber;
      // for normal cartons fall back to the box-level PO.
      const po = entry.poNumber ?? boxPo
      if (!po) continue
      if (!poGroups[po]) poGroups[po] = {}
      poGroups[po][sku] = (poGroups[po][sku] ?? 0) + (qty ?? 0)
    }
  }

  return { containerLabel, dateFormatted, poGroups }
}

// Normalize a raw PO number to always include the PO prefix.
// "1688" → "PO1688",  "PO1688" → "PO1688"
function toPoFull(poNumber) {
  return /^\d+$/.test(poNumber) ? `PO${poNumber}` : poNumber
}

// Look up destination location from the map using either key format.
function lookupLocation(poNumber, poLocationMap) {
  const poFull = toPoFull(poNumber)
  return (poLocationMap[poFull] ?? poLocationMap[poNumber])?.location ?? 'Warehouse'
}

// ── Item Receipt CSV ──────────────────────────────────────────────────────────

// Generates the NetSuite Item Receipt CSV.
// One receipt per PO — receives units into the China location.
// Must be imported into NetSuite BEFORE the Transfer Order CSV.
//
// "Created From" uses the format "PO#PO1688" which NetSuite uses to link
// the receipt back to the originating Purchase Order.
// poLineData shape: { poInternalIds: { 'PO1705': '123456' }, lineSeqs: { 'PO1705-SKU': 3 } }
// Populated by savePOLineDataLocally() in poImport.js when the PO Warehouse View CSV is imported.
export function generateItemReceiptCSV(container, poLineData = {}) {
  const { containerLabel, dateFormatted, poGroups } = aggregateByPO(container)

  const headers = [
    'External ID', 'Created From', 'Date', 'Memo',
    'Item', 'Order Line', 'Quantity', 'Receive', 'To Location',
  ]
  const dataRows = []
  const overReceives = []  // { poNumber, sku, shipped, poQty, excess }

  for (const poNumber of Object.keys(poGroups).sort()) {
    const poFull     = toPoFull(poNumber)
    const poDigits   = poFull.replace(/^PO/i, '')
    const externalId = `EXT-IR-${containerLabel}${poDigits}`
    // NetSuite "Name" reference type expects the full display name of the transaction
    // e.g. "Purchase Order #PO1705" — matches what the import assistant resolves by Name
    const createdFrom = `Purchase Order #${poFull}`
    const skuTotals  = poGroups[poNumber]

    // Build a map of every known SKU → line sequence number for this PO
    // (populated when user imports the PO Warehouse View CSV)
    const allPoSkuLines = new Map()
    for (const [key, lineSeq] of Object.entries(poLineData.lineSeqs ?? {})) {
      if (key.startsWith(`${poFull}-`)) {
        allPoSkuLines.set(key.slice(poFull.length + 1), lineSeq)
      }
    }

    // Receive = T rows for items actually in this shipment.
    // Sorted ascending by order line number — NetSuite's Standard Item Receipt
    // form requires the first row to be the lowest-numbered PO line so it can
    // anchor the receipt correctly before processing later lines.
    const shippedSkus = new Set(Object.keys(skuTotals))
    const toReceive = Object.entries(skuTotals)
      .map(([sku, qty]) => ({ sku, qty, lineSeq: allPoSkuLines.get(sku) ?? '' }))
      .sort((a, b) => (Number(a.lineSeq) || 9999) - (Number(b.lineSeq) || 9999))

    // Over-receive check: compare shipped qty against PO ordered qty.
    // If any SKU would receive more than the PO allows, record the violation.
    for (const { sku, qty } of toReceive) {
      const poQty = poLineData.poQtys?.[`${poFull}-${sku}`]
      if (poQty != null && qty > poQty) {
        overReceives.push({ poNumber: poFull, sku, shipped: qty, poQty, excess: qty - poQty })
      }
    }

    for (const { sku, qty, lineSeq } of toReceive) {
      dataRows.push([externalId, createdFrom, dateFormatted, containerLabel,
                     sku, lineSeq, qty, 'T', 'China'])
    }

    // Receive = F rows for every other open PO line.
    // Without these, NetSuite auto-receives all remaining open lines when the
    // import runs — causing units from future shipments to be received early.
    const notShipped = [...allPoSkuLines.entries()]
      .filter(([sku]) => !shippedSkus.has(sku))
      .sort(([, a], [, b]) => a - b)

    for (const [sku, lineSeq] of notShipped) {
      dataRows.push([externalId, createdFrom, dateFormatted, containerLabel,
                     sku, lineSeq, 0, 'F', 'China'])
    }
  }

  return {
    csv:          rowsToCSV([headers, ...dataRows]),
    filename:     `Item Receipts - ${containerLabel}.csv`,
    rowCount:     dataRows.length,
    poCount:      Object.keys(poGroups).length,
    overReceives, // non-empty = export should be blocked until discrepancies are resolved
  }
}

// ── Transfer Order (Inventory Transfer) CSV ───────────────────────────────────

// Generates the NetSuite Transfer Order / Inventory Transfer CSV.
// One transfer per PO — moves units from China to the PO's Final Naghedi Destination.
// Must be imported AFTER the Item Receipt CSV.
//
// poLocationMap: { 'PO1688': { location: 'Virtual Warehouse' }, ... }
// Falls back to 'Warehouse' if a PO is not in the map.
export function generateInventoryTransferCSV(container, poLocationMap = {}) {
  const { containerLabel, dateFormatted, poGroups } = aggregateByPO(container)

  const headers = [
    'External ID', 'Memo', 'Date', 'From Location', 'To Location',
    'PO #', 'Style Number', 'Color', 'Item', 'Quantity', 'Purchase Order',
  ]
  const dataRows = []

  for (const poNumber of Object.keys(poGroups).sort()) {
    const poFull     = toPoFull(poNumber)
    const poDigits   = poFull.replace(/^PO/i, '')
    const externalId = `EXT-${containerLabel}${poDigits}`
    const toLocation = lookupLocation(poNumber, poLocationMap)
    const skuTotals  = poGroups[poNumber]

    for (const [sku, qty] of Object.entries(skuTotals)) {
      dataRows.push([
        externalId,
        containerLabel,
        dateFormatted,
        'China',
        toLocation,
        poDigits,
        '',    // Style Number — intentionally empty, NetSuite derives from item
        '',    // Color        — intentionally empty, NetSuite derives from item
        sku,
        qty,
        `Purchase Order #${poFull}`,
      ])
    }
  }

  return {
    csv:      rowsToCSV([headers, ...dataRows]),
    filename: `Inventory Transfer - ${containerLabel}.csv`,
    rowCount: dataRows.length,
    poCount:  Object.keys(poGroups).length,
  }
}

// ── Combined export ────────────────────────────────────────────────────────────

// Generates both files that need to be imported into NetSuite for a container.
// Import order matters: Item Receipt first, Transfer Order second.
export function generateNetSuiteExport(container, poLocationMap = {}, poLineData = {}) {
  return {
    itemReceipt:       generateItemReceiptCSV(container, poLineData),
    inventoryTransfer: generateInventoryTransferCSV(container, poLocationMap),
  }
}

// ── Download helper (browser only) ───────────────────────────────────────────

export function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

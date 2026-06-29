// PO Warehouse View CSV → Airtable POs + PO Lines import.
// Full replace on each import: deletes all existing records then recreates from CSV.
// This is safe because the CSV is always a complete snapshot from NetSuite.

const BASE        = import.meta.env.VITE_CONTAINERS_BASE_ID
const POS_TABLE   = import.meta.env.VITE_POS_TABLE
const LINES_TABLE = import.meta.env.VITE_PO_LINES_TABLE
const TOKEN       = import.meta.env.VITE_CONTAINERS_TOKEN

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
}

async function atFetch(method, tableId, body, params = '') {
  const url = `https://api.airtable.com/v0/${BASE}/${tableId}${params}`
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Airtable ${res.status} ${method} ${tableId}: ${err?.error?.message ?? JSON.stringify(err)}`)
  }
  return res.json()
}

async function fetchAllIds(tableId) {
  const ids = []
  let offset = ''
  do {
    const qs = offset ? `?offset=${offset}` : ''
    const data = await atFetch('GET', tableId, null, qs)
    ids.push(...data.records.map(r => r.id))
    offset = data.offset ?? ''
  } while (offset)
  return ids
}

async function batchDelete(tableId, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    await atFetch('DELETE', tableId, null, `?${chunk.map(id => `records[]=${id}`).join('&')}`)
  }
}

async function batchCreate(tableId, fieldsList) {
  const created = []
  for (let i = 0; i < fieldsList.length; i += 10) {
    const chunk = fieldsList.slice(i, i + 10)
    const data = await atFetch('POST', tableId, { records: chunk.map(f => ({ fields: f })) })
    created.push(...data.records)
  }
  return created
}

// Handles quoted fields and embedded commas
function parseCSVLine(line) {
  const cols = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
      else inQ = !inQ
    } else if (ch === ',' && !inQ) {
      cols.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  cols.push(cur.trim())
  return cols
}

// M/D/YYYY → YYYY-MM-DD  (Airtable ISO date format)
function toISODate(str) {
  if (!str) return null
  const parts = str.split('/')
  if (parts.length !== 3) return null
  const [m, d, y] = parts
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// Map NetSuite status strings to valid Airtable singleSelect choices
function normalizeStatus(status) {
  if (!status) return 'Open'
  if (status.includes('Partially Received')) return 'Partially Received'
  const lower = status.toLowerCase()
  if (lower.includes('fully received') || lower === 'received') return 'Fully Received'
  return 'Open'
}

// ── Parse ─────────────────────────────────────────────────────────────────────

export function parsePOWarehouseViewCsv(csvText) {
  const rows = csvText.trim().split('\n').map(parseCSVLine)
  if (rows.length < 2) return { pos: [], lines: [] }

  // col indices (0-based):
  //  0  PO Internal ID      1  (dup)         2  Document Number (PO Number)
  //  3  Vendor              4  Status         5  Expected Receipt Date
  //  6  Memo (line-level)   7  Ship To        8  Location
  //  9  Final Naghedi Dest  10 Line Seq #     11 Item Internal ID
  // 12  Item SKU            13 Qty Ordered    14 Qty Received
  // 15  Units Left          16 Item Rate

  const poMap = {}  // poInternalId → po object

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.length < 11) continue

    const poInternalId = r[0]?.trim()
    const poNumber     = r[2]?.trim()
    if (!poInternalId || !poNumber) continue

    const vendor    = r[3]?.trim()  || ''
    const status    = r[4]?.trim()  || ''
    const dueDate   = r[5]?.trim()  || ''
    const memo      = r[6]?.trim()  || ''
    const shipTo    = r[7]?.trim()  || ''
    const location  = r[8]?.trim()  || ''
    const finalDest = r[9]?.trim()  || ''
    const lineSeq   = parseInt(r[10]?.trim()) || 0
    const itemId    = r[11]?.trim() || ''
    const itemSku   = r[12]?.trim() || ''
    const qtyOrd    = parseInt(r[13]?.trim())  || 0
    const qtyRec    = parseInt(r[14]?.trim())  || 0
    const unitCost  = parseFloat(r[16]?.trim()) || null

    if (!poMap[poInternalId]) {
      poMap[poInternalId] = {
        internalId: poInternalId,
        poNumber,
        vendor,
        status,
        shipTo,
        location: finalDest || location,
        headerMemo: '',
        lines: [],
      }
    }

    const po = poMap[poInternalId]

    // Row 0 captures PO-level memo (e.g. "FALL BOUTIQUE BUY")
    if (lineSeq === 0 && memo) po.headerMemo = memo

    // Item lines: must have itemSku and a positive lineSeq.
    // itemId (column 11) may be absent in some NetSuite export configurations —
    // we still need the line for lineSeqs/Order Line lookups even without it.
    if (lineSeq > 0 && itemSku) {
      po.lines.push({
        poNumber,
        lineSeq,
        itemInternalId: itemId,  // may be empty string; checked before Airtable push
        sku:        itemSku,
        memo,
        dueDate:    toISODate(dueDate),
        location:   finalDest || location,
        shipTo,
        qtyOrdered: qtyOrd,
        qtyReceived: qtyRec,
        unitCost:   unitCost != null && !isNaN(unitCost) ? unitCost : null,
      })
    }
  }

  const pos = Object.values(poMap)
  return { pos, lines: pos.flatMap(p => p.lines) }
}

// ── PO line data cache (localStorage) ────────────────────────────────────────
// Saves the NetSuite internal IDs and line sequence numbers needed for the
// Item Receipt CSV export. Populated on every PO Warehouse View import.

const PO_LINE_DATA_KEY = 'wh_po_line_data'

// Builds and persists two lookup maps:
//   poInternalIds: { 'PO1705': '123456' }       — for Created From field
//   lineSeqs:      { 'PO1705-SKU': 3 }          — for Order Line field
export function savePOLineDataLocally(pos) {
  const poInternalIds = {}
  const lineSeqs = {}
  // skuBreakdown: { sku: { location: totalQtyOrdered } }  — drives the breakdown shown in the bin panel
  const skuBreakdown = {}
  // poQtys: { 'PO1720-SN03011LD-ECRU': 31 }  — used to catch over-receives before IR export
  const poQtys = {}

  for (const po of pos) {
    const poFull = /^\d+$/.test(po.poNumber) ? `PO${po.poNumber}` : po.poNumber
    poInternalIds[poFull] = po.internalId
    for (const line of po.lines) {
      if (line.sku && line.lineSeq > 0) {
        lineSeqs[`${poFull}-${line.sku}`] = line.lineSeq
        poQtys[`${poFull}-${line.sku}`] = line.qtyOrdered

        const loc = line.location || 'Unknown'
        if (!skuBreakdown[line.sku]) skuBreakdown[line.sku] = {}
        skuBreakdown[line.sku][loc] = (skuBreakdown[line.sku][loc] ?? 0) + line.qtyOrdered
      }
    }
  }
  try { localStorage.setItem(PO_LINE_DATA_KEY, JSON.stringify({ poInternalIds, lineSeqs, skuBreakdown, poQtys })) } catch {}
}

export function loadPOLineData() {
  try {
    return JSON.parse(localStorage.getItem(PO_LINE_DATA_KEY)) ?? { poInternalIds: {}, lineSeqs: {} }
  } catch {
    return { poInternalIds: {}, lineSeqs: {} }
  }
}

// ── Airtable sync ─────────────────────────────────────────────────────────────

// Full replace: wipe POs + Lines tables then recreate from CSV.
// Returns { poCount, lineCount }.
export async function importPOsToAirtable(csvText, onProgress) {
  const { pos, lines } = parsePOWarehouseViewCsv(csvText)
  if (pos.length === 0) throw new Error('No valid POs found in the CSV file.')

  onProgress?.(`Clearing ${POS_TABLE} and ${LINES_TABLE}…`)

  // Delete PO Lines first (they reference PO records)
  const existingLineIds = await fetchAllIds(LINES_TABLE)
  if (existingLineIds.length > 0) await batchDelete(LINES_TABLE, existingLineIds)

  const existingPoIds = await fetchAllIds(POS_TABLE)
  if (existingPoIds.length > 0) await batchDelete(POS_TABLE, existingPoIds)

  onProgress?.(`Creating ${pos.length} PO records…`)

  // Create PO records
  const poFields = pos.map(po => ({
    'PO Number':      po.poNumber,
    'PO Internal ID': po.internalId,
    'Vendor':         po.vendor,
    'Location':       po.location,
    'Status':         normalizeStatus(po.status),
    'Memo':           po.headerMemo,
  }))
  const poRecords = await batchCreate(POS_TABLE, poFields)

  // Build poNumber → Airtable record ID map for linking
  const poIdMap = {}
  poRecords.forEach((rec, i) => { poIdMap[pos[i].poNumber] = rec.id })

  onProgress?.(`Creating ${lines.length} PO line records…`)

  // Create PO Line records linked to their parent PO (skip lines with no item ID)
  const lineFields = lines.filter(line => line.itemInternalId).map(line => {
    const f = {
      'PO + SKU':         `${line.poNumber}-${line.sku}`,
      'Item Internal ID': line.itemInternalId,
      'SKU':              line.sku,
      'Qty Ordered':      line.qtyOrdered,
      'Qty Received':     line.qtyReceived,
      'Location':         line.location,
      'Ship To':          line.shipTo,
      'Memo':             line.memo,
    }
    if (line.dueDate)               f['Due Date']  = line.dueDate
    if (line.unitCost != null)      f['Unit Cost'] = line.unitCost
    const poRecordId = poIdMap[line.poNumber]
    if (poRecordId)                 f['PO']        = [poRecordId]
    return f
  })
  await batchCreate(LINES_TABLE, lineFields)

  return { poCount: pos.length, lineCount: lines.length }
}

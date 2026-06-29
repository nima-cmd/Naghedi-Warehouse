// Packing slip parser — vendor XLSX or CSV → structured container object.
//
// Format auto-detection:
//   Bag format  — one SKU per row (STYLE + COLOR → e.g. SN36223CD-BORDEAUX)
//   Shoe format — size columns present (STYLE + COLOR + SIZE → e.g. NS03090LD-ADOBE-370)
//
// Key behaviors:
//   - Continuation rows (blank CTNS NO.) belong to the same box as the previous carton.
//     A carton may list multiple styles (mixed carton); this is normal, not an issue.
//   - MEAS (box dimensions) is often in a merged cell. We carry forward the last
//     non-empty MEAS value and apply it when each carton is finalized.
//   - PO number (column A, OFFICE.NO.) and customer description (column B, P.O.NO)
//     are read per row and carried forward when blank.
//   - SKU validation against the NetSuite catalog is done separately via
//     validateContainer() so this parser stays pure and testable.

import * as XLSX from 'xlsx'

const CM_TO_IN = 1 / 2.54

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizeColor(s) {
  return (s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// 37 → '370', 36.5 → '365', 40 → '400'
function encodeSize(sizeStr) {
  const n = parseFloat(String(sizeStr).trim())
  if (isNaN(n)) return null
  return String(Math.round(n * 10))
}

// '52×38×51', '52x38x51', '60*40*43' → { dimsCm, dimsIn } or null
function parseDims(raw) {
  if (!raw) return null
  const nums = String(raw).match(/[\d.]+/g)
  if (!nums || nums.length < 3) return null
  const [l, w, h] = nums.slice(0, 3).map(Number)
  if (!l || !w || !h) return null
  return {
    dimsCm: { l, w, h },
    dimsIn: {
      l: Math.ceil(l * CM_TO_IN),
      w: Math.ceil(w * CM_TO_IN),
      h: Math.ceil(h * CM_TO_IN),
    },
  }
}

// '1-18' → [1,2,…,18]    '19' → [19]    '' → []
function expandRange(ctnsStr) {
  const s = String(ctnsStr || '').trim()
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (range) {
    const a = parseInt(range[1]), b = parseInt(range[2])
    if (b >= a && (b - a) < 500) return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  }
  const single = parseInt(s)
  return isNaN(single) ? [] : [single]
}

// Scan the first 25 rows for the column header row
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    for (const cell of rows[i]) {
      const s = String(cell ?? '').toUpperCase().trim()
      if (s.includes('CTNS') || s.includes('CARTON') || s === 'STYLE NO' || s === 'STYLE NO.') return i
    }
  }
  return -1
}

function mapHeaders(row) {
  const m = {}
  for (let i = 0; i < row.length; i++) {
    const h = String(row[i] ?? '').toUpperCase().trim()
    if (!h) continue
    // Column A — order number (OFFICE.NO. / 我司定单号)
    if (h.includes('OFFICE') || h === '我司定单号') {
      m.poNumber = m.poNumber ?? i
    // Column B — customer PO / description (P.O.NO / PO号)
    } else if (h.startsWith('P.O') || h === 'PO号' || h === 'PO NO') {
      m.poDesc = m.poDesc ?? i
    // Carton number or range (CTNS NO.)
    } else if ((h.includes('CTNS') && h.includes('NO')) || (h.includes('CARTON') && h.includes('NO'))) {
      if (!h.includes('TOTAL')) m.cartonNo = m.cartonNo ?? i
    // Style name
    } else if (h.includes('STYLE')) {
      m.styleNo = m.styleNo ?? i
    // Color
    } else if (h.includes('COLOR')) {
      m.color = m.color ?? i
    // Qty per carton (PACK/CTN or QTY/CTN)
    } else if (
      h.startsWith('PACK') ||
      (h.includes('QTY') && (h.includes('CTN') || h.includes('PCS')))
    ) {
      m.qtyPerCtn = m.qtyPerCtn ?? i
    // Box measurements
    } else if (h.includes('MEAS') && !h.includes('TOTAL') && !h.includes('CBM')) {
      m.dims = m.dims ?? i
    } else {
      // Shoe size columns: "35", "36", "36.5", "37" … "42"
      if (/^(3[5-9]|4[0-2])(\.5)?$/.test(h)) m[`size_${h}`] = i
    }
  }
  return m
}

function getSizeCols(colMap) {
  return Object.entries(colMap)
    .filter(([k]) => k.startsWith('size_'))
    .map(([k, i]) => ({ size: k.replace('size_', ''), colIdx: i }))
    .sort((a, b) => parseFloat(a.size) - parseFloat(b.size))
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parsePackingSlip(data, { containerNum, containerDate = null, whCode = 'WH1' } = {}) {
  let rows

  if (typeof data === 'string') {
    // CSV path
    rows = data.split('\n').map(line => line.split(',').map(c => c.trim()))
  } else {
    // XLSX ArrayBuffer path
    const wb    = XLSX.read(data, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
  }

  const headerIdx = findHeaderRow(rows)
  if (headerIdx === -1) throw new Error('Could not find column headers in packing slip. Expected a row with "CTNS NO." or "STYLE NO."')

  const colMap   = mapHeaders(rows[headerIdx])
  const sizeCols = getSizeCols(colMap)
  const isShoe   = sizeCols.length >= 3

  // ── State carried across rows ─────────────────────────────────────────────
  let currentPO       = null  // column A (OFFICE.NO.); carried forward when blank
  let currentCustomer = null  // column B (P.O.NO);     carried forward when blank
  let lastMeas        = null  // MEAS column; carried forward to handle merged cells
  let pendingCarton   = null  // { ctnsRange, po, customer, skuEntries, issues?, multiPOs? }

  const boxes = []

  // Emit box records for a completed carton group.
  // Reads lastMeas from the closure — the MEAS that was current BEFORE this
  // carton's own row updated it, which is correct because:
  //   - The new carton row triggers this finalization
  //   - Then lastMeas is updated from that row
  //   - So the new carton's MEAS applies when it is finalized by the NEXT carton row
  function finalizeCarton(carton) {
    const cartonNums = expandRange(carton.ctnsRange)
    const dims       = parseDims(lastMeas)
    const baseIssues = dims ? [] : ['DIMS_MISSING']
    const allIssues  = [...baseIssues, ...(carton.issues ?? [])]

    for (const cartonNum of cartonNums) {
      const boxNum = String(cartonNum).padStart(3, '0')
      const skus   = carton.skuEntries

      boxes.push({
        id:            `box-${containerNum}-${carton.po ?? 'XX'}-${cartonNum}`,
        cartonId:      `${containerNum}-${carton.po ?? 'XX'}-${boxNum}`,
        binId:         `${whCode}-${containerNum}-${carton.po ?? 'XX'}-${boxNum}`,
        poNumber:      carton.po ?? null,
        poDescription: carton.customer ?? null,
        // single-sku shortcut for simpler downstream display; null for mixed cartons
        sku:           skus.length === 1 ? skus[0].sku : null,
        skus:          [...skus],
        qty:           skus.reduce((s, e) => s + e.qty, 0),
        dimsCm:        dims?.dimsCm ?? null,
        dimsIn:        dims?.dimsIn ?? null,
        issues:        allIssues,
        // Only set for multi-PO cartons: all PO numbers found in this carton
        multiPOs:      carton.multiPOs ?? null,
        skuOverride:   null,
      })
    }
  }

  // ── Row-by-row processing ─────────────────────────────────────────────────
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]

    const poNumCell  = String(row[colMap.poNumber]  ?? '').trim()
    const poDescCell = String(row[colMap.poDesc]    ?? '').trim()
    const cartonCell = String(row[colMap.cartonNo]  ?? '').trim()
    const styleCell  = String(row[colMap.styleNo]   ?? '').trim()
    const colorCell  = String(row[colMap.color]     ?? '').trim()
    const measCell   = String(row[colMap.dims]      ?? '').trim()
    const qtyCell    = String(row[colMap.qtyPerCtn] ?? '').trim()

    // Skip completely blank rows
    if (!cartonCell && !styleCell && !colorCell) continue
    // Stop at totals rows
    if (/^total/i.test(cartonCell) || (/total/i.test(styleCell) && !colorCell)) break
    // Skip repeated header rows
    if (/^ctns?\s*no/i.test(cartonCell) || /^style\s*no/i.test(styleCell)) continue

    // Carry forward PO information
    if (poNumCell)  currentPO       = poNumCell
    if (poDescCell) currentCustomer = poDescCell

    // Build SKU entries from this row
    const normColor = normalizeColor(colorCell)
    const qtyPerCtn = parseInt(qtyCell) || 0
    let rowSkus = []

    if (isShoe) {
      rowSkus = sizeCols
        .map(({ size, colIdx }) => {
          const qty = parseInt(String(row[colIdx] ?? '')) || 0
          if (qty === 0) return null
          const encoded = encodeSize(size)
          return encoded && styleCell ? { sku: `${styleCell}-${normColor}-${encoded}`, qty } : null
        })
        .filter(Boolean)
    } else {
      if (styleCell && normColor) {
        rowSkus = [{ sku: `${styleCell}-${normColor}`, qty: qtyPerCtn }]
      }
    }

    // Detect multi-PO: a new PO number appears on a continuation row (blank carton cell)
    // while a carton is already pending. This means a single physical carton contains items
    // committed to two different POs — tag the SKUs with their source PO so the export
    // generator can route them to the correct Item Receipt.
    if (poNumCell && !cartonCell && pendingCarton && pendingCarton.po !== poNumCell) {
      rowSkus = rowSkus.map(s => ({ ...s, poNumber: poNumCell }))
      pendingCarton.issues = pendingCarton.issues ?? []
      if (!pendingCarton.issues.includes('MULTI_PO')) {
        pendingCarton.issues.push('MULTI_PO')
        pendingCarton.multiPOs = [pendingCarton.po, poNumCell]
      } else if (!pendingCarton.multiPOs.includes(poNumCell)) {
        pendingCarton.multiPOs.push(poNumCell)
      }
    }

    if (cartonCell) {
      if (pendingCarton && pendingCarton.ctnsRange === cartonCell) {
        // Same carton range repeated — vendor didn't use a blank continuation row.
        // Treat identically to a blank carton cell (mixed carton continuation).
        pendingCarton.skuEntries.push(...rowSkus)
      } else {
        // New carton — finalize previous (using lastMeas BEFORE updating below)
        if (pendingCarton) finalizeCarton(pendingCarton)
        pendingCarton = {
          ctnsRange:  cartonCell,
          po:         currentPO,
          customer:   currentCustomer,
          skuEntries: [...rowSkus],
        }
      }
    } else {
      // Blank carton cell = continuation row for the current carton (mixed carton).
      // Append this row's SKUs to the accumulating carton.
      if (pendingCarton) pendingCarton.skuEntries.push(...rowSkus)
    }

    // Update lastMeas AFTER the carton logic above, so the value set here is
    // used when the CURRENT carton is finalized by the NEXT carton's row.
    if (measCell) lastMeas = measCell
  }

  // Finalize the last carton in the file
  if (pendingCarton) finalizeCarton(pendingCarton)

  // Collect unique PO numbers across all boxes (one packing slip can span multiple POs)
  const poNumbers = [...new Set(boxes.map(b => b.poNumber).filter(Boolean))]

  // Date tag makes the container ID unique across multiple imports of the same number
  const dateTag = containerDate ? `-${containerDate.replace(/[^0-9]/g, '')}` : ''

  return {
    id:            `cnt-${containerNum}${dateTag}`,
    containerNum:  String(containerNum),
    containerDate: containerDate ?? null,
    poNumbers,
    importedAt:    new Date().toISOString(),
    boxCount:      boxes.length,
    boxes,
  }
}

// ── Post-parse SKU validation ─────────────────────────────────────────────────
// Run after parsePackingSlip to stamp SKU_NOT_FOUND issues using the NetSuite catalog.
// Returns a new container with updated box issues (does not mutate).
export function validateContainer(container, netsuiteItems) {
  if (!netsuiteItems?.itemsBySku) return container
  const { itemsBySku } = netsuiteItems

  const boxes = container.boxes.map(box => {
    const issues = (box.issues ?? []).filter(i => i !== 'SKU_NOT_FOUND')

    const effectiveSku = box.skuOverride ?? box.sku
    const skuList = effectiveSku
      ? [effectiveSku]
      : (box.skus ?? []).map(e => e.sku)

    if (skuList.length === 0 || skuList.some(s => s && !itemsBySku[s])) {
      issues.push('SKU_NOT_FOUND')
    }

    return { ...box, issues }
  })

  return { ...container, boxes }
}

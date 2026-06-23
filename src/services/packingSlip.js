// Packing slip parser — vendor XLSX or CSV → structured container object.
//
// Two formats are auto-detected:
//   Bag format  — one SKU per carton (STYLE + COLOR → e.g. SN36223CD-BORDEAUX)
//   Shoe format — size columns present (STYLE + COLOR + SIZE → e.g. NS03090LD-ADOBE-370)
//
// SKU validation against the NetSuite items catalog is done separately via
// validateContainer() so the parser itself stays pure and testable.

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

// '52×38×51', '52x38x51', '52 X 38 X 51' → { dimsCm, dimsIn } or null
function parseDims(raw) {
  if (!raw) return null
  const nums = String(raw).match(/[\d.]+/g)
  if (!nums || nums.length < 3) return null
  const [l, w, h] = nums.slice(0, 3).map(Number)
  if (!l || !w || !h) return null
  return {
    dimsCm: { l, w, h },
    dimsIn: {
      l: +(l * CM_TO_IN).toFixed(1),
      w: +(w * CM_TO_IN).toFixed(1),
      h: +(h * CM_TO_IN).toFixed(1),
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
    if ((h.includes('CTNS') || (h.includes('CARTON') && h.includes('NO'))) && !h.includes('TOTAL')) {
      m.cartonNo = m.cartonNo ?? i
    } else if (h.includes('STYLE')) {
      m.styleNo = m.styleNo ?? i
    } else if (h.includes('COLOR')) {
      m.color = m.color ?? i
    } else if (h.includes('QTY') && (h.includes('CTN') || h.includes('CARTON') || h.includes('PCS'))) {
      m.qtyPerCtn = m.qtyPerCtn ?? i
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

export function parsePackingSlip(data, { containerNum, whCode = 'WH1' } = {}) {
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

  // Extract PO number from the metadata rows above the table
  let poNumber = null
  for (let i = 0; i < headerIdx && !poNumber; i++) {
    const row = rows[i]
    for (let j = 0; j < row.length - 1; j++) {
      const label = String(row[j] ?? '').toUpperCase()
      if (label.includes('P.O') || label.includes('PO NO') || label.includes('PO#') || label.includes('ORDER NO')) {
        const val = String(row[j + 1] ?? '').trim()
        if (val && val.length > 2 && !/date|no\.?$/i.test(val)) { poNumber = val; break }
      }
    }
  }

  const boxes = []

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!colMap.cartonNo && !colMap.styleNo) continue

    const cartonCell = String(row[colMap.cartonNo] ?? '').trim()
    const styleCell  = String(row[colMap.styleNo]  ?? '').trim()
    const colorCell  = String(row[colMap.color]    ?? '').trim()

    // Skip blank rows and repeated headers
    if (!cartonCell && !styleCell) continue
    if (/^ctns?\s*no/i.test(cartonCell) || /^style\s*no/i.test(styleCell)) continue
    // Stop at totals row
    if (/total/i.test(cartonCell) || /total/i.test(styleCell)) break

    const cartonNums = expandRange(cartonCell)
    if (cartonNums.length === 0) continue

    const normColor  = normalizeColor(colorCell)
    const dimsData   = parseDims(String(row[colMap.dims] ?? ''))
    const qtyPerCtn  = parseInt(String(row[colMap.qtyPerCtn] ?? '')) || 0
    const baseIssues = dimsData ? [] : ['DIMS_MISSING']

    if (isShoe) {
      for (const cartonNum of cartonNums) {
        const boxNum = String(cartonNum).padStart(3, '0')

        const skus = sizeCols
          .map(({ size, colIdx }) => {
            const qty = parseInt(String(row[colIdx] ?? '')) || 0
            if (qty === 0) return null
            const encoded = encodeSize(size)
            return encoded ? { sku: `${styleCell}-${normColor}-${encoded}`, qty } : null
          })
          .filter(Boolean)

        const issues = [...baseIssues]
        if (skus.length === 0) issues.push('SKU_NOT_FOUND')
        if (skus.length > 1)   issues.push('MULTI_SKU')

        boxes.push({
          id:          `box-${containerNum}-${cartonNum}`,
          cartonId:    `${containerNum}-${boxNum}`,
          binId:       `${whCode}-${containerNum}-${boxNum}`,
          sku:         skus.length === 1 ? skus[0].sku : null,
          skus,
          qty:         skus.reduce((s, e) => s + e.qty, 0) || qtyPerCtn,
          dimsCm:      dimsData?.dimsCm ?? null,
          dimsIn:      dimsData?.dimsIn ?? null,
          issues,
          skuOverride: null,
          styleNo:     styleCell,
          colorNorm:   normColor,
        })
      }
    } else {
      // Bag format
      const sku    = styleCell && normColor ? `${styleCell}-${normColor}` : null
      const issues = [...baseIssues]
      if (!sku) issues.push('SKU_NOT_FOUND')

      for (const cartonNum of cartonNums) {
        const boxNum = String(cartonNum).padStart(3, '0')
        boxes.push({
          id:          `box-${containerNum}-${cartonNum}`,
          cartonId:    `${containerNum}-${boxNum}`,
          binId:       `${whCode}-${containerNum}-${boxNum}`,
          sku,
          skus:        sku ? [{ sku, qty: qtyPerCtn }] : [],
          qty:         qtyPerCtn,
          dimsCm:      dimsData?.dimsCm ?? null,
          dimsIn:      dimsData?.dimsIn ?? null,
          issues:      [...issues],
          skuOverride: null,
          styleNo:     styleCell,
          colorNorm:   normColor,
        })
      }
    }
  }

  return {
    id:          `cnt-${containerNum}`,
    containerNum: String(containerNum),
    poNumber:    poNumber ?? null,
    importedAt:  new Date().toISOString(),
    boxCount:    boxes.length,
    boxes,
  }
}

// ── Post-parse SKU validation ─────────────────────────────────────────────────
// Run after parsePackingSlip to stamp SKU_NOT_FOUND issues using the catalog.
// Returns a new container with updated box issues (does not mutate).
export function validateContainer(container, netsuiteItems) {
  if (!netsuiteItems?.itemsBySku) return container
  const { itemsBySku } = netsuiteItems

  const boxes = container.boxes.map(box => {
    // Strip existing SKU_NOT_FOUND so we can re-evaluate
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

// Container CRUD — localStorage cache + Airtable sync.
//
// Architecture:
//   localStorage = instant reads (always up to date locally)
//   Airtable     = source of truth for multi-device access
//
//   Load:  try Airtable first → update localStorage cache → return
//          if Airtable fails (offline / error) → fall back to localStorage
//   Save:  update localStorage immediately (no UI wait), then sync to Airtable async

const BASE             = import.meta.env.VITE_CONTAINERS_BASE_ID
const CONTAINERS_TABLE = import.meta.env.VITE_CONTAINERS_TABLE
const CARTON_TABLE     = import.meta.env.VITE_CARTON_SKU_TABLE
const CACHE_KEY        = 'wh_containers'

function authHeaders() {
  const token = import.meta.env.VITE_CONTAINERS_TOKEN
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

// ── Low-level Airtable helpers ────────────────────────────────────────────────

async function atFetch(method, tableId, body, params = '') {
  const url = `https://api.airtable.com/v0/${BASE}/${tableId}${params}`
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail = err?.error?.message ?? JSON.stringify(err)
    throw new Error(`Airtable ${res.status} ${method} ${tableId}: ${detail}`)
  }
  return res.json()
}

// Fetch all records from a table, handling Airtable's 100-record page limit
async function fetchAll(tableId, filterFormula = '') {
  const records = []
  let offset = ''
  do {
    const p = new URLSearchParams()
    if (filterFormula) p.set('filterByFormula', filterFormula)
    if (offset) p.set('offset', offset)
    const qs = p.toString() ? `?${p.toString()}` : ''
    const data = await atFetch('GET', tableId, null, qs)
    records.push(...data.records)
    offset = data.offset ?? ''
  } while (offset)
  return records
}

// Create records in batches of 10 (Airtable's limit per request)
async function batchCreate(tableId, fieldsList) {
  const created = []
  for (let i = 0; i < fieldsList.length; i += 10) {
    const chunk = fieldsList.slice(i, i + 10)
    const data = await atFetch('POST', tableId, { records: chunk.map(f => ({ fields: f })) })
    created.push(...data.records)
  }
  return created
}

// Delete records in batches of 10
async function batchDelete(tableId, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    await atFetch('DELETE', tableId, null, `?${chunk.map(id => `records[]=${id}`).join('&')}`)
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// App uses "2026.06.18", Airtable date fields use "2026-06-18"
const toISODate  = d => d?.replace(/\./g, '-') ?? null
const toDotDate  = d => d?.replace(/-/g, '.')  ?? null

// Bin IDs encode the PO number in one of two formats:
//   WH1-39-1688-001  (numeric PO, produced by packingSlip.js)
//   WH1-264-PO1720-001  (PO-prefixed, legacy)
// Returns the raw PO value as stored (e.g. "1688" or "PO1720").
function poFromBinId(binId) {
  if (!binId) return null
  // Legacy PO-prefixed format
  const prefixed = binId.match(/-(PO\d+)-/i)
  if (prefixed) return prefixed[1]
  // Numeric-only format: 4 segments, third is all digits
  const parts = binId.split('-')
  if (parts.length >= 4 && /^\d+$/.test(parts[2])) return parts[2]
  return null
}

// ── Mapping: app ↔ Airtable ───────────────────────────────────────────────────

function containerToFields(c) {
  const name = c.containerDate
    ? `${c.containerNum} - ${c.containerDate}`
    : c.containerNum
  const fields = {
    'Container Name':   name,
    'Container Number': c.containerNum,
    'Status':           c.status ?? 'Pending',
    'Box Count':        c.boxes?.length ?? c.boxCount ?? 0,
    'Total Units':      c.boxes?.reduce((s, b) => s + (b.qty ?? 0), 0) ?? 0,
  }
  const iso = toISODate(c.containerDate)
  if (iso)                  fields['Ship Date']      = iso
  if (c.itemReceiptNum)     fields['Item Receipt']   = c.itemReceiptNum
  if (c.transferOrderNum)   fields['Transfer Order'] = c.transferOrderNum
  return fields
}

// containerMeta carries container-level IR/TO numbers down to each carton row.
function boxToFields(box, containerRecordId, containerMeta = {}) {
  const resolvedSku = box.skuOverride ?? box.sku ?? box.skus?.[0]?.sku ?? ''
  const parts       = resolvedSku.split('-')
  const fields = {
    'Bin ID':       box.binId,
    'Box Number':   parseInt(box.binId?.split('-').pop() ?? '0') || 0,
    'SKU':          resolvedSku,
    'Units':        box.qty ?? 0,
    'Style Number': parts.slice(0, 2).join('-') || '',
    'Color':        parts.slice(2).join('-')    || '',
    'App Issues':   (box.issues ?? []).join(','),
    'Container':    [containerRecordId],
  }
  if (box.dimsCm?.l != null) fields['L cm'] = box.dimsCm.l
  if (box.dimsCm?.w != null) fields['W cm'] = box.dimsCm.w
  if (box.dimsCm?.h != null) fields['H cm'] = box.dimsCm.h
  if (containerMeta.itemReceiptNum)   fields['Item Receipt']   = containerMeta.itemReceiptNum
  if (containerMeta.transferOrderNum) fields['Transfer Order'] = containerMeta.transferOrderNum
  return fields
}

function recordToBox(rec) {
  const sku    = rec.fields['SKU'] ?? null
  const qty    = rec.fields['Units'] ?? 0
  const issues = rec.fields['App Issues']
    ? rec.fields['App Issues'].split(',').filter(Boolean)
    : []
  const binId  = rec.fields['Bin ID'] ?? ''
  const l = rec.fields['L cm'], w = rec.fields['W cm'], h = rec.fields['H cm']
  return {
    id:           rec.id,
    airtableId:   rec.id,
    binId,
    poNumber:     poFromBinId(binId),
    poDescription: null,
    sku,
    skuOverride:  null,
    skus:         sku ? [{ sku, qty }] : [],
    qty,
    dimsCm:       l != null ? { l, w, h } : null,
    dimsIn:       l != null ? {
                    l: Math.ceil(l / 2.54),
                    w: Math.ceil(w / 2.54),
                    h: Math.ceil(h / 2.54),
                  } : null,
    issues,
    fromStaging:  true,
  }
}

function recordToContainer(rec, boxes) {
  const poNumbers = [...new Set(boxes.map(b => b.poNumber).filter(Boolean))]
  return {
    id:               `cnt-at-${rec.id}`,
    airtableId:       rec.id,
    containerNum:     rec.fields['Container Number'] ?? '',
    containerDate:    toDotDate(rec.fields['Ship Date']),
    status:           rec.fields['Status'] ?? 'Pending',
    boxCount:         rec.fields['Box Count'] ?? boxes.length,
    itemReceiptNum:   rec.fields['Item Receipt']   ?? null,
    transferOrderNum: rec.fields['Transfer Order'] ?? null,
    poNumbers,
    importedAt:       new Date().toISOString(),
    boxes,
  }
}

// ── localStorage ──────────────────────────────────────────────────────────────

export function loadContainers() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveContainers(containers) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(containers))
  } catch {}
}

// ── Airtable ──────────────────────────────────────────────────────────────────

// Fetch all containers + their cartons from Airtable.
// On success, also updates the localStorage cache.
export async function loadContainersFromAirtable() {
  const [containerRecs, cartonRecs] = await Promise.all([
    fetchAll(CONTAINERS_TABLE),
    fetchAll(CARTON_TABLE),
  ])

  // Group carton records by their linked Container record ID
  const byContainer = {}
  for (const rec of cartonRecs) {
    for (const cid of (rec.fields['Container'] ?? [])) {
      if (!byContainer[cid]) byContainer[cid] = []
      byContainer[cid].push(recordToBox(rec))
    }
  }

  const containers = containerRecs.map(rec =>
    recordToContainer(rec, byContainer[rec.id] ?? [])
  )

  saveContainers(containers)  // update local cache
  return containers
}

// Upsert a container to Airtable: if a record with the same Container Name already
// exists, update it in place (and replace its carton rows); otherwise create fresh.
// Returns the container with airtableId stamped on it and every box.
export async function saveContainerToAirtable(container) {
  const containerName = container.containerDate
    ? `${container.containerNum} - ${container.containerDate}`
    : container.containerNum

  // ── Check for an existing record by Container Name ────────────────────────
  const formula  = `{Container Name} = "${containerName.replace(/"/g, '\\"')}"`
  const existing = await fetchAll(CONTAINERS_TABLE, formula)
  const meta     = { itemReceiptNum: container.itemReceiptNum, transferOrderNum: container.transferOrderNum }

  let containerRecordId

  if (existing.length > 0) {
    // ── UPDATE existing container record ──────────────────────────────────
    containerRecordId = existing[0].id
    await atFetch('PATCH', CONTAINERS_TABLE, {
      records: [{ id: containerRecordId, fields: containerToFields(container) }],
    })

    // Delete the old carton rows so we can recreate them cleanly
    const oldCartonIds = existing[0].fields['Carton/SKU List'] ?? []
    if (oldCartonIds.length > 0) await batchDelete(CARTON_TABLE, oldCartonIds)
  } else {
    // ── CREATE new container record ────────────────────────────────────────
    const cData = await atFetch('POST', CONTAINERS_TABLE, {
      records: [{ fields: containerToFields(container) }],
    })
    containerRecordId = cData.records[0].id
  }

  // Create carton rows (same path for both create and update)
  const boxFields  = container.boxes.map(box => boxToFields(box, containerRecordId, meta))
  const boxRecords = await batchCreate(CARTON_TABLE, boxFields)

  const updatedBoxes = container.boxes.map((box, i) => ({
    ...box,
    airtableId: boxRecords[i]?.id ?? null,
  }))

  return { ...container, airtableId: containerRecordId, boxes: updatedBoxes }
}

// Delete a container and all its cartons from Airtable.
export async function deleteContainerFromAirtable(container) {
  if (!container.airtableId) return

  const boxIds = container.boxes.map(b => b.airtableId).filter(Boolean)
  if (boxIds.length) await batchDelete(CARTON_TABLE, boxIds)
  await atFetch('DELETE', CONTAINERS_TABLE, null, `/${container.airtableId}`)
}

// Update just the Status field on a container record.
export async function updateContainerStatusInAirtable(container, status) {
  if (!container.airtableId) return
  await atFetch('PATCH', CONTAINERS_TABLE, {
    records: [{ id: container.airtableId, fields: { Status: status } }],
  })
}

// Patch IR/TO on the container record and all its carton rows in Airtable.
// Called immediately when the user edits either field — no full resync needed.
export async function updateContainerIRTOInAirtable(container) {
  if (!container.airtableId) return

  const containerFields = {}
  if (container.itemReceiptNum)     containerFields['Item Receipt']   = container.itemReceiptNum
  if (container.transferOrderNum)   containerFields['Transfer Order'] = container.transferOrderNum
  // Send explicit empty string to clear a field that was previously set
  if (container.itemReceiptNum   === null) containerFields['Item Receipt']   = ''
  if (container.transferOrderNum === null) containerFields['Transfer Order'] = ''

  await atFetch('PATCH', CONTAINERS_TABLE, {
    records: [{ id: container.airtableId, fields: containerFields }],
  })

  // Patch each carton row — batch PATCH (up to 10 per request)
  const boxIds = container.boxes.map(b => b.airtableId).filter(Boolean)
  if (boxIds.length === 0) return

  const cartonFields = {}
  if (container.itemReceiptNum)     cartonFields['Item Receipt']   = container.itemReceiptNum
  if (container.transferOrderNum)   cartonFields['Transfer Order'] = container.transferOrderNum
  if (container.itemReceiptNum   === null) cartonFields['Item Receipt']   = ''
  if (container.transferOrderNum === null) cartonFields['Transfer Order'] = ''

  for (let i = 0; i < boxIds.length; i += 10) {
    const chunk = boxIds.slice(i, i + 10)
    await atFetch('PATCH', CARTON_TABLE, {
      records: chunk.map(id => ({ id, fields: cartonFields })),
    })
  }
}

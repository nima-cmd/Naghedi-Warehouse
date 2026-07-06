// Supabase database service — replaces airtable.js
//
// Data is stored in proper relational tables instead of a single JSON blob:
//   warehouses   — one row per physical warehouse
//   racks        — one row per rack, linked to a warehouse by wh_code
//   bins         — only bins with actual data (SKUs, flags, displaced)
//                  empty bins are regenerated from rack definitions on load
//   bin_skus     — one row per SKU assignment inside a bin
//   sku_catalog  — one row per SKU from the NetSuite CSV import
//   location_qtys — per-location stock quantities per SKU
//   location_names — ordered list of location names from CSV headers
//   app_meta     — key/value table for misc state (counters, rooms, etc.)
//   containers   — staging/receiving container records

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ── Load layout ───────────────────────────────────────────────────────────────
// Reads warehouses, racks, non-empty bins, and app metadata from Supabase.
// Returns { recordId, layout } — same shape App.jsx expects from airtable.js.
// Returns null if no warehouses exist yet (first run).
export async function loadLayout() {
  const [whRes, rackRes, binRes, binSkuRes, metaRes] = await Promise.all([
    supabase.from('warehouses').select('*').order('id'),
    supabase.from('racks').select('*'),
    supabase.from('bins').select('*'),
    supabase.from('bin_skus').select('*'),
    supabase.from('app_meta').select('*'),
  ])

  for (const res of [whRes, rackRes, binRes, binSkuRes, metaRes]) {
    if (res.error) throw new Error(res.error.message)
  }

  if (!whRes.data?.length) return null  // first run — no data yet

  const warehouses = whRes.data.map(wh => ({
    code: wh.code,
    name: wh.name,
    width: wh.width,
    depth: wh.depth,
  }))

  const racks = rackRes.data.map(r => ({
    id: r.id,
    rackId: r.rack_id,
    whIndex: warehouses.findIndex(wh => wh.code === r.wh_code),
    localX: r.local_x,
    localZ: r.local_z,
    cols: r.cols,
    rows: r.rows,
    rotated: r.rotated,
    rowLabel: r.row_label,
  }))

  // Group SKU rows by bin ID so they can be embedded into each bin
  const skusByBin = {}
  for (const s of binSkuRes.data) {
    ;(skusByBin[s.bin_id] ??= []).push({ sku: s.sku, qty: s.qty, location: s.location })
  }

  const bins = binRes.data.map(b => ({
    id: b.id,
    binId: b.bin_id,
    rackId: b.rack_id,
    col: b.col,
    row: b.row,
    flagged: b.flagged,
    flagNote: b.flag_note,
    displaced: b.displaced,
    displacedFrom: b.displaced_from,
    skus: skusByBin[b.id] ?? [],
  }))

  const meta = Object.fromEntries(metaRes.data.map(m => [m.key, m.value]))

  return {
    recordId: 'supabase',
    layout: {
      warehouses,
      racks,
      bins,
      rooms: meta.rooms ?? [],
      rackCounters: meta.rackCounters ?? { 0: 0, 1: 0 },
      catalogUpdatedAt: meta.catalogUpdatedAt ?? null,
      confirmedShortages: meta.confirmedShortages ?? {},
      binsFromRacks: true,  // tells App.jsx to regenerate empty bins from rack definitions
    },
  }
}

// ── Save layout ───────────────────────────────────────────────────────────────
// Writes the current layout to Supabase using upsert (insert-or-update).
// Only non-empty bins are stored — the rest are regenerated from racks on load.
export async function saveLayout(layoutData) {
  const { warehouses, racks, bins, rooms, rackCounters, catalogUpdatedAt, confirmedShortages } = layoutData

  // 1 — Warehouses
  const { error: whErr } = await supabase.from('warehouses').upsert(
    warehouses.map(wh => ({ code: wh.code, name: wh.name, width: wh.width ?? 25, depth: wh.depth ?? 100 })),
    { onConflict: 'code' }
  )
  if (whErr) throw new Error(whErr.message)

  // 2 — Racks
  if (racks.length > 0) {
    const { error: rackErr } = await supabase.from('racks').upsert(
      racks.map(r => ({
        id: r.id,
        rack_id: r.rackId,
        wh_code: warehouses[r.whIndex]?.code ?? 'WH1',
        local_x: r.localX ?? 0,
        local_z: r.localZ ?? 0,
        cols: r.cols,
        rows: r.rows,
        rotated: r.rotated ?? false,
        row_label: r.rowLabel ?? null,
      })),
      { onConflict: 'id' }
    )
    if (rackErr) throw new Error(rackErr.message)
  }

  // 3 — Non-empty bins (have SKUs, flags, or displaced state)
  const nonEmptyBins = (bins ?? []).filter(b =>
    (b.skus?.length > 0) || b.flagged || b.displaced || b.dims
  )

  // 4 & 5 — Sync bins and bin_skus per rack.
  //
  // Why per-rack instead of one big operation:
  // Supabase's REST API passes filters as URL query parameters. Sending 500+
  // bin IDs in a single .in() filter produces a URL that exceeds the server's
  // length limit and returns a 400 Bad Request. By looping over racks (15-20
  // requests of ~30 items each) we stay well within limits.
  //
  // For each rack:
  //   - Delete all existing bin rows for that rack (by rack_id column)
  //   - Delete all existing bin_sku rows for that rack (by LIKE on bin_id prefix)
  //   - Re-insert the non-empty bins and their SKUs
  for (const rack of racks) {
    const { error: binDelErr } = await supabase.from('bins').delete().eq('rack_id', rack.id)
    if (binDelErr) throw new Error(`Bins delete (${rack.id}): ${binDelErr.message}`)

    const { error: skuDelErr } = await supabase.from('bin_skus').delete().like('bin_id', `${rack.id}_%`)
    if (skuDelErr) throw new Error(`Bin SKUs delete (${rack.id}): ${skuDelErr.message}`)

    const rackBins = nonEmptyBins.filter(b => b.rackId === rack.id)
    if (rackBins.length > 0) {
      const { error: binInsErr } = await supabase.from('bins').insert(
        rackBins.map(b => ({
          id: b.id,
          bin_id: b.binId,
          rack_id: b.rackId,
          col: b.col,
          row: b.row,
          flagged: b.flagged ?? false,
          flag_note: b.flagNote ?? null,
          displaced: b.displaced ?? false,
          displaced_from: b.displacedFrom ?? null,
        }))
      )
      if (binInsErr) throw new Error(`Bins insert (${rack.id}): ${binInsErr.message}`)

      const skuRows = rackBins.flatMap(b =>
        (b.skus ?? []).map(s => ({ bin_id: b.id, sku: s.sku, qty: s.qty ?? 0, location: s.location ?? null }))
      )
      if (skuRows.length > 0) {
        const { error: skuInsErr } = await supabase.from('bin_skus').insert(skuRows)
        if (skuInsErr) throw new Error(`Bin SKUs insert (${rack.id}): ${skuInsErr.message}`)
      }
    }
  }

  // 7 — App metadata (rooms, counters, confirmed shortages)
  const { error: metaErr } = await supabase.from('app_meta').upsert([
    { key: 'rooms',              value: rooms ?? [] },
    { key: 'rackCounters',       value: rackCounters ?? {} },
    { key: 'catalogUpdatedAt',   value: catalogUpdatedAt ?? null },
    { key: 'confirmedShortages', value: confirmedShortages ?? {} },
  ], { onConflict: 'key' })
  if (metaErr) throw new Error(metaErr.message)

  return 'supabase'
}

// ── Load catalog ──────────────────────────────────────────────────────────────
// Returns { recordId, skuCatalog, locationBreakdown, locationNames } or null.
export async function loadCatalogData() {
  const [catalogRes, locQtyRes, locNameRes] = await Promise.all([
    supabase.from('sku_catalog').select('*'),
    supabase.from('location_qtys').select('*'),
    supabase.from('location_names').select('*').order('sort_order'),
  ])

  for (const res of [catalogRes, locQtyRes, locNameRes]) {
    if (res.error) throw new Error(res.error.message)
  }

  if (!catalogRes.data?.length) return null

  const skuCatalog = Object.fromEntries(
    catalogRes.data.map(r => [r.sku, { name: r.name, qty: r.total_qty }])
  )

  const locationBreakdown = {}
  for (const r of locQtyRes.data) {
    ;(locationBreakdown[r.sku] ??= {})[r.location_name] = r.qty
  }

  const locationNames = locNameRes.data.map(r => r.name)

  return { recordId: 'supabase', skuCatalog, locationBreakdown, locationNames }
}

// ── Save catalog ──────────────────────────────────────────────────────────────
// Upserts all SKUs and replaces location data so all devices stay in sync.
export async function saveCatalogData(skuCatalog, locationBreakdown, locationNames) {
  // Upsert SKU catalog in batches of 500 (safe limit for a single Supabase request)
  const skuRows = Object.entries(skuCatalog).map(([sku, v]) => ({
    sku,
    name: v.name ?? null,
    total_qty: v.qty ?? 0,
    updated_at: new Date().toISOString(),
  }))

  const BATCH = 500
  for (let i = 0; i < skuRows.length; i += BATCH) {
    const { error } = await supabase.from('sku_catalog')
      .upsert(skuRows.slice(i, i + BATCH), { onConflict: 'sku' })
    if (error) throw new Error(error.message)
  }

  // Replace all location quantity rows
  await supabase.from('location_qtys').delete().not('sku', 'is', null)
  const locRows = Object.entries(locationBreakdown ?? {}).flatMap(([sku, locs]) =>
    Object.entries(locs).map(([location_name, qty]) => ({ sku, location_name, qty }))
  )
  for (let i = 0; i < locRows.length; i += BATCH) {
    const { error } = await supabase.from('location_qtys').insert(locRows.slice(i, i + BATCH))
    if (error) throw new Error(error.message)
  }

  // Replace all location names
  await supabase.from('location_names').delete().not('name', 'is', null)
  if (locationNames?.length) {
    const { error } = await supabase.from('location_names').insert(
      locationNames.map((name, sort_order) => ({ sort_order, name }))
    )
    if (error) throw new Error(error.message)
  }

  return 'supabase'
}

// One-time migration: reads current layout + catalog from Airtable, writes to Supabase.
//
// Run once with:
//   node --env-file=.env.local scripts/migrate-to-supabase.js
//
// Safe to re-run — all writes use upsert (insert or update), so nothing is duplicated.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
)

// ── Airtable helpers ──────────────────────────────────────────────────────────
const AT_API = `https://api.airtable.com/v0/${process.env.VITE_AIRTABLE_BASE_ID}/${process.env.VITE_AIRTABLE_LAYOUT_TABLE}`
const AT_HEADERS = {
  Authorization: `Bearer ${process.env.VITE_AIRTABLE_TOKEN}`,
  'Content-Type': 'application/json',
}

async function fetchAirtableRecord(key) {
  const filter = encodeURIComponent(`{Key}="${key}"`)
  const res = await fetch(`${AT_API}?filterByFormula=${filter}&maxRecords=1`, { headers: AT_HEADERS })
  const data = await res.json()
  if (!data.records?.length) return null
  return JSON.parse(data.records[0].fields.State)
}

// ── Migration ─────────────────────────────────────────────────────────────────
async function migrate() {
  console.log('Reading data from Airtable...')

  const [layout, catalog] = await Promise.all([
    fetchAirtableRecord('layout'),
    fetchAirtableRecord('catalog'),
  ])

  if (!layout) {
    console.log('No layout found in Airtable — nothing to migrate.')
    return
  }

  const racks = layout.racks ?? []
  const bins  = layout.bins  ?? []
  console.log(`Found: ${racks.length} racks, ${bins.length} bins`)
  if (catalog) {
    const skuCount = Object.keys(catalog.skuCatalog ?? {}).length
    console.log(`Found: ${skuCount} SKUs in catalog`)
  }

  // ── Warehouses ──────────────────────────────────────────────────────────────
  const warehouses = (layout.warehouses ?? [
    { code: 'WH1', name: 'Warehouse 1', width: 25, depth: 100 },
    { code: 'WH2', name: 'Warehouse 2', width: 25, depth: 100 },
  ]).map(wh => ({ code: wh.code, name: wh.name, width: wh.width ?? 25, depth: wh.depth ?? 100 }))

  const { error: whErr } = await supabase.from('warehouses')
    .upsert(warehouses, { onConflict: 'code' })
  if (whErr) throw new Error(`Warehouses failed: ${whErr.message}`)
  console.log(`✓ ${warehouses.length} warehouses`)

  // ── Racks ───────────────────────────────────────────────────────────────────
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
    if (rackErr) throw new Error(`Racks failed: ${rackErr.message}`)
    console.log(`✓ ${racks.length} racks`)
  }

  // ── Bins (non-empty only) ───────────────────────────────────────────────────
  const nonEmptyBins = bins.filter(b =>
    (b.skus?.length > 0) || b.flagged || b.displaced || b.dims
  )

  if (nonEmptyBins.length > 0) {
    const { error: binErr } = await supabase.from('bins').upsert(
      nonEmptyBins.map(b => ({
        id: b.id,
        bin_id: b.binId,
        rack_id: b.rackId,
        col: b.col,
        row: b.row,
        flagged: b.flagged ?? false,
        flag_note: b.flagNote ?? null,
        displaced: b.displaced ?? false,
        displaced_from: b.displacedFrom ?? null,
      })),
      { onConflict: 'id' }
    )
    if (binErr) throw new Error(`Bins failed: ${binErr.message}`)

    const allSkuRows = nonEmptyBins.flatMap(b =>
      (b.skus ?? []).map(s => ({
        bin_id: b.id,
        sku: s.sku,
        qty: s.qty ?? 0,
        location: s.location ?? null,
      }))
    )
    if (allSkuRows.length > 0) {
      const { error: skuErr } = await supabase.from('bin_skus').insert(allSkuRows)
      if (skuErr) throw new Error(`Bin SKUs failed: ${skuErr.message}`)
    }
    console.log(`✓ ${nonEmptyBins.length} non-empty bins, ${allSkuRows.length} SKU assignments`)
  } else {
    console.log('✓ No non-empty bins (all bins are currently empty)')
  }

  // ── App metadata ────────────────────────────────────────────────────────────
  const { error: metaErr } = await supabase.from('app_meta').upsert([
    { key: 'rooms',              value: layout.rooms ?? [] },
    { key: 'rackCounters',       value: layout.rackCounters ?? { 0: 0, 1: 0 } },
    { key: 'catalogUpdatedAt',   value: layout.catalogUpdatedAt ?? null },
    { key: 'confirmedShortages', value: layout.confirmedShortages ?? {} },
  ], { onConflict: 'key' })
  if (metaErr) throw new Error(`App meta failed: ${metaErr.message}`)
  console.log('✓ App metadata (rooms, counters, confirmed shortages)')

  // ── SKU catalog ─────────────────────────────────────────────────────────────
  if (catalog?.skuCatalog && Object.keys(catalog.skuCatalog).length > 0) {
    const skuRows = Object.entries(catalog.skuCatalog).map(([sku, v]) => ({
      sku,
      name: v.name ?? null,
      total_qty: v.qty ?? 0,
    }))

    const BATCH = 500
    for (let i = 0; i < skuRows.length; i += BATCH) {
      const { error } = await supabase.from('sku_catalog')
        .upsert(skuRows.slice(i, i + BATCH), { onConflict: 'sku' })
      if (error) throw new Error(`SKU catalog batch ${i}: ${error.message}`)
    }
    console.log(`✓ ${skuRows.length} SKUs in catalog`)

    // Location quantities
    const locRows = Object.entries(catalog.locationBreakdown ?? {}).flatMap(([sku, locs]) =>
      Object.entries(locs).map(([location_name, qty]) => ({ sku, location_name, qty }))
    )
    for (let i = 0; i < locRows.length; i += BATCH) {
      const { error } = await supabase.from('location_qtys')
        .upsert(locRows.slice(i, i + BATCH), { onConflict: 'sku,location_name' })
      if (error) throw new Error(`Location qtys batch ${i}: ${error.message}`)
    }
    console.log(`✓ ${locRows.length} location quantity rows`)

    // Location names
    if (catalog.locationNames?.length) {
      const { error } = await supabase.from('location_names').upsert(
        catalog.locationNames.map((name, sort_order) => ({ sort_order, name })),
        { onConflict: 'sort_order' }
      )
      if (error) throw new Error(`Location names: ${error.message}`)
      console.log(`✓ ${catalog.locationNames.length} location names`)
    }
  } else {
    console.log('No catalog data found in Airtable')
  }

  console.log('\n✅ Migration complete — all data is now in Supabase.')
  console.log('   You can now swap the import in App.jsx and remove Airtable credentials.')
}

migrate().catch(err => {
  console.error('\n❌ Migration failed:', err.message)
  process.exit(1)
})

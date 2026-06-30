import { useState, useEffect, useRef, useMemo } from 'react'
import TopBar from './components/TopBar/TopBar'
import Canvas from './components/Canvas/Canvas'
import ControlPanel from './components/ControlPanel/ControlPanel'
import StagingPanel from './components/Staging/StagingPanel'
import WalkMode from './components/WalkMode/WalkMode'
import { loadLayout, saveLayout } from './services/airtable'
import { parseCatalogCsv, loadCatalog, saveCatalog, saveLocationQtys, loadLocationQtys } from './services/catalog'
import { loadNetsuiteItems, parseNetsuiteItemsCsv, saveNetsuiteItems } from './services/netsuiteItems'
import {
  loadContainers,
  saveContainers,
  loadContainersFromAirtable,
  saveContainerToAirtable,
  deleteContainerFromAirtable,
  updateContainerIRTOInAirtable,
} from './services/containers'
import { importPOsToAirtable, parsePOWarehouseViewCsv, savePOLineDataLocally, loadPOLineData } from './services/poImport'
import { savePOLocationsLocally, loadPOLocations, generateNetSuiteExport, downloadCSV } from './services/exportGenerator'
import './App.css'

// Generate one bin record per rack slot.
// Naming: WH1-R01-A1 = warehouse WH1, rack R01, column A (1st), level 1 (bottom)
// This is the NetSuite-compatible bin naming format used throughout.
function generateBinsForRack(rack) {
  const bins = []
  for (let row = 0; row < rack.rows; row++) {
    for (let col = 0; col < rack.cols; col++) {
      const colLetter = String.fromCharCode(65 + col)  // A, B, C...
      const level = row + 1                             // 1 = bottom, 2, 3...
      bins.push({
        id: `${rack.id}_c${col}_r${row}`,
        binId: `${rack.rackId}-${colLetter}${level}`,
        rackId: rack.id,
        col,
        row,
        skus: [],  // populated in a later step
      })
    }
  }
  return bins
}

function App() {
  const [warehouses, setWarehouses] = useState([
    { code: 'WH1', name: 'Warehouse 1', width: 25, depth: 100 },
    { code: 'WH2', name: 'Warehouse 2', width: 25, depth: 100 },
  ])
  const [racks, setRacks] = useState([])
  const [bins, setBins] = useState([])
  const [placingRack, setPlacingRack] = useState(null)
  const [selectedRackId, setSelectedRackId] = useState(null)
  const [selectedBinId, setSelectedBinId] = useState(null)
  const [rackCounters, setRackCounters] = useState({ 0: 0, 1: 0 })
  const [skus] = useState([])
  const [panelVisible, setPanelVisible] = useState(true)
  const [movingBinId, setMovingBinId] = useState(null)
  const [deletingBinId, setDeletingBinId] = useState(null)

  // Airtable sync state
  // 'idle' | 'loading' | 'saving' | 'saved' | 'error'
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const airtableRecordId = useRef(null)  // Airtable record ID after first load/save
  const initialLoadDone  = useRef(false) // flip true after first load so dirty-tracking ignores the restore
  const [isDirty, setIsDirty] = useState(false)
  // SKU catalog imported from NetSuite CSV — keyed by SKU string → { qty, name }
  const [skuCatalog, setSkuCatalog] = useState({})
  // ISO timestamp of the last catalog import/sync (CSV or future NetSuite API)
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState(null)
  // Pending over-packing warning: { items: [{sku, totalAfter, available}], proceed: fn }
  const [packingWarning, setPackingWarning] = useState(null)
  // SKUs the user has manually confirmed as intentional shortages { [sku]: true }
  const [confirmedShortages, setConfirmedShortages] = useState({})
  // Space reservation placeholders (offices, bathrooms, etc.) on the warehouse floor
  const [rooms, setRooms] = useState([])
  const [selectedRoomId, setSelectedRoomId] = useState(null)
  const [placingRoom, setPlacingRoom] = useState(null)
  // Increment to force Canvas to remount when warehouse physical dimensions change
  const [dimChangeKey, setDimChangeKey] = useState(0)

  // ── Staging module state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab]           = useState('warehouse')  // 'warehouse' | 'staging' | 'walk'
  const [containers, setContainers]         = useState([])
  const [netsuiteItems, setNetsuiteItems]   = useState(null)         // { itemsBySku, styleColorIndex }
  const [netsuiteUpdatedAt, setNetsuiteUpdatedAt] = useState(null)
  const [containerSyncStatus, setContainerSyncStatus] = useState('idle') // 'idle'|'syncing'|'done'|'error'
  const [containerSyncError, setContainerSyncError]   = useState(null)
  const [poImportStatus, setPoImportStatus]           = useState('idle') // 'idle'|'importing'|'done'|'error'
  const [poImportError, setPoImportError]             = useState(null)
  const [poImportResult, setPoImportResult]           = useState(null)   // { poCount, lineCount }
  const [poLocations, setPoLocations]                 = useState(() => loadPOLocations())
  const [poLineData, setPoLineData]                   = useState(() => loadPOLineData())
  // Modal shown when IR export detects shipped qty > PO ordered qty for any SKU
  const [overReceiveWarning, setOverReceiveWarning]   = useState(null) // { items, proceed }
  // Per-location stock breakdown from the Warehouse Item View CSV
  const [locationQtys,  setLocationQtys]  = useState(() => loadLocationQtys().locationBreakdown)
  const [locationNames, setLocationNames] = useState(() => loadLocationQtys().locationNames)

  // ── Load staging data — localStorage immediately, then Airtable in background ─
  useEffect(() => {
    // Show cached data instantly so the panel isn't blank while Airtable loads
    setContainers(loadContainers())
    const ni = loadNetsuiteItems()
    if (ni) { setNetsuiteItems(ni); setNetsuiteUpdatedAt(ni.updatedAt) }

    // Then sync with Airtable
    loadContainersFromAirtable()
      .then(atContainers => {
        if (atContainers.length > 0) {
          // Airtable has data — use it as source of truth
          setContainers(atContainers)
        } else {
          // Airtable is empty — push any locally-cached containers that haven't synced yet
          const local = loadContainers()
          const unsynced = local.filter(c => !c.airtableId)
          for (const c of unsynced) {
            saveContainerToAirtable(c)
              .then(synced => {
                setContainers(prev => {
                  const next = prev.map(p => p.id === c.id ? synced : p)
                  saveContainers(next)
                  return next
                })
              })
              .catch(err => console.warn('Container backfill sync failed:', err.message))
          }
        }
      })
      .catch(err => console.warn('Containers Airtable load failed, using local cache:', err.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load layout from Airtable on mount ────────────────────────────────────
  useEffect(() => {
    setSaveStatus('loading')
    loadLayout()
      .then(result => {
        if (result) {
          airtableRecordId.current = result.recordId
          const { layout } = result
          setWarehouses((layout.warehouses ?? [
            { code: 'WH1', name: 'Warehouse 1', width: 25, depth: 100 },
            { code: 'WH2', name: 'Warehouse 2', width: 25, depth: 100 },
          ]).map(wh => ({ width: 25, depth: 100, ...wh })))  // back-compat: add dims to old saves
          // Force Canvas to remount with the loaded dimensions so the 3D view matches
          setDimChangeKey(k => k + 1)
          setRacks(layout.racks ?? [])
          setBins(layout.bins ?? [])
          setRackCounters(layout.rackCounters ?? { 0: 0, 1: 0 })
          setCatalogUpdatedAt(layout.catalogUpdatedAt ?? null)
          setConfirmedShortages(layout.confirmedShortages ?? {})
          setRooms(layout.rooms ?? [])
          // Load catalog via the catalog service (localStorage cache → Airtable fallback).
          // Also handles backward compat: old saves included skuCatalog in the layout blob.
          loadCatalog().then(result => {
            const src = result ?? (layout.skuCatalog ? { catalog: layout.skuCatalog, updatedAt: layout.catalogUpdatedAt } : null)
            if (src) {
              setSkuCatalog(src.catalog)
              if (src.updatedAt) setCatalogUpdatedAt(src.updatedAt)
            }
          }).catch(() => {})
        }
        setSaveStatus('idle')
      })
      .catch(err => {
        console.warn('Airtable load failed:', err.message)
        setSaveStatus('idle')  // treat as first-run, not a hard error
      })
      .finally(() => {
        // Allow dirty-tracking now that the initial restore is done
        setTimeout(() => { initialLoadDone.current = true }, 0)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Mark dirty whenever racks / bins / warehouse names / rooms change (after initial load)
  useEffect(() => {
    if (initialLoadDone.current) setIsDirty(true)
  }, [racks, bins, warehouses, rooms])

  // On small screens default to Walk tab — the 3D canvas is unusable on a phone
  useEffect(() => {
    if (window.innerWidth < 768) setActiveTab('walk')
  }, [])

  // Assign a stable hex color to each unique Final Naghedi Destination name found in
  // the PO data. Colors come from a fixed 8-slot palette; TBD is always a warning amber.
  // These are passed to both Canvas (3D bin tinting) and ControlPanel (legend + picker).
  const LOCATION_PALETTE = [0xb5783c, 0x27ae60, 0x8e44ad, 0x2980b9, 0xd35400, 0x7f8c8d, 0x1abc9c, 0x6c3483]
  //  index 0: Brown  — Warehouse
  //  index 1: Green  — Virtual Warehouse
  //  index 2: Purple — Bloomingdales
  //  index 3: Blue   — Nordstrom
  //  index 4: Orange — Shopbop
  //  index 5: Grey   — Saint Bernard
  const TBD_LOC_COLOR = 0xb8860b
  const locationColors = useMemo(() => {
    const colors = { TBD: TBD_LOC_COLOR }
    let idx = 0
    for (const loc of locationNames) {
      if (!colors[loc]) { colors[loc] = LOCATION_PALETTE[idx % LOCATION_PALETTE.length]; idx++ }
    }
    return colors
  }, [locationNames]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdateWarehouseName = (index, name) => {
    setWarehouses(prev => prev.map((wh, i) => i === index ? { ...wh, name } : wh))
  }

  const handleUpdateWarehouseDims = (index, dims) => {
    setWarehouses(prev => prev.map((wh, i) => i === index ? { ...wh, ...dims } : wh))
    setDimChangeKey(k => k + 1)  // forces Canvas to remount with the new floor dimensions
    setIsDirty(true)
  }

  const handleStartPlaceRoom = (config) => {
    setSelectedRackId(null)
    setSelectedBinId(null)
    setSelectedRoomId(null)
    setPlacingRoom(config)
  }

  const handleCancelPlaceRoom = () => setPlacingRoom(null)

  const handlePlaceRoom = (whIndex, localX, localZ) => {
    setRooms(prev => [...prev, { id: `room_${Date.now()}`, ...placingRoom, whIndex, localX, localZ }])
    setPlacingRoom(null)
    setIsDirty(true)
  }

  const handleDeleteRoom = (id) => {
    setRooms(prev => prev.filter(r => r.id !== id))
    if (selectedRoomId === id) setSelectedRoomId(null)
    setIsDirty(true)
  }

  const handleSelectRoom = (id) => {
    setSelectedRoomId(id)
    if (id) { setSelectedRackId(null); setSelectedBinId(null) }
  }

  const handleStartPlaceRack = (config) => {
    setSelectedRackId(null)
    setSelectedBinId(null)
    setPlacingRack(config)
  }

  const handleCancelPlace = () => setPlacingRack(null)

  const handleToggleRotation = () => {
    setPlacingRack(prev => prev ? { ...prev, rotated: !prev.rotated } : null)
  }

  const handlePlaceRack = (whIndex, localX, localZ) => {
    if (placingRack.id) {
      // Re-placing an existing rack after Move — preserve name, regenerate bins at same positions
      const rack = { id: placingRack.id, rackId: placingRack.rackId, whIndex, localX, localZ, cols: placingRack.cols, rows: placingRack.rows, rotated: placingRack.rotated || false }
      setRacks(prev => [...prev, rack])
      // Bins already exist for this rack id — no need to regenerate
      setPlacingRack(null)
      return
    }

    const newCount = rackCounters[whIndex] + 1
    const rackId = `${warehouses[whIndex].code}-R${String(newCount).padStart(2, '0')}`
    const newRack = {
      id: `rack_${Date.now()}`,
      rackId,
      whIndex,
      localX,
      localZ,
      cols: placingRack.cols,
      rows: placingRack.rows,
      rotated: placingRack.rotated || false,
    }
    setRacks(prev => [...prev, newRack])
    setBins(prev => [...prev, ...generateBinsForRack(newRack)])
    setRackCounters(prev => ({ ...prev, [whIndex]: newCount }))
    setPlacingRack(null)
  }

  // Selecting a bin clears rack selection, and vice versa
  const handleSelectRack = (id) => {
    setSelectedRackId(id)
    if (id) setSelectedBinId(null)
  }

  const handleSelectBin = (id) => {
    setSelectedBinId(id)
    if (id) setSelectedRackId(null)
  }

  const handleUpdateRack = (id, changes) => {
    const rack = racks.find(r => r.id === id)
    if (!rack) return
    const updated = { ...rack, ...changes }
    setRacks(prev => prev.map(r => r.id === id ? updated : r))
    // If the slot grid changed, preserve existing bins, displace overflow, restore those that fit again
    if ('cols' in changes || 'rows' in changes) {
      setBins(prev => {
        const newCols = updated.cols
        const newRows = updated.rows
        const others         = prev.filter(b => b.rackId !== id && b.displacedFrom !== id)
        const activeBins     = prev.filter(b => b.rackId === id && !b.displaced)
        const prevDisplaced  = prev.filter(b => b.displaced && b.displacedFrom === id)

        // Active bins that still fit — keep as-is
        const fitting = activeBins.filter(b => b.col < newCols && b.row < newRows)

        // Active bins that no longer fit — displace only those with SKU data
        const newlyDisplaced = activeBins
          .filter(b => (b.col >= newCols || b.row >= newRows) && (b.skus ?? []).length > 0)
          .map(b => ({ ...b, rackId: null, displaced: true, displacedFrom: id }))

        // Previously displaced bins from this rack that now fit back in — restore them
        const restored = prevDisplaced
          .filter(b => b.col < newCols && b.row < newRows)
          .map(b => ({ ...b, rackId: id, displaced: false, displacedFrom: null }))

        // Previously displaced bins that still don't fit — leave them displaced
        const stillDisplaced = prevDisplaced.filter(b => b.col >= newCols || b.row >= newRows)

        // Generate new empty bins only for slots not yet occupied
        const taken = new Set([
          ...fitting.map(b => `${b.col}_${b.row}`),
          ...restored.map(b => `${b.col}_${b.row}`),
        ])
        const newBins = []
        for (let row = 0; row < newRows; row++) {
          for (let col = 0; col < newCols; col++) {
            if (!taken.has(`${col}_${row}`)) {
              const colLetter = String.fromCharCode(65 + col)
              newBins.push({
                id: `${id}_c${col}_r${row}`,
                binId: `${updated.rackId}-${colLetter}${row + 1}`,
                rackId: id, col, row, skus: [],
              })
            }
          }
        }

        return [...others, ...fitting, ...restored, ...newlyDisplaced, ...stillDisplaced, ...newBins]
      })
      setSelectedBinId(null)
    }

    // If the rack label (rackId) changed, rewrite every bin's binId to use the new label.
    // binId format: "{rackId}-{colLetter}{level}" e.g. "WH1-R01-A3"
    if ('rackId' in changes) {
      setBins(prev => prev.map(b => {
        if (b.rackId !== id) return b
        const colLetter = String.fromCharCode(65 + b.col)
        return { ...b, binId: `${changes.rackId}-${colLetter}${b.row + 1}` }
      }))
    }
  }

  const handleDeleteRack = (id) => {
    setRacks(prev => prev.filter(r => r.id !== id))
    // Bins with SKU data are displaced to the limbo zone so their contents aren't lost.
    // Completely empty bins are discarded — there's nothing to save.
    setBins(prev => {
      const affected = prev.filter(b => b.rackId === id)
      const others   = prev.filter(b => b.rackId !== id)
      const toDisplace = affected
        .filter(b => (b.skus ?? []).length > 0)
        .map(b => ({ ...b, rackId: null, displaced: true, displacedFrom: id }))
      return [...others, ...toDisplace]
    })
    setSelectedRackId(null)
    setSelectedBinId(null)
  }

  // Create a rack from a text form (Walk Mode) — no 3D canvas click needed.
  // The rack is placed at (0,0) and can be repositioned in the 3D view on desktop later.
  const handleCreateRackManual = (whIndex, rackId, cols, rows) => {
    const newCount = (rackCounters[whIndex] ?? 0) + 1
    const newRack = {
      id: `rack_${Date.now()}`,
      rackId: rackId.trim().toUpperCase(),
      whIndex,
      localX: 0,
      localZ: 0,
      cols,
      rows,
      rotated: false,
    }
    setRacks(prev => [...prev, newRack])
    setBins(prev => [...prev, ...generateBinsForRack(newRack)])
    setRackCounters(prev => ({ ...prev, [whIndex]: newCount }))
    setIsDirty(true)
  }

  const handleMoveRack = (id) => {
    const rack = racks.find(r => r.id === id)
    if (!rack) return
    setRacks(prev => prev.filter(r => r.id !== id))
    setSelectedRackId(null)
    setSelectedBinId(null)
    setPlacingRack({ id: rack.id, rackId: rack.rackId, cols: rack.cols, rows: rack.rows, rotated: rack.rotated || false })
  }

  const handleRemoveBin = (id) => {
    setBins(prev => prev.filter(b => b.id !== id))
    setSelectedBinId(null)
  }

  const handleStartMoveBin = (id) => {
    setMovingBinId(id)
  }

  const handleMoveBin = (binId, targetRackId, targetCol, targetRow) => {
    const targetRack = racks.find(r => r.id === targetRackId)
    if (!targetRack) return
    const sourceBin = bins.find(b => b.id === binId)
    if (!sourceBin) return

    const occupant = bins.find(
      b => b.rackId === targetRackId && b.col === targetCol && b.row === targetRow && b.id !== binId
    )
    const colFor = (col) => String.fromCharCode(65 + col)

    setBins(prev => prev.map(b => {
      if (b.id === binId) {
        return {
          ...b,
          id: `${targetRackId}_c${targetCol}_r${targetRow}`,
          binId: `${targetRack.rackId}-${colFor(targetCol)}${targetRow + 1}`,
          rackId: targetRackId,
          col: targetCol,
          row: targetRow,
          // Always clear displaced state when a bin is successfully assigned to a rack slot
          displaced: false,
          displacedFrom: null,
        }
      }
      if (occupant && b.id === occupant.id) {
        if (sourceBin.displaced) {
          // Source was a displaced bin — displace the occupant to make room (swap into limbo)
          return { ...b, rackId: null, displaced: true, displacedFrom: b.rackId }
        }
        // Normal rack-to-rack swap: occupant takes the source's original slot
        const sourceRack = racks.find(r => r.id === sourceBin.rackId) ?? targetRack
        return {
          ...b,
          id: `${sourceBin.rackId}_c${sourceBin.col}_r${sourceBin.row}`,
          binId: `${sourceRack.rackId}-${colFor(sourceBin.col)}${sourceBin.row + 1}`,
          rackId: sourceBin.rackId,
          col: sourceBin.col,
          row: sourceBin.row,
        }
      }
      return b
    }))
    setMovingBinId(null)
    setSelectedBinId(null)
  }

  const handleCancelMoveBin = () => setMovingBinId(null)

  // Compute total units of a SKU packed across all bins, optionally excluding one specific entry.
  // Used by the over-packing check to get "what would the total be after this action?"
  const totalPackedFor = (sku, excludeBinId = null, excludeSkuId = null) =>
    bins.reduce((sum, b) =>
      sum + (b.skus ?? []).reduce((s2, e) => {
        if (e.sku !== sku) return s2
        if (b.id === excludeBinId && e.id === excludeSkuId) return s2
        return s2 + e.qty
      }, 0)
    , 0)

  // Adds units of a SKU to a bin, tagged with a destination location (defaults to 'TBD').
  // Entries are keyed by (sku, location) — same sku+location merges; different location = new row.
  // If catalog is loaded and adding would exceed total on record, we intercept with a warning.
  const handleAddSku = (binId, sku, qty, location = 'TBD') => {
    const loc = location || 'TBD'
    const doAdd = () => {
      const now = new Date().toISOString()
      setBins(prev => prev.map(b => {
        if (b.id !== binId) return b
        const skus = b.skus ?? []
        // Match on both sku and location so each (sku, destination) pair is its own row
        const existing = skus.find(s => s.sku === sku && (s.location ?? 'TBD') === loc)
        if (existing) {
          return { ...b, updatedAt: now, skus: skus.map(s => s === existing ? { ...s, qty: s.qty + qty } : s) }
        }
        const id = `${binId}_${sku}_${loc}_${Date.now()}`
        return { ...b, updatedAt: now, skus: [...skus, { id, sku, qty, location: loc }] }
      }))
    }

    const catalogTotal = skuCatalog[sku]?.qty
    if (catalogTotal != null) {
      // totalPackedFor already includes the existing qty in this bin (if merging),
      // so we only add the incremental qty — same math whether new entry or merge.
      const totalAfter = totalPackedFor(sku) + qty
      if (totalAfter > catalogTotal) {
        setPackingWarning({ items: [{ sku, totalAfter, available: catalogTotal }], proceed: doAdd })
        return
      }
    }
    doAdd()
  }

  const handleRemoveSku = (binId, skuId) => {
    const now = new Date().toISOString()
    setBins(prev => prev.map(b =>
      b.id === binId ? { ...b, updatedAt: now, skus: (b.skus ?? []).filter(s => s.id !== skuId) } : b
    ))
  }

  // Change the location on an existing SKU entry. If another entry for the same
  // (sku, newLocation) already exists, merge by adding qty and removing this one.
  const handleUpdateSkuLocation = (binId, skuId, newLocation) => {
    const loc = newLocation || 'TBD'
    const now = new Date().toISOString()
    setBins(prev => prev.map(b => {
      if (b.id !== binId) return b
      const skus = b.skus ?? []
      const target = skus.find(s => s.id === skuId)
      if (!target) return b
      // Check if there's already an entry with the same sku + new location
      const existing = skus.find(s => s.id !== skuId && s.sku === target.sku && (s.location ?? 'TBD') === loc)
      if (existing) {
        // Merge: add qty to existing, remove target
        return {
          ...b, updatedAt: now,
          skus: skus
            .filter(s => s.id !== skuId)
            .map(s => s.id === existing.id ? { ...s, qty: s.qty + target.qty } : s),
        }
      }
      return { ...b, updatedAt: now, skus: skus.map(s => s.id === skuId ? { ...s, location: loc } : s) }
    }))
  }

  const handleUpdateSkuQty = (binId, skuId, newQty) => {
    const bin = bins.find(b => b.id === binId)
    const entry = bin?.skus?.find(s => s.id === skuId)
    if (!entry) return

    const doUpdate = () => {
      const now = new Date().toISOString()
      setBins(prev => prev.map(b =>
        b.id === binId
          ? { ...b, updatedAt: now, skus: (b.skus ?? []).map(s => s.id === skuId ? { ...s, qty: newQty } : s) }
          : b
      ))
    }

    const catalogTotal = skuCatalog[entry.sku]?.qty
    if (catalogTotal != null) {
      const totalAfter = totalPackedFor(entry.sku, binId, skuId) + newQty
      if (totalAfter > catalogTotal) {
        setPackingWarning({ items: [{ sku: entry.sku, totalAfter, available: catalogTotal }], proceed: doUpdate })
        return
      }
    }
    doUpdate()
  }

  // Import a NetSuite-exported CSV. Parsing logic lives in catalogService.parseCatalogCsv().
  // When NetSuite API is available, replace this handler with an API fetch that calls
  // saveCatalog() with the same catalog shape — the rest of the app stays unchanged.
  const handleImportCsv = (csvText) => {
    const { catalog, locationBreakdown, locationNames: locNames } = parseCatalogCsv(csvText)
    setSkuCatalog(catalog)
    const ts = saveCatalog(catalog)
    setCatalogUpdatedAt(ts)
    saveLocationQtys(locationBreakdown, locNames)
    setLocationQtys(locationBreakdown)
    setLocationNames(locNames)
    setIsDirty(true)
  }

  const handleUpdateBinDimensions = (binId, dims) => {
    setBins(prev => prev.map(b => b.id === binId ? { ...b, ...dims } : b))
    setIsDirty(true)
  }

  const handleMarkLabelPrinted = (binId) => {
    const now = new Date().toISOString()
    setBins(prev => prev.map(b => b.id === binId ? { ...b, labelPrintedAt: now } : b))
  }

  const handleConfirmShortage = (sku) => {
    setConfirmedShortages(prev => ({ ...prev, [sku]: true }))
    setIsDirty(true)
  }

  const handleUnconfirmShortage = (sku) => {
    setConfirmedShortages(prev => { const n = { ...prev }; delete n[sku]; return n })
    setIsDirty(true)
  }

  const handleRequestDeleteBin = (id) => setDeletingBinId(id)
  const handleConfirmDeleteBin = () => {
    if (deletingBinId) handleRemoveBin(deletingBinId)
    setDeletingBinId(null)
  }
  const handleCancelDeleteBin = () => setDeletingBinId(null)

  // ── Staging handlers ──────────────────────────────────────────────────────
  const handleImportContainer = (parsed) => {
    // Save to localStorage immediately so the UI updates without waiting for Airtable
    setContainers(prev => {
      const next = [...prev.filter(c => c.id !== parsed.id), parsed]
      saveContainers(next)
      return next
    })
    // Sync to Airtable in background — stamp airtableId back once created
    saveContainerToAirtable(parsed)
      .then(synced => {
        setContainers(prev => {
          const next = prev.map(c => c.id === parsed.id ? synced : c)
          saveContainers(next)
          return next
        })
      })
      .catch(err => console.warn('Container Airtable sync failed:', err.message))
  }

  const handleUpdateContainerBox = (containerId, boxId, updates) => {
    setContainers(prev => {
      const next = prev.map(c => {
        if (c.id !== containerId) return c
        return { ...c, boxes: c.boxes.map(b => b.id === boxId ? { ...b, ...updates } : b) }
      })
      saveContainers(next)
      return next
    })
  }

  const handleUpdateContainer = (id, updates) => {
    let syncTarget = null
    setContainers(prev => {
      const next = prev.map(c => {
        if (c.id !== id) return c
        const updated = { ...c, ...updates }
        // Capture for Airtable sync below — done inside setter so we get the merged object
        if (('itemReceiptNum' in updates || 'transferOrderNum' in updates) && updated.airtableId) {
          syncTarget = updated
        }
        return updated
      })
      saveContainers(next)
      return next
    })
    if (syncTarget) {
      updateContainerIRTOInAirtable(syncTarget)
        .catch(err => console.warn('IR/TO sync failed:', err.message))
    }
  }

  const handleDeleteContainer = (id) => {
    const container = containers.find(c => c.id === id)
    setContainers(prev => {
      const next = prev.filter(c => c.id !== id)
      saveContainers(next)
      return next
    })
    if (container) {
      deleteContainerFromAirtable(container)
        .catch(err => console.warn('Container Airtable delete failed:', err.message))
    }
  }

  const handleSyncContainersToAirtable = async () => {
    setContainerSyncStatus('syncing')
    setContainerSyncError(null)
    try {
      let updated = [...containers]
      for (let i = 0; i < updated.length; i++) {
        if (!updated[i].airtableId) {
          const synced = await saveContainerToAirtable(updated[i])
          updated[i] = synced
        }
      }
      setContainers(updated)
      saveContainers(updated)
      setContainerSyncStatus('done')
      setTimeout(() => setContainerSyncStatus('idle'), 3000)
    } catch (err) {
      console.error('Container sync failed:', err)
      setContainerSyncError(err.message)
      setContainerSyncStatus('error')
      setTimeout(() => setContainerSyncStatus('idle'), 8000)
    }
  }

  // Convert a staged container into displaced warehouse bins (one bin per box),
  // remove the container from staging, and switch to the warehouse tab.
  const handleReceiveContainer = (containerId) => {
    const container = containers.find(c => c.id === containerId)
    if (!container) return
    const newBins = container.boxes.map(box => ({
      id:               `staging_${box.id}`,
      binId:            box.binId,
      rackId:           null,
      col:              0,
      row:              0,
      displaced:        true,
      displacedFrom:    'receiving',
      fromStaging:      true,
      skus:             (box.skus ?? []).map(s => ({ id: `${box.id}_${s.sku}`, sku: s.sku, qty: s.qty, location: 'TBD' })),
      poNumber:         box.poNumber          ?? null,
      poDescription:    box.poDescription     ?? null,
      itemReceiptNum:   container.itemReceiptNum   ?? null,
      transferOrderNum: container.transferOrderNum ?? null,
    }))
    setBins(prev => [...prev, ...newBins])
    setIsDirty(true)
    setContainers(prev => {
      const next = prev.filter(c => c.id !== containerId)
      saveContainers(next)
      return next
    })
    setActiveTab('warehouse')
  }

  const handleUpdateBin = (binId, updates) => {
    setBins(prev => prev.map(b => b.id === binId ? { ...b, ...updates } : b))
    setIsDirty(true)
  }

  const handleImportNetsuiteItems = (csvText) => {
    try {
      const { itemsBySku, styleColorIndex } = parseNetsuiteItemsCsv(csvText)
      const ts = saveNetsuiteItems(itemsBySku, styleColorIndex)
      setNetsuiteItems({ itemsBySku, styleColorIndex, updatedAt: ts })
      setNetsuiteUpdatedAt(ts)
    } catch (err) {
      console.warn('NetSuite Items import failed:', err.message)
    }
  }

  const handleImportPOCsv = async (csvText) => {
    setPoImportStatus('importing')
    setPoImportError(null)
    setPoImportResult(null)
    try {
      // Save PO locations locally first (fast, synchronous) so export works offline
      const { pos } = parsePOWarehouseViewCsv(csvText)
      savePOLocationsLocally(pos)
      setPoLocations(loadPOLocations())
      savePOLineDataLocally(pos)
      setPoLineData(loadPOLineData())

      const result = await importPOsToAirtable(csvText, msg => console.info('[PO import]', msg))
      setPoImportResult(result)
      setPoImportStatus('done')
      setTimeout(() => setPoImportStatus('idle'), 6000)
    } catch (err) {
      console.error('PO import failed:', err)
      setPoImportError(err.message)
      setPoImportStatus('error')
      setTimeout(() => setPoImportStatus('idle'), 10000)
    }
  }

  const handleExportInventoryTransfer = (container) => {
    const { itemReceipt, inventoryTransfer } = generateNetSuiteExport(container, poLocations, poLineData)
    // Block the download if any SKU would be received in excess of the PO ordered qty.
    // The user must resolve the packing list discrepancy before importing to NetSuite.
    if (itemReceipt.overReceives?.length > 0) {
      setOverReceiveWarning({
        items: itemReceipt.overReceives,
        proceed: () => {
          downloadCSV(itemReceipt.csv, itemReceipt.filename)
          setTimeout(() => downloadCSV(inventoryTransfer.csv, inventoryTransfer.filename), 300)
        },
      })
      return
    }
    // Item Receipt must be imported into NetSuite first — download it first
    downloadCSV(itemReceipt.csv, itemReceipt.filename)
    // Small delay so the browser doesn't block two simultaneous downloads
    setTimeout(() => downloadCSV(inventoryTransfer.csv, inventoryTransfer.filename), 300)
  }

  // ── Save layout to Airtable ───────────────────────────────────────────────
  const handleSave = async () => {
    setSaveStatus('saving')
    setSaveError(null)
    try {
      // skuCatalog is excluded — it's too large for Airtable's text field.
      // It lives in localStorage and is restored from there on load.
      const layout = { warehouses, racks, bins, rooms, rackCounters, catalogUpdatedAt, confirmedShortages }
      const recordId = await saveLayout(layout, airtableRecordId.current)
      airtableRecordId.current = recordId
      setIsDirty(false)
      setSaveStatus('saved')
      // Reset to idle after 2 s so the button doesn't stay green forever
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveError(err.message)
      setSaveStatus('error')
    }
  }

  const deletingBin = bins.find(b => b.id === deletingBinId)

  return (
    <div id="app">
      <TopBar
        panelVisible={panelVisible}
        onTogglePanel={() => setPanelVisible(!panelVisible)}
        saveStatus={saveStatus}
        saveError={saveError}
        isDirty={isDirty}
        onSave={handleSave}
      />
      {deletingBin && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Remove this bin?</h3>
            <span className="bin-id-badge">{deletingBin.binId}</span>
            <p>The slot will be empty. Any SKU data assigned to this bin will be lost.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={handleCancelDeleteBin}>Cancel</button>
              <button className="btn-danger" onClick={handleConfirmDeleteBin}>Remove Bin</button>
            </div>
          </div>
        </div>
      )}
      {packingWarning && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Over-packing Warning</h3>
            <p>The following would exceed the quantity on record in NetSuite:</p>
            <div className="overpack-list">
              {packingWarning.items.map(item => (
                <div key={item.sku} className="overpack-item">
                  <span className="sku-code">{item.sku}</span>
                  <span className="overpack-detail">
                    {item.totalAfter.toLocaleString()} packed · {item.available.toLocaleString()} on record
                  </span>
                </div>
              ))}
            </div>
            <p>Verify these quantities in NetSuite before proceeding.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setPackingWarning(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => { packingWarning.proceed(); setPackingWarning(null) }}>
                Acknowledge & Proceed
              </button>
            </div>
          </div>
        </div>
      )}
      {overReceiveWarning && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Over-Receive Blocked</h3>
            <p>The following SKUs are packed in quantities that exceed the PO ordered amount. The export has been blocked until the packing list is corrected.</p>
            <div className="overpack-list">
              {overReceiveWarning.items.map(item => (
                <div key={`${item.poNumber}-${item.sku}`} className="overpack-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', width: '100%' }}>
                    <span className="sku-code">{item.sku}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{item.poNumber}</span>
                  </div>
                  <span className="overpack-detail" style={{ color: '#e74c3c' }}>
                    {item.shipped} shipped · {item.poQty} on PO · <strong>+{item.excess} excess</strong>
                  </span>
                </div>
              ))}
            </div>
            <p>Return to the packing list, reduce quantities to match the PO, and re-export.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setOverReceiveWarning(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
      {/* ── Tab bar ── */}
      <div className="tab-bar">
        <button
          className={`tab-btn tab-btn-3d${activeTab === 'warehouse' ? ' active' : ''}`}
          onClick={() => setActiveTab('warehouse')}
        >
          Warehouse 3D
        </button>
        <button
          className={`tab-btn${activeTab === 'staging' ? ' active' : ''}`}
          onClick={() => setActiveTab('staging')}
        >
          Staging
          {containers.length > 0 && (
            <span className="tab-badge">{containers.length}</span>
          )}
        </button>
        <button
          className={`tab-btn${activeTab === 'walk' ? ' active' : ''}`}
          onClick={() => setActiveTab('walk')}
        >
          Walk
        </button>
      </div>

      {/* ── Staging tab ── */}
      {activeTab === 'staging' && (
        <StagingPanel
          containers={containers}
          netsuiteItems={netsuiteItems}
          onImportContainer={handleImportContainer}
          onUpdateContainer={handleUpdateContainer}
          onUpdateBox={handleUpdateContainerBox}
          onDeleteContainer={handleDeleteContainer}
          onReceiveContainer={handleReceiveContainer}
          onSyncToAirtable={handleSyncContainersToAirtable}
          syncStatus={containerSyncStatus}
          syncError={containerSyncError}
          onImportPOCsv={handleImportPOCsv}
          poImportStatus={poImportStatus}
          poImportError={poImportError}
          poImportResult={poImportResult}
          onExportInventoryTransfer={handleExportInventoryTransfer}
          hasPOLocations={Object.keys(poLocations).length > 0}
          poLocations={poLocations}
        />
      )}

      {/* ── Walk tab ── */}
      {activeTab === 'walk' && (
        <WalkMode
          warehouses={warehouses}
          racks={racks}
          bins={bins}
          locationNames={locationNames}
          locationQtys={locationQtys}
          skuCatalog={skuCatalog}
          onSelectBin={handleSelectBin}
          onAddSku={handleAddSku}
          onRemoveSku={handleRemoveSku}
          onUpdateSkuQty={handleUpdateSkuQty}
          onUpdateSkuLocation={handleUpdateSkuLocation}
          onCreateRack={handleCreateRackManual}
        />
      )}

      {/* ── Warehouse 3D tab ── */}
      <div id="main-layout" style={{ display: activeTab === 'warehouse' ? 'flex' : 'none' }}>
        <div id="canvas-container" className="canvas-container">
          <Canvas
            key={dimChangeKey}
            warehouses={warehouses}
            racks={racks}
            bins={bins}
            rooms={rooms}
            selectedRoomId={selectedRoomId}
            placingRoom={placingRoom}
            onPlaceRoom={handlePlaceRoom}
            onSelectRoom={handleSelectRoom}
            placingRack={placingRack}
            selectedRackId={selectedRackId}
            selectedBinId={selectedBinId}
            onPlaceRack={handlePlaceRack}
            onCancelPlace={handleCancelPlace}
            onToggleRotation={handleToggleRotation}
            onSelectRack={handleSelectRack}
            onSelectBin={handleSelectBin}
            onMoveRack={handleMoveRack}
            onUpdateRack={handleUpdateRack}
            movingBinId={movingBinId}
            onMoveBin={handleMoveBin}
            onCancelMoveBin={handleCancelMoveBin}
            onRequestDeleteBin={handleRequestDeleteBin}
            locationColors={locationColors}
          />
        </div>
        <ControlPanel
          visible={panelVisible}
          warehouses={warehouses}
          racks={racks}
          bins={bins}
          skus={skus}
          selectedRackId={selectedRackId}
          selectedBinId={selectedBinId}
          placingRack={placingRack}
          onUpdateWarehouseName={handleUpdateWarehouseName}
          onStartPlaceRack={handleStartPlaceRack}
          onCancelPlace={handleCancelPlace}
          onUpdateRack={handleUpdateRack}
          onDeleteRack={handleDeleteRack}
          onMoveRack={handleMoveRack}
          onSelectRack={handleSelectRack}
          onSelectBin={handleSelectBin}
          movingBinId={movingBinId}
          onStartMoveBin={handleStartMoveBin}
          onMoveBin={handleMoveBin}
          onCancelMoveBin={handleCancelMoveBin}
          onRequestDeleteBin={handleRequestDeleteBin}
          onAddSku={handleAddSku}
          onRemoveSku={handleRemoveSku}
          onUpdateSkuQty={handleUpdateSkuQty}
          onUpdateSkuLocation={handleUpdateSkuLocation}
          onUpdateBin={handleUpdateBin}
          onUpdateBinDimensions={handleUpdateBinDimensions}
          onMarkLabelPrinted={handleMarkLabelPrinted}
          onImportCsv={handleImportCsv}
          onImportNetsuiteItems={handleImportNetsuiteItems}
          netsuiteItemsCount={Object.keys(netsuiteItems?.itemsBySku ?? {}).length}
          netsuiteItemsUpdatedAt={netsuiteUpdatedAt}
          skuCatalog={skuCatalog}
          catalogUpdatedAt={catalogUpdatedAt}
          confirmedShortages={confirmedShortages}
          onConfirmShortage={handleConfirmShortage}
          onUnconfirmShortage={handleUnconfirmShortage}
          onUpdateWarehouseDims={handleUpdateWarehouseDims}
          rooms={rooms}
          selectedRoomId={selectedRoomId}
          placingRoom={placingRoom}
          onStartPlaceRoom={handleStartPlaceRoom}
          onCancelPlaceRoom={handleCancelPlaceRoom}
          onDeleteRoom={handleDeleteRoom}
          onSelectRoom={handleSelectRoom}
          poLineData={poLineData}
          poLocations={poLocations}
          locationColors={locationColors}
          locationQtys={locationQtys}
          locationNames={locationNames}
        />
      </div>

    </div>
  )
}

export default App

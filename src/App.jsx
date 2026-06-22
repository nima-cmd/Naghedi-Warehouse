import { useState, useEffect, useRef } from 'react'
import TopBar from './components/TopBar/TopBar'
import Canvas from './components/Canvas/Canvas'
import ControlPanel from './components/ControlPanel/ControlPanel'
import { loadLayout, saveLayout } from './services/airtable'
import { parseCatalogCsv, loadCatalog, saveCatalog } from './services/catalog'
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
    { code: 'WH1', name: 'Warehouse 1' },
    { code: 'WH2', name: 'Warehouse 2' },
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

  // ── Load layout from Airtable on mount ────────────────────────────────────
  useEffect(() => {
    setSaveStatus('loading')
    loadLayout()
      .then(result => {
        if (result) {
          airtableRecordId.current = result.recordId
          const { layout } = result
          setWarehouses(layout.warehouses ?? [
            { code: 'WH1', name: 'Warehouse 1' },
            { code: 'WH2', name: 'Warehouse 2' },
          ])
          setRacks(layout.racks ?? [])
          setBins(layout.bins ?? [])
          setRackCounters(layout.rackCounters ?? { 0: 0, 1: 0 })
          setCatalogUpdatedAt(layout.catalogUpdatedAt ?? null)
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

  // Mark dirty whenever racks / bins / warehouse names change (after initial load)
  useEffect(() => {
    if (initialLoadDone.current) setIsDirty(true)
  }, [racks, bins, warehouses])

  const handleUpdateWarehouseName = (index, name) => {
    setWarehouses(prev => prev.map((wh, i) => i === index ? { ...wh, name } : wh))
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

  // If the same SKU is added again to the same bin, we merge by adding quantities
  // rather than creating a duplicate entry — one row per SKU keeps the list readable.
  // If catalog is loaded and adding would exceed total on record, we intercept with a warning.
  const handleAddSku = (binId, sku, qty) => {
    const doAdd = () => {
      setBins(prev => prev.map(b => {
        if (b.id !== binId) return b
        const skus = b.skus ?? []
        if (skus.some(s => s.sku === sku)) {
          return { ...b, skus: skus.map(s => s.sku === sku ? { ...s, qty: s.qty + qty } : s) }
        }
        return { ...b, skus: [...skus, { id: `${binId}_${sku}`, sku, qty }] }
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
    setBins(prev => prev.map(b =>
      b.id === binId ? { ...b, skus: (b.skus ?? []).filter(s => s.id !== skuId) } : b
    ))
  }

  const handleUpdateSkuQty = (binId, skuId, newQty) => {
    const bin = bins.find(b => b.id === binId)
    const entry = bin?.skus?.find(s => s.id === skuId)
    if (!entry) return

    const doUpdate = () => {
      setBins(prev => prev.map(b =>
        b.id === binId
          ? { ...b, skus: (b.skus ?? []).map(s => s.id === skuId ? { ...s, qty: newQty } : s) }
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
    const catalog = parseCatalogCsv(csvText)
    setSkuCatalog(catalog)
    const ts = saveCatalog(catalog)
    setCatalogUpdatedAt(ts)
    setIsDirty(true)
  }

  const handleRequestDeleteBin = (id) => setDeletingBinId(id)
  const handleConfirmDeleteBin = () => {
    if (deletingBinId) handleRemoveBin(deletingBinId)
    setDeletingBinId(null)
  }
  const handleCancelDeleteBin = () => setDeletingBinId(null)

  // ── Save layout to Airtable ───────────────────────────────────────────────
  const handleSave = async () => {
    setSaveStatus('saving')
    setSaveError(null)
    try {
      // skuCatalog is excluded — it's too large for Airtable's text field.
      // It lives in localStorage and is restored from there on load.
      const layout = { warehouses, racks, bins, rackCounters, catalogUpdatedAt }
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
      <div id="main-layout">
        <div id="canvas-container" className="canvas-container">
          <Canvas
            warehouses={warehouses}
            racks={racks}
            bins={bins}
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
          onImportCsv={handleImportCsv}
          skuCatalog={skuCatalog}
          catalogUpdatedAt={catalogUpdatedAt}
        />
      </div>
    </div>
  )
}

export default App

import { useState, useEffect, useRef, useMemo } from 'react'
import BarcodeScanner from '../BarcodeScanner/BarcodeScanner'
import BinLabel from '../BinLabel/BinLabel'
import SkuSheet from '../SkuSheet/SkuSheet'

const DEFAULT_FORM = { cols: 5, rows: 6, rotated: false }

const fmtTimestamp = (iso) => {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch { return iso }
}

function ControlPanel({
  visible, warehouses, racks, bins, skus,
  selectedRackId, selectedRackIds = [], selectedBinId, placingRack, placingGroup,
  movingBinId,
  onUpdateWarehouseName,
  onStartPlaceRack, onCancelPlace,
  onUpdateRack, onDeleteRack, onMoveRack,
  onSelectRack, onClearRackGroup, onShiftRackGroup, onMoveRackGroup, onApplyRowLabel, onSelectRowGroup,
  onSelectBin,
  onStartMoveBin, onMoveBin, onCancelMoveBin,
  onRequestDeleteBin,
  onAddSku, onRemoveSku, onUpdateSkuQty, onUpdateSkuLocation,
  onImportCsv, skuCatalog, catalogUpdatedAt,
  onImportNetsuiteItems, netsuiteItemsCount = 0, netsuiteItemsUpdatedAt,
  confirmedShortages, onConfirmShortage, onUnconfirmShortage,
  onUpdateBinDimensions, onMarkLabelPrinted, onUpdateBin,
  onUpdateWarehouseDims,
  rooms = [], selectedRoomId, placingRoom,
  onStartPlaceRoom, onCancelPlaceRoom, onDeleteRoom, onSelectRoom,
  poLineData = {}, poLocations = {}, locationColors = {},
  locationQtys = {}, locationNames = [],
}) {
  const [addingRack, setAddingRack] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)

  // Three views: 'main' = warehouse editor, 'rack' = bin grid for one rack,
  // 'bin' = contents of one bin.
  const [view, setView] = useState('main')
  // Which rack is shown in the rack / bin views (survives selectedRackId being cleared)
  const [panelRackId, setPanelRackId] = useState(null)
  // Where to go back to from bin view: 'rack' or 'main'
  const [binViewSource, setBinViewSource] = useState('main')

  // SKU form local state — lives here because it's only used in the bin view
  const [skuInput,  setSkuInput]  = useState('')
  const [qtyInput,  setQtyInput]  = useState(1)
  const [skuError,  setSkuError]  = useState(null)
  const [scanning,  setScanning]  = useState(false)
  // Tracks in-progress qty edits on existing SKU entries before blur-commit
  const [editingQtys, setEditingQtys] = useState({})
  // Autocomplete dropdown state
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)

  // Editable rack label (rackId) draft — committed on blur / Enter
  const [rackIdDraft, setRackIdDraft] = useState('')
  const [labelBin, setLabelBin] = useState(null)
  const [showSkuSheet, setShowSkuSheet] = useState(false)
  const [groupShift, setGroupShift] = useState({ dx: '0', dz: '0' })
  const [groupRowLabel, setGroupRowLabel] = useState('')
  // Controlled inputs for bin box dimensions (in inches); synced to selected bin on navigation
  const [dimInputs, setDimInputs] = useState({ binW: '24', binD: '16', binH: '17' })
  const [poInputs, setPoInputs]   = useState({ poNumber: '', poDescription: '' })
  // Warehouse dimension editing: pending confirmation { index, newWidth, newDepth }
  const [dimConfirm, setDimConfirm] = useState(null)
  // Per-warehouse dim inputs (width and depth in feet, integers)
  const [whDimInputs, setWhDimInputs] = useState({})
  // Room placement form state
  const [addingRoom, setAddingRoom] = useState(false)
  const [roomForm, setRoomForm] = useState({ name: '', type: 'other', roomW: 5, roomD: 5 })

  // SKU Lookup panel state
  const [lookupInput, setLookupInput] = useState('')
  const [lookupSku, setLookupSku] = useState(null)
  const [lookupSource, setLookupSource] = useState('main') // 'main' | 'unassigned'
  const [lookupBinFilter, setLookupBinFilter] = useState('')
  const [lookupBinId, setLookupBinId] = useState(null)
  const [lookupQty, setLookupQty] = useState(1)
  const [lookupScanning, setLookupScanning] = useState(false)
  const [lookupBinShowSug, setLookupBinShowSug] = useState(false)
  const [lookupAssignError, setLookupAssignError] = useState(null)
  const [lookupShowSuggestions, setLookupShowSuggestions] = useState(false)
  const [lookupActiveSuggestion, setLookupActiveSuggestion] = useState(-1)

  // Reset the SKU form and editing state whenever the user switches to a different bin
  useEffect(() => {
    setSkuInput('')
    setQtyInput(1)
    setSkuError(null)
    setEditingQtys({})
    setShowSuggestions(false)
    setActiveSuggestion(-1)
    const bin = bins.find(b => b.id === selectedBinId)
    const rack = bin ? racks.find(r => r.id === bin.rackId) : null
    setDimInputs({
      binW: String(Math.round((bin?.binW ?? rack?.binW ?? 2)       * 12 * 10) / 10),
      binD: String(Math.round((bin?.binD ?? rack?.binD ?? (4/3))   * 12 * 10) / 10),
      binH: String(Math.round((bin?.binH ?? rack?.binH ?? (17/12)) * 12 * 10) / 10),
    })
    setPoInputs({
      poNumber:      bin?.poNumber      ?? '',
      poDescription: bin?.poDescription ?? '',
    })
  }, [selectedBinId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read a CSV file from disk and hand the raw text to the parent handler
  const handleCsvFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onImportCsv(ev.target.result)
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleItemsFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onImportNetsuiteItems?.(ev.target.result)
    reader.readAsText(file)
    e.target.value = ''
  }

  // Refs so navigation effects can read current values without re-running on every change
  const viewRef        = useRef('main')
  const panelRackIdRef = useRef(null)
  const binsRef        = useRef(bins)

  // Sync refs — MUST be declared BEFORE the navigation effects so they run first
  useEffect(() => { viewRef.current        = view },         [view])
  useEffect(() => { panelRackIdRef.current = panelRackId },  [panelRackId])
  useEffect(() => { binsRef.current        = bins },         [bins])

  // External rack selection (3D label click) → navigate to rack view
  useEffect(() => {
    if (selectedRackId && viewRef.current === 'main') {
      setPanelRackId(selectedRackId)
      setView('rack')
    } else if (!selectedRackId && viewRef.current === 'rack') {
      setView('main')
      setPanelRackId(null)
    }
  }, [selectedRackId])

  // External room selection (3D room click) → navigate to room view
  useEffect(() => {
    if (selectedRoomId && viewRef.current !== 'room') {
      setView('room')
    } else if (!selectedRoomId && viewRef.current === 'room') {
      setView('main')
    }
  }, [selectedRoomId])

  // External bin selection (3D bin click) → navigate to bin view
  useEffect(() => {
    if (selectedBinId && viewRef.current !== 'bin') {
      if (viewRef.current === 'rack') {
        setBinViewSource('rack')
        // panelRackId already points to the rack shown
      } else {
        setBinViewSource('main')
        const bin = binsRef.current.find(b => b.id === selectedBinId)
        if (bin) setPanelRackId(bin.rackId)
      }
      setView('bin')
    }
  }, [selectedBinId])

  // Keep rackIdDraft in sync when navigating to a different rack
  useEffect(() => {
    const rack = racks.find(r => r.id === panelRackId)
    if (rack) setRackIdDraft(rack.rackId)
  }, [panelRackId, racks])

  // Derived values
  const panelRack  = racks.find(r => r.id === panelRackId) ?? null
  const selectedBin = bins.find(b => b.id === selectedBinId) ?? null

  // ── Navigation helpers ────────────────────────────────────────────────────

  const handleBackFromRack = () => {
    setView('main')
    setPanelRackId(null)
    onSelectRack(null)
    onSelectBin(null)
    if (movingBinId) onCancelMoveBin()
  }

  const handleBackFromBin = () => {
    onSelectBin(null)
    if (binViewSource === 'rack' && panelRackId) {
      onSelectRack(panelRackId)
      setView('rack')
    } else {
      setPanelRackId(null)
      setView('main')
    }
  }

  // Rack grid cell clicked (in rack view)
  const handleRackCellClick = (bin, col, row) => {
    if (movingBinId) {
      if (!bin || bin.id !== movingBinId) {
        // Move or swap into this slot (same rack only via panel)
        onMoveBin(movingBinId, panelRackId, col, row)
      }
    } else if (bin) {
      // Navigate to bin view with back → rack view
      setBinViewSource('rack')
      setView('bin')
      onSelectBin(bin.id)
    }
  }

  // "Move / Assign" button in bin view
  const handleMoveBinFromBinView = () => {
    if (!selectedBin) return
    onStartMoveBin(selectedBin.id)
    if (selectedBin.displaced) {
      // Displaced bin has no home rack — go to main view so the user can
      // click an empty slot anywhere in the 3D canvas to assign it
      setView('main')
      onSelectBin(null)
      onSelectRack(null)
    } else {
      setView('rack')
      onSelectBin(null)
      onSelectRack(panelRackId)
    }
  }

  // ── SKU form ──────────────────────────────────────────────────────────────

  const handleAddSkuSubmit = () => {
    const trimmed = skuInput.trim().toUpperCase()
    if (!trimmed) { setSkuError('Enter a SKU code.'); return }
    const qty = Math.max(1, Math.round(Number(qtyInput) || 1))
    onAddSku(selectedBinId, trimmed, qty, skuLocation)
    setSkuInput('')
    setQtyInput(1)
    setSkuError(null)
  }

  // ── SKU autocomplete ─────────────────────────────────────────────────────

  // Recompute whenever the typed query or the loaded catalog changes.
  // Matches both SKU codes and display names; SKU-starts-with results sort first.
  const suggestions = useMemo(() => {
    const query = skuInput.trim().toLowerCase()
    if (!query || Object.keys(skuCatalog ?? {}).length === 0) return []
    return Object.entries(skuCatalog ?? {})
      .filter(([sku, entry]) => {
        const name = (entry?.name ?? '').toLowerCase()
        return sku.toLowerCase().includes(query) || name.includes(query)
      })
      .sort(([a], [b]) => {
        const aStarts = a.toLowerCase().startsWith(query)
        const bStarts = b.toLowerCase().startsWith(query)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.localeCompare(b)
      })
      .slice(0, 8)
      .map(([sku, entry]) => ({ sku, name: entry?.name ?? '' }))
  }, [skuInput, skuCatalog])

  const handleSelectSuggestion = (sku) => {
    setSkuInput(sku)
    setShowSuggestions(false)
    setActiveSuggestion(-1)
    setSkuError(null)
  }

  const handleSuggestionKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setShowSuggestions(true)
      setActiveSuggestion(prev => Math.min(prev + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter') {
      if (activeSuggestion >= 0 && suggestions[activeSuggestion]) {
        e.preventDefault()
        handleSelectSuggestion(suggestions[activeSuggestion].sku)
      } else {
        handleAddSkuSubmit()
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setActiveSuggestion(-1)
    }
  }

  // ── Derived data for new panels ──────────────────────────────────────────

  // All SKUs that have unassigned units (catalog qty > sum of bin assignments)
  const unassignedSkus = useMemo(() => {
    if (Object.keys(skuCatalog ?? {}).length === 0) return []
    return Object.entries(skuCatalog ?? {})
      .map(([sku, entry]) => {
        const totalAssigned = bins.reduce((sum, b) =>
          sum + (b.skus ?? []).filter(s => s.sku === sku).reduce((s2, e) => s2 + e.qty, 0), 0)
        const qty = entry?.qty ?? 0
        return { sku, name: entry?.name ?? '', totalQty: qty, assigned: totalAssigned, unassigned: qty - totalAssigned }
      })
      .filter(item => item.unassigned > 0)
      .sort((a, b) => b.unassigned - a.unassigned)
  }, [skuCatalog, bins])

  // Full breakdown for the currently looked-up SKU
  const lookupData = useMemo(() => {
    if (!lookupSku) return null
    const entry = skuCatalog?.[lookupSku] ?? null
    const binEntries = bins.flatMap(b => {
      const e = (b.skus ?? []).find(s => s.sku === lookupSku)
      if (!e) return []
      const rack = racks.find(r => r.id === b.rackId) ?? null
      return [{ bin: b, rack, qty: e.qty, entryId: e.id }]
    })
    const totalAssigned = binEntries.reduce((sum, item) => sum + item.qty, 0)
    return { entry, bins: binEntries, totalAssigned, unassigned: entry ? (entry.qty ?? 0) - totalAssigned : 0 }
  }, [lookupSku, skuCatalog, bins, racks])

  // Bin ID autocomplete in the lookup "Assign More" form
  const lookupBinSuggestions = useMemo(() => {
    if (!lookupBinFilter.trim() || lookupBinId) return []
    const query = lookupBinFilter.toLowerCase()
    return bins.filter(b => b.binId.toLowerCase().includes(query)).slice(0, 8)
  }, [lookupBinFilter, lookupBinId, bins])

  // Lookup panel SKU autocomplete (same logic as bin view but separate state)
  const lookupSuggestions = useMemo(() => {
    const query = lookupInput.trim().toLowerCase()
    if (!query || Object.keys(skuCatalog ?? {}).length === 0) return []
    return Object.entries(skuCatalog ?? {})
      .filter(([sku, entry]) => {
        const name = (entry?.name ?? '').toLowerCase()
        return sku.toLowerCase().includes(query) || name.includes(query)
      })
      .sort(([a], [b]) => {
        const aStarts = a.toLowerCase().startsWith(query)
        const bStarts = b.toLowerCase().startsWith(query)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.localeCompare(b)
      })
      .slice(0, 8)
      .map(([sku, entry]) => ({ sku, name: entry?.name ?? '' }))
  }, [lookupInput, skuCatalog])

  // Overpacked: assigned > catalog qty (excess shown in red)
  // Underpacked: assigned < catalog qty (shortage, with confirm button)
  const discrepancyData = useMemo(() => {
    if (Object.keys(skuCatalog ?? {}).length === 0) return { overpacked: [], underpacked: [] }
    const overpacked = []
    const underpacked = []
    for (const [sku, entry] of Object.entries(skuCatalog ?? {})) {
      const totalAssigned = bins.reduce((sum, b) =>
        sum + (b.skus ?? []).filter(s => s.sku === sku).reduce((s2, e) => s2 + e.qty, 0), 0)
      const catalogQty = entry?.qty ?? 0
      if (totalAssigned > catalogQty) {
        overpacked.push({ sku, name: entry?.name ?? '', assigned: totalAssigned, catalogQty, excess: totalAssigned - catalogQty })
      } else if (totalAssigned < catalogQty) {
        underpacked.push({ sku, name: entry?.name ?? '', assigned: totalAssigned, catalogQty, shortage: catalogQty - totalAssigned, confirmed: !!confirmedShortages?.[sku] })
      }
    }
    overpacked.sort((a, b) => b.excess - a.excess)
    underpacked.sort((a, b) => a.confirmed !== b.confirmed ? (a.confirmed ? 1 : -1) : b.shortage - a.shortage)
    return { overpacked, underpacked }
  }, [skuCatalog, bins, confirmedShortages])

  // Bins where content was edited more recently than the last printed label
  const labelsNeeded = useMemo(() =>
    bins
      .filter(b => b.updatedAt && (!b.labelPrintedAt || b.updatedAt > b.labelPrintedAt))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  , [bins])

  // Selected location when adding a new SKU entry to a bin (default TBD)
  const [skuLocation, setSkuLocation] = useState('TBD')

  // All warehouse location names: driven by the Quantities CSV header columns when available;
  // falls back to PO data for users who haven't re-imported the Quantities CSV yet.
  const allLocations = useMemo(() => {
    if (locationNames.length > 0) return ['TBD', ...locationNames]
    const locs = new Set()
    for (const locMap of Object.values(poLineData.skuBreakdown ?? {})) {
      for (const loc of Object.keys(locMap)) { if (loc !== 'Unknown') locs.add(loc) }
    }
    return ['TBD', ...Array.from(locs).sort()]
  }, [locationNames, poLineData])

  // Bins that have at least one SKU entry with no assigned location (TBD)
  const noLocationBins = useMemo(() =>
    bins.filter(b => (b.skus ?? []).some(s => !s.location || s.location === 'TBD'))
  , [bins])

  // For each unique SKU in the selected bin: total packed across ALL bins,
  // per-location packed breakdown, and total inventory from locationQtys.
  const binSkuStats = useMemo(() => {
    if (!selectedBin) return {}
    const skuCodes = [...new Set((selectedBin.skus ?? []).map(e => e.sku))]
    const result = {}
    for (const sku of skuCodes) {
      const allEntries = bins.flatMap(b => (b.skus ?? []).filter(s => s.sku === sku))
      const totalPacked = allEntries.reduce((s, e) => s + e.qty, 0)
      const packedByLoc = {}
      for (const e of allEntries) {
        const loc = e.location ?? 'TBD'
        packedByLoc[loc] = (packedByLoc[loc] ?? 0) + e.qty
      }
      const invBreakdown = locationQtys[sku]
      const totalInventory = invBreakdown
        ? Object.values(invBreakdown).reduce((s, n) => s + n, 0)
        : (skuCatalog?.[sku]?.qty ?? null)
      result[sku] = { totalPacked, packedByLoc, totalInventory }
    }
    return result
  }, [selectedBin, bins, locationQtys, skuCatalog]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lookup panel handlers ─────────────────────────────────────────────────

  const handleLookupSearch = (code) => {
    const sku = (code ?? lookupInput).trim().toUpperCase()
    if (!sku) return
    setLookupSku(sku)
    setLookupInput(sku)
    setLookupShowSuggestions(false)
    setLookupBinFilter('')
    setLookupBinId(null)
    setLookupQty(1)
    setLookupAssignError(null)
  }

  const handleLookupAssign = () => {
    if (!lookupBinId || !lookupSku) {
      setLookupAssignError('Select a bin first.')
      return
    }
    const qty = Math.max(1, Math.round(Number(lookupQty) || 1))
    onAddSku(lookupBinId, lookupSku, qty)
    setLookupBinFilter('')
    setLookupBinId(null)
    setLookupQty(1)
    setLookupAssignError(null)
  }

  const openLookupPanel = (sku, source) => {
    if (sku) {
      setLookupSku(sku)
      setLookupInput(sku)
    } else {
      setLookupSku(null)
      setLookupInput('')
    }
    setLookupSource(source)
    setLookupBinFilter('')
    setLookupBinId(null)
    setLookupQty(1)
    setLookupAssignError(null)
    setLookupShowSuggestions(false)
    setView('sku-lookup')
  }

  // ── Rack add form ─────────────────────────────────────────────────────────

  const handleSubmit = (e) => {
    e.preventDefault()
    onStartPlaceRack({ ...form, cols: Number(form.cols), rows: Number(form.rows) })
    setAddingRack(false)
    setForm(DEFAULT_FORM)
  }

  const handleCancelForm = () => {
    setAddingRack(false)
    setForm(DEFAULT_FORM)
  }

  // ── Slot grid builder ─────────────────────────────────────────────────────

  const buildRackCells = () => {
    if (!panelRack) return []
    const binMap = {}
    for (const b of bins) {
      if (b.rackId === panelRack.id) binMap[`${b.col}_${b.row}`] = b
    }
    const cells = []
    // Rows from top (rows-1 = highest level) down to 0 (floor level)
    for (let row = panelRack.rows - 1; row >= 0; row--) {
      for (let col = 0; col < panelRack.cols; col++) {
        cells.push({ col, row, bin: binMap[`${col}_${row}`] ?? null })
      }
    }
    return cells
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <aside className={`panel ${!visible ? 'hidden' : ''}`}>

      {/* ═══════════════════════════════════════════════════════════
          MAIN VIEW — Warehouse Editor
      ═══════════════════════════════════════════════════════════ */}
      {view === 'main' && (
        <>
          <div className="panel-header">
            <h2>Warehouse Editor</h2>
          </div>
          <div className="panel-content">

            <div className="shortcuts-hint">
              <div className="shortcut-row"><kbd>W</kbd> Move selected rack</div>
              <div className="shortcut-row"><kbd>R</kbd> Rotate selected / placing rack</div>
              <div className="shortcut-row"><kbd>F</kbd> Focus camera on rack / bin</div>
              <div className="shortcut-row"><kbd>Del</kbd> Remove selected bin</div>
              <div className="shortcut-row"><kbd>Esc</kbd> Cancel placement</div>
            </div>

            <div className="section-divider" />

            <div className="section-label">Warehouses</div>
            {warehouses.map((wh, i) => {
              const wKey = `${wh.code}_w`
              const dKey = `${wh.code}_d`
              const wVal = whDimInputs[wKey] ?? String(wh.width ?? 25)
              const dVal = whDimInputs[dKey] ?? String(wh.depth ?? 100)
              return (
                <div key={wh.code} style={{ marginBottom: 10 }}>
                  <div className="wh-row">
                    <span className="wh-code">{wh.code}</span>
                    <input
                      className="wh-name-input"
                      type="text"
                      value={wh.name}
                      onChange={e => onUpdateWarehouseName(i, e.target.value)}
                    />
                  </div>
                  <div className="form-row" style={{ marginTop: 4 }}>
                    <div className="form-field" style={{ flex: 1 }}>
                      <label style={{ fontSize: 10 }}>Width (ft)</label>
                      <input
                        type="number" min="5" max="200" step="1" style={{ fontSize: 11 }}
                        value={wVal}
                        onChange={e => setWhDimInputs(p => ({ ...p, [wKey]: e.target.value }))}
                      />
                    </div>
                    <div className="form-field" style={{ flex: 1 }}>
                      <label style={{ fontSize: 10 }}>Depth (ft)</label>
                      <input
                        type="number" min="5" max="500" step="1" style={{ fontSize: 11 }}
                        value={dVal}
                        onChange={e => setWhDimInputs(p => ({ ...p, [dKey]: e.target.value }))}
                      />
                    </div>
                    <div className="form-field" style={{ flex: 'none', alignSelf: 'flex-end' }}>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: 11, padding: '4px 8px', width: 'auto' }}
                        onClick={() => {
                          const newW = Math.max(5, Math.round(Number(wVal) || (wh.width ?? 25)))
                          const newD = Math.max(5, Math.round(Number(dVal) || (wh.depth ?? 100)))
                          setDimConfirm({ index: i, whCode: wh.code, newWidth: newW, newDepth: newD })
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
            <div style={{ height: 8 }} />
            <button
              className="btn-primary panel-nav-btn"
              onClick={() => openLookupPanel(null, 'main')}
            >
              Pack / Count
            </button>
            {unassignedSkus.length > 0 && (
              <>
                <div style={{ height: 6 }} />
                <button
                  className="btn-secondary panel-nav-btn unpack-btn"
                  onClick={() => setView('unassigned')}
                >
                  SKUs to be Packed ({unassignedSkus.length})
                </button>
              </>
            )}
            {(discrepancyData.overpacked.length > 0 || discrepancyData.underpacked.length > 0) && (
              <>
                <div style={{ height: 6 }} />
                <button
                  className="btn-secondary panel-nav-btn"
                  style={discrepancyData.overpacked.length > 0 ? { borderColor: '#c0392b' } : {}}
                  onClick={() => setView('discrepancy')}
                >
                  Inventory Discrepancy ({discrepancyData.overpacked.length + discrepancyData.underpacked.length})
                </button>
              </>
            )}
            {labelsNeeded.length > 0 && (
              <>
                <div style={{ height: 6 }} />
                <button
                  className="btn-secondary panel-nav-btn"
                  onClick={() => setView('labels-needed')}
                >
                  Labels Needed ({labelsNeeded.length})
                </button>
              </>
            )}
            {noLocationBins.length > 0 && (
              <>
                <div style={{ height: 6 }} />
                <button
                  className="btn-secondary panel-nav-btn"
                  style={{ borderColor: '#b8860b', color: '#b8860b' }}
                  onClick={() => setView('no-location')}
                >
                  Bins with no Location ({noLocationBins.length})
                </button>
              </>
            )}

            <div className="section-divider" />

            {/* ── Spaces (room placeholders) ── */}
            <div className="section-label">Spaces</div>
            {rooms.length > 0 && (
              <div className="unassigned-list" style={{ marginBottom: 8 }}>
                {rooms.map(room => (
                  <div
                    key={room.id}
                    className={`unassigned-item${room.id === selectedRoomId ? ' selected' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => { onSelectRoom(room.id); setView('room') }}
                  >
                    <div className="unassigned-item-row">
                      <span className="sku-code" style={{ fontSize: 11 }}>{room.name || '—'}</span>
                      <span className="unassigned-badge" style={{ textTransform: 'capitalize' }}>{room.type}</span>
                    </div>
                    <span className="unassigned-ratio">
                      WH{room.whIndex + 1} · {room.roomW}×{room.roomD} ft
                    </span>
                  </div>
                ))}
              </div>
            )}
            {rooms.length === 0 && <p className="form-hint" style={{ marginBottom: 8 }}>No spaces added yet.</p>}

            {placingRoom && (
              <div className="placing-status" style={{ borderColor: '#1a5cb8', marginBottom: 8 }}>
                <span style={{ color: '#1a5cb8' }}>Placing <strong>{placingRoom.name || placingRoom.type}</strong> — click floor</span>
                <button className="cancel-btn" onClick={onCancelPlaceRoom}>✕</button>
              </div>
            )}

            {!addingRoom && !placingRoom && (
              <button className="btn-secondary" style={{ marginBottom: 4 }} onClick={() => setAddingRoom(true)}>
                + Add Space
              </button>
            )}

            {addingRoom && (
              <div className="rack-form" style={{ marginBottom: 8 }}>
                <div className="form-field" style={{ marginBottom: 6 }}>
                  <label>Name</label>
                  <input
                    className="form-input"
                    type="text"
                    placeholder="e.g. Main Office"
                    value={roomForm.name}
                    onChange={e => setRoomForm(f => ({ ...f, name: e.target.value }))}
                    autoFocus
                  />
                </div>
                <div className="form-field" style={{ marginBottom: 6 }}>
                  <label>Type</label>
                  <select
                    className="form-input"
                    value={roomForm.type}
                    onChange={e => setRoomForm(f => ({ ...f, type: e.target.value }))}
                    style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px', width: '100%', fontSize: 12 }}
                  >
                    <option value="office">Office</option>
                    <option value="bathroom">Bathroom</option>
                    <option value="snack">Snack Room</option>
                    <option value="storage">Storage</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="form-row">
                  <div className="form-field">
                    <label>Width (ft)</label>
                    <input
                      type="number" min="1" max="50" step="1"
                      value={roomForm.roomW}
                      onChange={e => setRoomForm(f => ({ ...f, roomW: Number(e.target.value) || 5 }))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Depth (ft)</label>
                    <input
                      type="number" min="1" max="50" step="1"
                      value={roomForm.roomD}
                      onChange={e => setRoomForm(f => ({ ...f, roomD: Number(e.target.value) || 5 }))}
                    />
                  </div>
                </div>
                <div className="form-actions">
                  <button
                    className="btn-primary"
                    onClick={() => {
                      onStartPlaceRoom({ ...roomForm })
                      setAddingRoom(false)
                      setRoomForm({ name: '', type: 'other', roomW: 5, roomD: 5 })
                    }}
                  >
                    Start Placing →
                  </button>
                  <button className="btn-secondary" onClick={() => setAddingRoom(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="section-divider" />

            {placingRack && (
              <div className="placing-status">
                <span>
                  Placing <strong>{placingRack.rackId ?? 'new rack'}</strong>
                  &nbsp;· press <kbd>R</kbd> to rotate
                </span>
                <button className="cancel-btn" onClick={onCancelPlace}>✕</button>
              </div>
            )}

            {placingGroup && (
              <div className="placing-status" style={{ borderColor: '#36c2d9', color: '#36c2d9' }}>
                <span>
                  Placing group of <strong>{placingGroup.items.length} racks</strong> — click the floor to drop
                </span>
                <button className="cancel-btn" style={{ color: '#36c2d9' }} onClick={onCancelPlace}>✕</button>
              </div>
            )}

            {movingBinId && !placingRack && (() => {
              const mb = bins.find(b => b.id === movingBinId)
              if (!mb?.displaced) return null
              return (
                <div className="placing-status" style={{ borderColor: '#c05218', marginBottom: 8 }}>
                  <span style={{ color: '#c05218' }}>
                    Assigning <strong>{mb.binId}</strong> — click an empty slot in the 3D view
                  </span>
                  <button className="cancel-btn" onClick={onCancelMoveBin}>✕</button>
                </div>
              )
            })()}

            {!addingRack && (
              <button
                className="btn-primary"
                onClick={() => setAddingRack(true)}
                disabled={!!placingRack || !!placingGroup}
              >
                + Add Rack
              </button>
            )}

            {addingRack && (
              <form className="rack-form" onSubmit={handleSubmit}>
                <div className="form-row">
                  <div className="form-field">
                    <label>Cols (wide)</label>
                    <input
                      type="number" min="1" max="30"
                      value={form.cols}
                      onChange={e => setForm(f => ({ ...f, cols: e.target.value }))}
                      autoFocus
                    />
                  </div>
                  <div className="form-field">
                    <label>Rows (high)</label>
                    <input
                      type="number" min="1" max="20"
                      value={form.rows}
                      onChange={e => setForm(f => ({ ...f, rows: e.target.value }))}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className={`toggle-btn ${form.rotated ? 'active' : ''}`}
                  onClick={() => setForm(f => ({ ...f, rotated: !f.rotated }))}
                >
                  ↻ {form.rotated ? 'Rotated 90°' : 'Rotate 90°'}
                </button>
                <p className="form-hint">Default bin: 24 × 16 × 17 in · press R to toggle rotation after placing</p>
                <div className="form-actions">
                  <button type="submit" className="btn-primary">Start Placing →</button>
                  <button type="button" className="btn-secondary" onClick={handleCancelForm}>Cancel</button>
                </div>
              </form>
            )}

            {selectedRackIds.length > 0 && (
              <div className="rack-group-panel">
                <div className="rack-group-header">
                  <span>{selectedRackIds.length} racks selected</span>
                  <button className="walk-link-btn" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }} onClick={onClearRackGroup}>
                    Clear
                  </button>
                </div>
                <p className="form-hint">
                  cmd/ctrl+click a rack's name label to add or remove it from this group.
                </p>

                <button
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 8 }}
                  disabled={selectedRackIds.length < 2 || !!placingRack || !!placingGroup}
                  onClick={onMoveRackGroup}
                >
                  📍 Pick Up Group — click floor to drop
                </button>
                <p className="form-hint" style={{ marginTop: 4 }}>
                  Same gesture as moving one rack — the whole group moves together, spacing preserved. Press <kbd>W</kbd> with the group selected works too.
                </p>

                <div className="section-divider" style={{ margin: '10px 0' }} />

                <p className="form-hint">Or nudge by an exact distance (e.g. a known 3 ft aisle):</p>
                <div className="form-row" style={{ marginTop: 8 }}>
                  <div className="form-field">
                    <label>Shift X (ft)</label>
                    <input type="number" value={groupShift.dx}
                      onChange={e => setGroupShift(s => ({ ...s, dx: e.target.value }))} />
                  </div>
                  <div className="form-field">
                    <label>Shift Z (ft)</label>
                    <input type="number" value={groupShift.dz}
                      onChange={e => setGroupShift(s => ({ ...s, dz: e.target.value }))} />
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', marginTop: 6 }}
                  onClick={() => {
                    onShiftRackGroup(Number(groupShift.dx) || 0, Number(groupShift.dz) || 0)
                    setGroupShift({ dx: '0', dz: '0' })
                  }}
                >
                  Nudge Group
                </button>

                <div className="form-field" style={{ marginTop: 10 }}>
                  <label>Row label</label>
                  <input type="text" placeholder="e.g. Row A" value={groupRowLabel}
                    onChange={e => setGroupRowLabel(e.target.value)} />
                </div>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', marginTop: 6 }}
                  disabled={!groupRowLabel.trim()}
                  onClick={() => onApplyRowLabel(groupRowLabel.trim())}
                >
                  Label Group "{groupRowLabel.trim() || '—'}"
                </button>
              </div>
            )}

            <div className="section-divider" />

            <div className="stat-group">
              <label>Racks placed</label>
              <span className="stat-value">{racks.length}</span>
            </div>
            <div className="stat-group">
              <label>Bins total</label>
              <span className="stat-value">{bins.length}</span>
            </div>
            <div className="stat-group">
              <label>SKUs in catalog</label>
              <span className="stat-value">{Object.keys(skuCatalog ?? {}).length.toLocaleString()}</span>
            </div>
            <div className="section-divider" />
            <div className="section-label">NetSuite Data</div>
            <p className="catalog-timestamp" style={{ marginBottom: 4 }}>
              Quantities CSV{catalogUpdatedAt
                ? `: ${fmtTimestamp(catalogUpdatedAt)}`
                : <span style={{ color: '#5a6a7a' }}> — never imported</span>}
            </p>
            <label className="btn-secondary csv-import-btn">
              {Object.keys(skuCatalog ?? {}).length > 0 ? '↻ Import NetSuite Quantities CSV' : '↑ Import NetSuite Quantities CSV'}
              <input type="file" accept=".csv" hidden onChange={handleCsvFile} />
            </label>
            {Object.keys(skuCatalog ?? {}).length > 0 && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginTop: 8 }}
                onClick={() => setShowSkuSheet(true)}
              >
                🖨 Print SKU Master Sheet
              </button>
            )}
            <p className="catalog-timestamp" style={{ marginTop: 10, marginBottom: 4 }}>
              Items CSV{netsuiteItemsUpdatedAt
                ? `: ${fmtTimestamp(netsuiteItemsUpdatedAt)}`
                : <span style={{ color: '#5a6a7a' }}> — never imported</span>}
              {netsuiteItemsCount > 0 && <span style={{ color: '#27ae60' }}> ({netsuiteItemsCount.toLocaleString()} SKUs)</span>}
            </p>
            <label className="btn-secondary csv-import-btn">
              {netsuiteItemsCount > 0 ? '↻ Import NetSuite Items CSV' : '↑ Import NetSuite Items CSV'}
              <input type="file" accept=".csv" hidden onChange={handleItemsFile} />
            </label>
            {/* Feature 4 — bin color legend */}
            {Object.keys(locationColors).length > 1 && (
              <>
                <div className="section-divider" />
                <div className="section-label">Bin Color Legend</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                  {Object.entries(locationColors).map(([loc, hex]) => {
                    const css = '#' + hex.toString(16).padStart(6, '0')
                    return (
                      <div key={loc} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 14, height: 14, borderRadius: 3, background: css, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ fontSize: 11, color: 'var(--text)' }}>{loc}</span>
                        {loc === 'TBD' && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>— no location assigned</span>}
                      </div>
                    )
                  })}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: '#1a5cb8', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>No PO data</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: '#ffb020', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>Selected</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: '#4499ff', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>Moving</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: '#c0392b', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>Incoming / Displaced</span>
                  </div>
                </div>
              </>
            )}
            <div className="section-divider" />
            <button className="btn-secondary" disabled>Export Layout</button>

          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          RACK VIEW — Bin grid for one rack
      ═══════════════════════════════════════════════════════════ */}
      {view === 'rack' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={handleBackFromRack}>← Warehouse Editor</button>
            </div>
            <div className="rack-view-title-row">
              <div className="rack-view-title">
                {panelRack ? (
                  <input
                    className="rack-id-input"
                    value={rackIdDraft}
                    onChange={e => setRackIdDraft(e.target.value.toUpperCase())}
                    onBlur={() => {
                      const trimmed = rackIdDraft.trim()
                      if (trimmed && trimmed !== panelRack.rackId) {
                        onUpdateRack(panelRack.id, { rackId: trimmed })
                      } else {
                        setRackIdDraft(panelRack.rackId)
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.target.blur()
                      if (e.key === 'Escape') { setRackIdDraft(panelRack.rackId); e.target.blur() }
                    }}
                    spellCheck={false}
                  />
                ) : (
                  <span className="rack-id-badge">—</span>
                )}
                {panelRack && (
                  <span className="rack-view-dims">
                    {panelRack.cols} cols · {panelRack.rows} levels
                    {panelRack.rotated ? ' · rotated' : ''}
                    {panelRack.row ? ` · ${panelRack.row}` : ''}
                  </span>
                )}
              </div>
              {panelRack && (
                <div className="rack-view-actions">
                  <button className="btn-secondary rack-action-btn" onClick={() => onMoveRack(panelRack.id)}>
                    ↑ Move
                  </button>
                  <button className="icon-btn danger" title="Delete rack" onClick={() => onDeleteRack(panelRack.id)}>
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="panel-content">
            {panelRack && (
              <div className="form-row" style={{ marginBottom: 10 }}>
                <div className="form-field">
                  <label>Cols</label>
                  <input type="number" min="1" max="30"
                    value={panelRack.cols}
                    onChange={e => onUpdateRack(panelRack.id, { cols: Number(e.target.value) })} />
                </div>
                <div className="form-field">
                  <label>Levels</label>
                  <input type="number" min="1" max="20"
                    value={panelRack.rows}
                    onChange={e => onUpdateRack(panelRack.id, { rows: Number(e.target.value) })} />
                </div>
              </div>
            )}
            {panelRack && (
              <button
                className={`toggle-btn ${panelRack.rotated ? 'active' : ''}`}
                style={{ marginBottom: 12 }}
                onClick={() => onUpdateRack(panelRack.id, { rotated: !panelRack.rotated })}
              >
                ↻ {panelRack.rotated ? 'Rotated 90°' : 'Rotate 90°'}
              </button>
            )}

            {panelRack?.row && (
              <button
                className="btn-secondary"
                style={{ width: '100%', marginBottom: 12 }}
                onClick={() => onSelectRowGroup(panelRack.row)}
              >
                Select all in "{panelRack.row}"
              </button>
            )}

            <div className="section-divider" />

            {/* Move-mode status */}
            {movingBinId && (
              <div className="placing-status" style={{ marginBottom: 10 }}>
                <span>Click a slot below or in the 3D view</span>
                <button className="cancel-btn" onClick={onCancelMoveBin}>✕</button>
              </div>
            )}

            {/* Selected bin actions (shown when a bin is selected and not in move mode) */}
            {selectedBin && !movingBinId && (
              <div className="selected-bin-panel" style={{ marginBottom: 12 }}>
                <div className="selected-rack-header">
                  <span className="bin-id-badge">{selectedBin.binId}</span>
                  <button className="icon-btn" onClick={() => onSelectBin(null)}>✕</button>
                </div>
                <div className="bin-meta">
                  <span>Position</span>
                  <span className="stat-value">
                    Col {String.fromCharCode(65 + selectedBin.col)} · Level {selectedBin.row + 1}
                  </span>
                </div>
                <div className="rack-actions" style={{ marginTop: 6 }}>
                  <button className="btn-secondary" onClick={() => onStartMoveBin(selectedBin.id)}>
                    ↑ Move Bin
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ borderColor: '#c0392b', color: '#c0392b' }}
                    onClick={() => onRequestDeleteBin(selectedBin.id)}
                  >
                    Remove Bin
                  </button>
                </div>
              </div>
            )}

            {/* Slot grid */}
            {panelRack && (
              <>
                <div className="section-label">
                  Slots — top = level {panelRack.rows}
                </div>
                <div
                  className="bin-grid"
                  style={{ gridTemplateColumns: `repeat(${panelRack.cols}, minmax(26px, 1fr))` }}
                >
                  {buildRackCells().map(({ col, row, bin }) => {
                    const isSelected   = bin && bin.id === selectedBinId
                    const isMovingBin  = bin && bin.id === movingBinId
                    const isMoveTarget = !bin && !!movingBinId
                    const isSwapTarget = bin && !isMovingBin && !!movingBinId
                    return (
                      <div
                        key={`${col}_${row}`}
                        className={[
                          'bin-cell',
                          isSelected   ? 'selected'     : '',
                          !bin         ? 'empty'         : '',
                          isMovingBin  ? 'moving'        : '',
                          isMoveTarget ? 'move-target'   : '',
                          isSwapTarget ? 'swap-target'   : '',
                        ].join(' ').trim()}
                        onClick={() => handleRackCellClick(bin, col, row)}
                        title={bin ? bin.binId : `Empty — ${String.fromCharCode(65 + col)}${row + 1}`}
                      >
                        {bin
                          ? <span>{String.fromCharCode(65 + col)}{row + 1}</span>
                          : <span className="empty-slot-label">·</span>
                        }
                      </div>
                    )
                  })}
                </div>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  {bins.filter(b => b.rackId === panelRack.id).length} / {panelRack.cols * panelRack.rows} slots filled
                </p>
              </>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          BIN VIEW — Contents of one bin
      ═══════════════════════════════════════════════════════════ */}
      {view === 'bin' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={handleBackFromBin}>
                {binViewSource === 'rack' ? `← ${panelRack?.rackId ?? 'Rack'}` : '← Warehouse Editor'}
              </button>
            </div>
            <div className="rack-view-title-row">
              <div className="rack-view-title">
                <span className="bin-id-badge" style={{ fontSize: 14 }}>
                  {selectedBin?.binId ?? '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="panel-content">

            {/* Move-mode status */}
            {movingBinId && (
              <div className="placing-status" style={{ marginBottom: 12 }}>
                <span>Click an empty slot in the 3D view</span>
                <button className="cancel-btn" onClick={onCancelMoveBin}>✕</button>
              </div>
            )}

            {selectedBin && (
              <>
                <div className="section-label">Location</div>
                {selectedBin.displaced ? (
                  <div style={{
                    background: 'rgba(192,82,24,.12)', border: '1px solid #c05218',
                    borderRadius: 4, padding: '7px 10px', marginBottom: 10,
                  }}>
                    <div style={{ color: '#c05218', fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                      Displaced — not in a rack
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      Use "Assign to Rack" below to place this bin in an empty slot.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="stat-group">
                      <label>Rack</label>
                      <span className="stat-value" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {panelRack?.rackId ?? '—'}
                      </span>
                    </div>
                    <div className="stat-group">
                      <label>Column</label>
                      <span className="stat-value">{String.fromCharCode(65 + selectedBin.col)}</span>
                    </div>
                    <div className="stat-group">
                      <label>Level</label>
                      <span className="stat-value">{selectedBin.row + 1}</span>
                    </div>
                  </>
                )}

                <div className="section-divider" />

                {/* PO Info — shown and editable for bins received from staging */}
                {(selectedBin.poNumber || selectedBin.poDescription || selectedBin.fromStaging) && (
                  <>
                    <div className="section-label">PO Info</div>
                    {/* Feature 2 — Final Naghedi Destination from imported PO data */}
                    {selectedBin.poNumber && poLocations[selectedBin.poNumber]?.location && (
                      <div className="stat-group" style={{ marginBottom: 6 }}>
                        <label>Destination</label>
                        <span className="stat-value" style={{ color: '#27ae60', fontWeight: 600 }}>
                          {poLocations[selectedBin.poNumber].location}
                        </span>
                      </div>
                    )}
                    {[
                      { key: 'poNumber',      label: 'PO Number' },
                      { key: 'poDescription', label: 'Order' },
                    ].map(({ key, label }) => (
                      <div key={key} className="stat-group" style={{ alignItems: 'flex-start', gap: 4 }}>
                        <label>{label}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                          <input
                            className="form-input"
                            style={{ fontSize: 11, flex: 1, minWidth: 0, padding: '3px 7px' }}
                            value={poInputs[key]}
                            onChange={e => setPoInputs(p => ({ ...p, [key]: e.target.value }))}
                            onBlur={() => onUpdateBin?.(selectedBin.id, { [key]: poInputs[key].trim() || null })}
                            onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                            placeholder="—"
                          />
                          {selectedBin[key] && (
                            <button
                              className="icon-btn"
                              style={{ fontSize: 10, padding: '2px 5px', flexShrink: 0 }}
                              title={`Clear ${label}`}
                              onClick={() => {
                                setPoInputs(p => ({ ...p, [key]: '' }))
                                onUpdateBin?.(selectedBin.id, { [key]: null })
                              }}
                            >✕</button>
                          )}
                        </div>
                      </div>
                    ))}
                    <div className="section-divider" />
                  </>
                )}

                <div className="section-label">Box Dimensions</div>
                <div className="form-row" style={{ marginBottom: 4 }}>
                  {[
                    { key: 'binW', label: 'W (in)', def: 2 },
                    { key: 'binD', label: 'D (in)', def: 4 / 3 },
                    { key: 'binH', label: 'H (in)', def: 17 / 12 },
                  ].map(({ key, label, def }) => {
                    const isOverridden = selectedBin[key] != null
                    return (
                      <div key={key} className="form-field" style={{ flex: 1 }}>
                        <label style={{ fontSize: 10 }}>{label}</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          style={{ fontSize: 11, color: isOverridden ? 'var(--text)' : 'var(--text-dim)' }}
                          value={dimInputs[key] ?? ''}
                          onChange={e => setDimInputs(prev => ({ ...prev, [key]: e.target.value }))}
                          onBlur={() => {
                            const inches = parseFloat(dimInputs[key])
                            if (!isNaN(inches) && inches > 0)
                              onUpdateBinDimensions(selectedBin.id, { [key]: inches / 12 })
                          }}
                          onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                        />
                      </div>
                    )
                  })}
                </div>
                <p className="form-hint" style={{ marginBottom: 4 }}>
                  {(selectedBin.binW != null || selectedBin.binD != null || selectedBin.binH != null)
                    ? 'Custom · overrides rack default'
                    : 'Rack default · edit to override'}
                </p>

                <div className="section-divider" />

                {/* Bin-level total (units in this bin only) */}
                {(selectedBin.skus ?? []).length > 0 && (
                  <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--text-dim)' }}>
                    {(selectedBin.skus ?? []).reduce((s, e) => s + (e.qty ?? 0), 0).toLocaleString()} unit{(selectedBin.skus ?? []).reduce((s, e) => s + (e.qty ?? 0), 0) !== 1 ? 's' : ''} in this bin
                  </div>
                )}
                <div className="section-label">Contents</div>

                {/* SKU list — each entry shows cross-bin stats, location badge, and "of X" */}
                {(selectedBin.skus ?? []).length > 0 ? (
                  <div className="sku-list">
                    {selectedBin.skus.map(entry => {
                      const entryLoc = entry.location ?? 'TBD'
                      // "of X" uses current stock per location from Warehouse Item View CSV;
                      // falls back to catalog total for TBD entries
                      const locTotal = entryLoc !== 'TBD'
                        ? (locationQtys[entry.sku]?.[entryLoc] ?? null)
                        : (skuCatalog?.[entry.sku]?.qty ?? null)
                      const editVal = editingQtys[entry.id] ?? entry.qty
                      const locHex = locationColors[entryLoc] ?? (entryLoc === 'TBD' ? 0xb8860b : null)
                      const locCss = locHex ? '#' + locHex.toString(16).padStart(6, '0') : '#5a6a7a'
                      return (
                        <div key={entry.id} className="sku-entry" style={{ flexWrap: 'wrap', gap: 4 }}>
                          <span className="sku-code" style={{ flex: '1 1 100%' }}>{entry.sku}</span>
                          {/* Cross-bin aggregation: total packed across all bins + per-location breakdown */}
                          {binSkuStats[entry.sku] && (() => {
                            const { totalPacked, packedByLoc, totalInventory } = binSkuStats[entry.sku]
                            const remaining = totalInventory != null ? totalInventory - totalPacked : null
                            return (
                              <div style={{ flex: '1 1 100%', fontSize: 10, marginBottom: 1 }}>
                                <span style={{ color: 'var(--text-muted)' }}>
                                  {totalPacked.toLocaleString()} packed (all bins)
                                  {totalInventory != null && <> · {totalInventory.toLocaleString()} in stock</>}
                                  {remaining != null && remaining > 0 && (
                                    <> · <span style={{ color: '#e67e22' }}>{remaining.toLocaleString()} unassigned</span></>
                                  )}
                                  {remaining != null && remaining <= 0 && (
                                    <> · <span style={{ color: '#27ae60' }}>fully packed</span></>
                                  )}
                                </span>
                                {/* Unassigned per location: how many units in each location still need to be packed */}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 2 }}>
                                  {Object.entries(locationQtys[entry.sku] ?? {}).map(([loc, invQty]) => {
                                    const packedQty = packedByLoc[loc] ?? 0
                                    const unassigned = invQty - packedQty
                                    if (unassigned <= 0) return null
                                    const hex = locationColors[loc] ?? (loc === 'TBD' ? 0xb8860b : 0x5a6a7a)
                                    const css = '#' + hex.toString(16).padStart(6, '0')
                                    return (
                                      <span key={loc} style={{ color: css, whiteSpace: 'nowrap' }}>
                                        {loc}: {unassigned.toLocaleString()} left
                                      </span>
                                    )
                                  }).filter(Boolean)}
                                </div>
                              </div>
                            )
                          })()}
                          {/* Inline location selector — click to reassign, merges if target exists */}
                          <select
                            value={entryLoc}
                            onChange={e => onUpdateSkuLocation?.(selectedBin.id, entry.id, e.target.value)}
                            style={{
                              flex: '1 1 auto', fontSize: 10, color: locCss, fontWeight: 600,
                              background: 'var(--panel-raised, #1a2330)', border: '1px solid var(--border)',
                              borderRadius: 3, padding: '2px 4px', cursor: 'pointer',
                            }}
                          >
                            {allLocations.map(loc => (
                              <option key={loc} value={loc}>{loc}</option>
                            ))}
                          </select>
                          <div className="sku-qty-group" style={{ flex: '0 0 auto' }}>
                            <input
                              className="sku-qty-input"
                              type="number"
                              min="1"
                              value={editVal}
                              onChange={e => setEditingQtys(prev => ({ ...prev, [entry.id]: e.target.value }))}
                              onBlur={() => {
                                const newQty = Math.max(1, Math.round(Number(editingQtys[entry.id]) || 1))
                                if (editingQtys[entry.id] !== undefined && newQty !== entry.qty) {
                                  onUpdateSkuQty(selectedBin.id, entry.id, newQty)
                                }
                                setEditingQtys(prev => { const n = { ...prev }; delete n[entry.id]; return n })
                              }}
                              onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                            />
                            {locTotal != null && (
                              <span className="sku-of-total">of {locTotal.toLocaleString()}</span>
                            )}
                          </div>
                          <button
                            className="sku-remove"
                            title="Remove SKU"
                            onClick={() => onRemoveSku(selectedBin.id, entry.id)}
                          >✕</button>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="form-hint" style={{ marginBottom: 10 }}>No SKUs assigned yet.</p>
                )}

                {/* Add SKU form — autocomplete input on its own row, qty + Add + scan below */}
                <div className="sku-autocomplete">
                  <input
                    className="form-input"
                    type="text"
                    placeholder="SKU code or product name"
                    value={skuInput}
                    onChange={e => {
                      setSkuInput(e.target.value)
                      setSkuError(null)
                      setShowSuggestions(true)
                      setActiveSuggestion(-1)
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setShowSuggestions(false)}
                    onKeyDown={handleSuggestionKeyDown}
                    style={{ marginBottom: 6 }}
                  />
                  {showSuggestions && suggestions.length > 0 && (
                    <div className="sku-suggestions">
                      {suggestions.map((s, i) => (
                        <div
                          key={s.sku}
                          className={`sku-suggestion-item${i === activeSuggestion ? ' active' : ''}`}
                          onMouseDown={e => { e.preventDefault(); handleSelectSuggestion(s.sku) }}
                        >
                          <span className="suggestion-sku">{s.sku}</span>
                          {s.name && <span className="suggestion-name">{s.name}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!showSuggestions && skuInput && skuCatalog?.[skuInput.trim().toUpperCase()]?.qty != null && (
                  <p className="sku-catalog-hint">
                    {skuCatalog[skuInput.trim().toUpperCase()].qty.toLocaleString()} units on record
                  </p>
                )}
                {/* Feature 4 — location picker for the SKU being added */}
                <select
                  className="form-input"
                  style={{ marginBottom: 6, fontSize: 11 }}
                  value={skuLocation}
                  onChange={e => setSkuLocation(e.target.value)}
                >
                  {allLocations.map(loc => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                </select>
                {/* Per-location stock breakdown from Warehouse Item View CSV; chips are clickable to select location */}
                {!showSuggestions && skuInput && locationQtys[skuInput.trim().toUpperCase()] && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', marginBottom: 6 }}>
                    {Object.entries(locationQtys[skuInput.trim().toUpperCase()]).map(([loc, qty]) => {
                      const hex = locationColors[loc] ?? (loc === 'TBD' ? 0xb8860b : 0x5a6a7a)
                      const css = '#' + hex.toString(16).padStart(6, '0')
                      const isActive = skuLocation === loc
                      return (
                        <button
                          key={loc}
                          type="button"
                          onClick={() => setSkuLocation(loc)}
                          style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                            border: `1px solid ${css}`, color: isActive ? '#fff' : css,
                            background: isActive ? css : 'transparent', whiteSpace: 'nowrap',
                          }}
                        >
                          {loc}: {qty.toLocaleString()}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="sku-add-row">
                  <input
                    className="form-input qty-input"
                    type="number"
                    min="1"
                    value={qtyInput}
                    onChange={e => setQtyInput(e.target.value)}
                    title="Quantity"
                  />
                  <button className="btn-secondary sku-add-btn" onClick={handleAddSkuSubmit}>
                    Add
                  </button>
                  <button
                    className="sku-scan-btn"
                    title="Scan barcode with camera"
                    onClick={() => setScanning(true)}
                  >
                    📷 Scan
                  </button>
                </div>
                {skuError && <p className="sku-error">{skuError}</p>}

                {/* Barcode scanner modal */}
                {scanning && (
                  <BarcodeScanner
                    onDetect={code => { setSkuInput(code); setScanning(false) }}
                    onClose={() => setScanning(false)}
                  />
                )}

                <div className="section-divider" />

                {!movingBinId && (
                  <>
                    <button
                      className="btn-secondary"
                      style={{ marginBottom: 8 }}
                      onClick={() => setLabelBin(selectedBin)}
                    >
                      Print Label
                    </button>
                    <div className="rack-actions">
                      <button
                        className="btn-secondary"
                        style={selectedBin.displaced ? { borderColor: '#c05218', color: '#c05218' } : {}}
                        onClick={handleMoveBinFromBinView}
                      >
                        {selectedBin.displaced ? '↗ Assign to Rack' : '↑ Move Bin'}
                      </button>
                      <button
                        className="btn-secondary"
                        style={{ borderColor: '#c0392b', color: '#c0392b' }}
                        onClick={() => onRequestDeleteBin(selectedBin.id)}
                      >
                        Remove Bin
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {!selectedBin && !movingBinId && (
              <p className="form-hint" style={{ paddingTop: 8 }}>No bin selected.</p>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          UNASSIGNED VIEW — SKUs that have units not yet in any bin
      ═══════════════════════════════════════════════════════════ */}
      {view === 'unassigned' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={() => setView('main')}>← Warehouse Editor</button>
            </div>
            <div className="rack-view-title-row">
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>SKUs to be Packed</h2>
            </div>
          </div>
          <div className="panel-content">
            {unassignedSkus.length === 0 ? (
              <p className="form-hint" style={{ paddingTop: 8 }}>
                {Object.keys(skuCatalog ?? {}).length === 0
                  ? 'Import a NetSuite CSV first to see unassigned SKUs.'
                  : 'All catalog SKUs are fully assigned to bins.'}
              </p>
            ) : (
              <>
                <p className="form-hint" style={{ marginBottom: 10 }}>
                  {unassignedSkus.length} SKU{unassignedSkus.length > 1 ? 's' : ''} with unassigned units
                </p>
                <div className="unassigned-list">
                  {unassignedSkus.map(item => (
                    <div
                      key={item.sku}
                      className="unassigned-item"
                      onClick={() => openLookupPanel(item.sku, 'unassigned')}
                    >
                      <div className="unassigned-item-row">
                        <span className="sku-code">{item.sku}</span>
                        <span className="unassigned-badge">{item.unassigned.toLocaleString()} left</span>
                      </div>
                      {item.name && <span className="unassigned-name">{item.name}</span>}
                      <div className="unassigned-progress">
                        <div
                          className="unassigned-progress-fill"
                          style={{ width: item.totalQty > 0 ? `${Math.min(100, (item.assigned / item.totalQty) * 100)}%` : '0%' }}
                        />
                      </div>
                      <span className="unassigned-ratio">{item.assigned.toLocaleString()} of {item.totalQty.toLocaleString()} assigned</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          SKU LOOKUP VIEW — Search by code or scan, see all bin assignments, assign more
      ═══════════════════════════════════════════════════════════ */}
      {view === 'sku-lookup' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={() => {
                setLookupSku(null)
                setLookupInput('')
                setView(lookupSource === 'unassigned' ? 'unassigned' : 'main')
              }}>
                ← {lookupSource === 'unassigned' ? 'SKUs to be Packed' : 'Warehouse Editor'}
              </button>
            </div>
            <div className="rack-view-title-row">
              {lookupSku
                ? <>
                    <span className="bin-id-badge" style={{ fontSize: 12 }}>{lookupSku}</span>
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 8px', marginLeft: 'auto' }} onClick={() => { setLookupSku(null); setLookupInput('') }}>
                      ← New Search
                    </button>
                  </>
                : <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Pack / Count</h2>
              }
            </div>
          </div>

          <div className="panel-content">

            {/* ── Search state ── */}
            {!lookupSku && (
              <>
                <div className="sku-autocomplete">
                  <input
                    className="form-input"
                    placeholder="SKU code or product name"
                    value={lookupInput}
                    onChange={e => {
                      setLookupInput(e.target.value)
                      setLookupShowSuggestions(true)
                      setLookupActiveSuggestion(-1)
                    }}
                    onFocus={() => setLookupShowSuggestions(true)}
                    onBlur={() => setLookupShowSuggestions(false)}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setLookupActiveSuggestion(prev => Math.min(prev + 1, lookupSuggestions.length - 1)) }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); setLookupActiveSuggestion(prev => Math.max(prev - 1, -1)) }
                      else if (e.key === 'Enter') {
                        if (lookupActiveSuggestion >= 0 && lookupSuggestions[lookupActiveSuggestion]) {
                          e.preventDefault(); handleLookupSearch(lookupSuggestions[lookupActiveSuggestion].sku)
                        } else { handleLookupSearch() }
                      } else if (e.key === 'Escape') { setLookupShowSuggestions(false) }
                    }}
                    style={{ marginBottom: 6 }}
                    autoFocus
                  />
                  {lookupShowSuggestions && lookupSuggestions.length > 0 && (
                    <div className="sku-suggestions">
                      {lookupSuggestions.map((s, i) => (
                        <div
                          key={s.sku}
                          className={`sku-suggestion-item${i === lookupActiveSuggestion ? ' active' : ''}`}
                          onMouseDown={e => { e.preventDefault(); handleLookupSearch(s.sku) }}
                        >
                          <span className="suggestion-sku">{s.sku}</span>
                          {s.name && <span className="suggestion-name">{s.name}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="sku-add-row">
                  <button className="btn-primary" style={{ flex: 1 }} onClick={() => handleLookupSearch()}>
                    Search
                  </button>
                  <button className="sku-scan-btn" onClick={() => setLookupScanning(true)}>
                    📷 Scan
                  </button>
                </div>
                {lookupScanning && (
                  <BarcodeScanner
                    onDetect={code => { setLookupScanning(false); handleLookupSearch(code) }}
                    onClose={() => setLookupScanning(false)}
                  />
                )}
              </>
            )}

            {/* ── Detail state ── */}
            {lookupSku && lookupData && (
              <>
                {/* Summary card */}
                <div className="lookup-summary">
                  {lookupData.entry?.name && (
                    <p className="lookup-product-name">{lookupData.entry.name}</p>
                  )}
                  {!lookupData.entry && (
                    <p className="form-hint" style={{ marginBottom: 8 }}>SKU not in catalog — can still be assigned to bins.</p>
                  )}
                  {lookupData.entry && (
                    <div className="lookup-stats-row">
                      <div className="lookup-stat">
                        <span className="lookup-stat-label">On record</span>
                        <span className="lookup-stat-value">{(lookupData.entry.qty ?? 0).toLocaleString()}</span>
                      </div>
                      <div className="lookup-stat">
                        <span className="lookup-stat-label">In bins</span>
                        <span className="lookup-stat-value">{lookupData.totalAssigned.toLocaleString()}</span>
                      </div>
                      <div className="lookup-stat">
                        <span className="lookup-stat-label">Unassigned</span>
                        <span className="lookup-stat-value" style={{ color: lookupData.unassigned > 0 ? '#e67e22' : '#27ae60' }}>
                          {lookupData.unassigned.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="section-divider" />

                {/* Current bin assignments */}
                <div className="section-label">
                  Current Assignments ({lookupData.bins.length})
                </div>
                {lookupData.bins.length === 0 ? (
                  <p className="form-hint" style={{ marginBottom: 10 }}>Not assigned to any bin yet.</p>
                ) : (
                  <div className="lookup-bin-list">
                    {lookupData.bins.map(({ bin, rack, qty, entryId }) => (
                      <div key={bin.id} className="lookup-bin-item">
                        <div className="lookup-bin-info">
                          <span className="sku-code" style={{ fontSize: 11 }}>{bin.binId}</span>
                          {rack && <span className="lookup-bin-rack">{rack.rackId}</span>}
                        </div>
                        <div className="sku-qty-group">
                          <input
                            className="sku-qty-input"
                            type="number"
                            min="1"
                            defaultValue={qty}
                            onBlur={e => {
                              const newQty = Math.max(1, Math.round(Number(e.target.value) || 1))
                              if (newQty !== qty) onUpdateSkuQty(bin.id, entryId, newQty)
                            }}
                            onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                          />
                        </div>
                        <button className="sku-remove" title="Remove from bin" onClick={() => onRemoveSku(bin.id, entryId)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="section-divider" />

                {/* Assign more */}
                <div className="section-label">Assign More Units</div>
                <div className="sku-autocomplete">
                  <input
                    className="form-input"
                    placeholder="Bin ID (e.g. WH1-R01-A1)"
                    value={lookupBinFilter}
                    onChange={e => {
                      setLookupBinFilter(e.target.value)
                      setLookupBinId(null)
                      setLookupBinShowSug(true)
                    }}
                    onFocus={() => setLookupBinShowSug(true)}
                    onBlur={() => setLookupBinShowSug(false)}
                    style={{ marginBottom: 6 }}
                  />
                  {lookupBinShowSug && lookupBinSuggestions.length > 0 && (
                    <div className="sku-suggestions">
                      {lookupBinSuggestions.map(b => {
                        const rack = racks.find(r => r.id === b.rackId)
                        return (
                          <div
                            key={b.id}
                            className="sku-suggestion-item"
                            onMouseDown={e => {
                              e.preventDefault()
                              setLookupBinFilter(b.binId)
                              setLookupBinId(b.id)
                              setLookupBinShowSug(false)
                            }}
                          >
                            <span className="suggestion-sku">{b.binId}</span>
                            {rack && <span className="suggestion-name">{rack.rackId}</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="sku-add-row">
                  <input
                    className="form-input qty-input"
                    type="number"
                    min="1"
                    value={lookupQty}
                    onChange={e => setLookupQty(e.target.value)}
                    title="Quantity to assign"
                  />
                  <button
                    className="btn-primary sku-add-btn"
                    disabled={!lookupBinId}
                    onClick={handleLookupAssign}
                  >
                    Assign
                  </button>
                </div>
                {lookupAssignError && <p className="sku-error">{lookupAssignError}</p>}
              </>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          ROOM VIEW — Selected space placeholder details
      ═══════════════════════════════════════════════════════════ */}
      {view === 'room' && (() => {
        const room = rooms.find(r => r.id === selectedRoomId) ?? null
        const LABELS = { office: 'Office', bathroom: 'Bathroom', snack: 'Snack Room', storage: 'Storage', other: 'Space' }
        return (
          <>
            <div className="panel-header rack-view-header">
              <div className="rack-view-nav">
                <button className="back-btn" onClick={() => { setView('main'); onSelectRoom(null) }}>← Warehouse Editor</button>
              </div>
              <div className="rack-view-title-row">
                <span className="bin-id-badge" style={{ fontSize: 13 }}>{room?.name || LABELS[room?.type] || 'Space'}</span>
              </div>
            </div>
            <div className="panel-content">
              {room ? (
                <>
                  <div className="section-label">Details</div>
                  <div className="stat-group">
                    <label>Type</label>
                    <span className="stat-value" style={{ textTransform: 'capitalize' }}>{LABELS[room.type] ?? room.type}</span>
                  </div>
                  <div className="stat-group">
                    <label>Warehouse</label>
                    <span className="stat-value">WH{room.whIndex + 1}</span>
                  </div>
                  <div className="stat-group">
                    <label>Dimensions</label>
                    <span className="stat-value">{room.roomW} × {room.roomD} ft</span>
                  </div>
                  <div className="section-divider" />
                  <button
                    className="btn-secondary"
                    style={{ borderColor: '#c0392b', color: '#c0392b' }}
                    onClick={() => { onDeleteRoom(room.id); setView('main') }}
                  >
                    Remove Space
                  </button>
                </>
              ) : (
                <p className="form-hint" style={{ paddingTop: 8 }}>Space not found.</p>
              )}
            </div>
          </>
        )
      })()}

      {/* ═══════════════════════════════════════════════════════════
          DISCREPANCY VIEW — Overpacked / shortage SKUs
      ═══════════════════════════════════════════════════════════ */}
      {view === 'discrepancy' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={() => setView('main')}>← Warehouse Editor</button>
            </div>
            <div className="rack-view-title-row">
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Inventory Discrepancy</h2>
            </div>
          </div>
          <div className="panel-content">
            {discrepancyData.overpacked.length === 0 && discrepancyData.underpacked.length === 0 ? (
              <p className="form-hint" style={{ paddingTop: 8 }}>No discrepancies found.</p>
            ) : (
              <>
                {discrepancyData.overpacked.length > 0 && (
                  <>
                    <div className="section-label" style={{ color: '#c0392b' }}>
                      Overpacked ({discrepancyData.overpacked.length})
                    </div>
                    <p className="form-hint" style={{ marginBottom: 8 }}>More units in bins than catalog record</p>
                    <div className="unassigned-list">
                      {discrepancyData.overpacked.map(item => (
                        <div key={item.sku} className="unassigned-item">
                          <div className="unassigned-item-row">
                            <span className="sku-code">{item.sku}</span>
                            <span className="unassigned-badge" style={{ background: '#c0392b', color: '#fff' }}>
                              +{item.excess.toLocaleString()} extra
                            </span>
                          </div>
                          {item.name && <span className="unassigned-name">{item.name}</span>}
                          <span className="unassigned-ratio">
                            {item.assigned.toLocaleString()} packed · {item.catalogQty.toLocaleString()} on record
                          </span>
                        </div>
                      ))}
                    </div>
                    {discrepancyData.underpacked.length > 0 && <div className="section-divider" />}
                  </>
                )}
                {discrepancyData.underpacked.length > 0 && (
                  <>
                    <div className="section-label">
                      Shortages ({discrepancyData.underpacked.length})
                    </div>
                    <p className="form-hint" style={{ marginBottom: 8 }}>Fewer units packed than catalog record</p>
                    <div className="unassigned-list">
                      {discrepancyData.underpacked.map(item => (
                        <div key={item.sku} className="unassigned-item">
                          <div className="unassigned-item-row">
                            <span className="sku-code">{item.sku}</span>
                            <span
                              className="unassigned-badge"
                              style={item.confirmed ? { background: '#27ae60', color: '#fff' } : {}}
                            >
                              {item.confirmed ? '✓ Confirmed' : `-${item.shortage.toLocaleString()} short`}
                            </span>
                          </div>
                          {item.name && <span className="unassigned-name">{item.name}</span>}
                          <span className="unassigned-ratio">
                            {item.assigned.toLocaleString()} packed · {item.catalogQty.toLocaleString()} on record
                          </span>
                          <button
                            className="btn-secondary"
                            style={{
                              marginTop: 5, fontSize: 11, padding: '3px 8px', width: 'auto',
                              ...(item.confirmed ? {} : { borderColor: '#27ae60', color: '#27ae60' }),
                            }}
                            onClick={() => item.confirmed
                              ? onUnconfirmShortage(item.sku)
                              : onConfirmShortage(item.sku)
                            }
                          >
                            {item.confirmed ? 'Unconfirm' : 'Confirm shortage'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          LABELS-NEEDED VIEW — Bins edited since last label print
      ═══════════════════════════════════════════════════════════ */}
      {view === 'labels-needed' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={() => setView('main')}>← Warehouse Editor</button>
            </div>
            <div className="rack-view-title-row">
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Labels Needed</h2>
            </div>
          </div>
          <div className="panel-content">
            {labelsNeeded.length === 0 ? (
              <p className="form-hint" style={{ paddingTop: 8 }}>All labels are up to date.</p>
            ) : (
              <>
                <p className="form-hint" style={{ marginBottom: 10 }}>
                  {labelsNeeded.length} bin{labelsNeeded.length > 1 ? 's' : ''} edited since last print
                </p>
                <div className="unassigned-list">
                  {labelsNeeded.map(bin => {
                    const rack = racks.find(r => r.id === bin.rackId) ?? null
                    return (
                      <div key={bin.id} className="unassigned-item">
                        <div className="unassigned-item-row">
                          <span className="sku-code">{bin.binId}</span>
                          <button
                            className="btn-primary"
                            style={{ fontSize: 11, padding: '3px 10px', width: 'auto' }}
                            onClick={() => setLabelBin(bin)}
                          >
                            Print Label
                          </button>
                        </div>
                        {rack && <span className="unassigned-name">{rack.rackId}</span>}
                        <span className="unassigned-ratio">
                          Edited {fmtTimestamp(bin.updatedAt)}
                          {bin.labelPrintedAt ? ` · Printed ${fmtTimestamp(bin.labelPrintedAt)}` : ' · Never printed'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          NO-LOCATION VIEW — Bins with TBD SKU entries
      ═══════════════════════════════════════════════════════════ */}
      {view === 'no-location' && (
        <>
          <div className="panel-header rack-view-header">
            <div className="rack-view-nav">
              <button className="back-btn" onClick={() => setView('main')}>← Warehouse Editor</button>
            </div>
            <div className="rack-view-title-row">
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Bins with no Location</h2>
            </div>
          </div>
          <div className="panel-content">
            {noLocationBins.length === 0 ? (
              <p className="form-hint" style={{ paddingTop: 8 }}>All bins have locations assigned.</p>
            ) : (
              <>
                <p className="form-hint" style={{ marginBottom: 10, color: '#b8860b' }}>
                  {noLocationBins.length} bin{noLocationBins.length !== 1 ? 's' : ''} with unassigned SKU units — open each bin to assign a location.
                </p>
                <div className="unassigned-list">
                  {noLocationBins.map(bin => {
                    const rack = racks.find(r => r.id === bin.rackId) ?? null
                    const tbdQty = (bin.skus ?? [])
                      .filter(s => !s.location || s.location === 'TBD')
                      .reduce((sum, s) => sum + (s.qty ?? 0), 0)
                    return (
                      <div
                        key={bin.id}
                        className="unassigned-item"
                        style={{ cursor: 'pointer' }}
                        onClick={() => { onSelectBin(bin.id); setView('bin') }}
                      >
                        <div className="unassigned-item-row">
                          <span className="sku-code">{bin.binId}</span>
                          <span className="unassigned-badge" style={{ background: '#b8860b', color: '#fff' }}>
                            {tbdQty} TBD
                          </span>
                        </div>
                        {rack && <span className="unassigned-name">{rack.rackId}</span>}
                        {bin.poNumber && (
                          <span className="unassigned-ratio">{bin.poNumber}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Warehouse dimension confirmation modal ──────────────────────── */}
      {dimConfirm && (
        <div className="label-overlay" onClick={e => { if (e.target === e.currentTarget) setDimConfirm(null) }}>
          <div className="label-shell" style={{ maxWidth: 340 }}>
            <div style={{
              background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Change Warehouse Dimensions?</div>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0, lineHeight: 1.5 }}>
                You are about to resize <strong>{dimConfirm.whCode}</strong> to{' '}
                <strong>{dimConfirm.newWidth} × {dimConfirm.newDepth} ft</strong>.
              </p>
              <p style={{ fontSize: 12, color: '#e67e22', margin: 0, lineHeight: 1.5 }}>
                ⚠ The 3D view will reset to its default camera position. All rack and bin data is preserved.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button className="btn-secondary" style={{ width: 'auto', padding: '7px 14px' }} onClick={() => setDimConfirm(null)}>
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  style={{ width: 'auto', padding: '7px 16px' }}
                  onClick={() => {
                    onUpdateWarehouseDims(dimConfirm.index, { width: dimConfirm.newWidth, depth: dimConfirm.newDepth })
                    setDimConfirm(null)
                    setWhDimInputs({})
                  }}
                >
                  Apply Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── BinLabel print modal ─────────────────────────────────────────── */}
      {labelBin && (
        <BinLabel
          bin={labelBin}
          rack={racks.find(r => r.id === labelBin.rackId) ?? null}
          skuCatalog={skuCatalog}
          onClose={() => setLabelBin(null)}
          onPrinted={() => {
            onMarkLabelPrinted(labelBin.id)
            setLabelBin(null)
          }}
        />
      )}

      {/* ── SKU master sheet print modal ─────────────────────────────────── */}
      {showSkuSheet && (
        <SkuSheet skuCatalog={skuCatalog} onClose={() => setShowSkuSheet(false)} />
      )}

    </aside>
  )
}

export default ControlPanel

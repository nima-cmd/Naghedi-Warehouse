import { useState, useEffect, useRef, useMemo } from 'react'
import BarcodeScanner from '../BarcodeScanner/BarcodeScanner'

const DEFAULT_FORM = { cols: 5, rows: 6, rotated: false }

const fmtTimestamp = (iso) => {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch { return iso }
}

function ControlPanel({
  visible, warehouses, racks, bins, skus,
  selectedRackId, selectedBinId, placingRack,
  movingBinId,
  onUpdateWarehouseName,
  onStartPlaceRack, onCancelPlace,
  onUpdateRack, onDeleteRack, onMoveRack,
  onSelectRack, onSelectBin,
  onStartMoveBin, onMoveBin, onCancelMoveBin,
  onRequestDeleteBin,
  onAddSku, onRemoveSku, onUpdateSkuQty,
  onImportCsv, skuCatalog, catalogUpdatedAt,
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
  }, [selectedBinId])

  // Read a CSV file from disk and hand the raw text to the parent handler
  const handleCsvFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onImportCsv(ev.target.result)
    reader.readAsText(file)
    e.target.value = '' // reset so the same file can be re-selected if needed
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
    onAddSku(selectedBinId, trimmed, qty)
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
            {warehouses.map((wh, i) => (
              <div key={wh.code} className="wh-row">
                <span className="wh-code">{wh.code}</span>
                <input
                  className="wh-name-input"
                  type="text"
                  value={wh.name}
                  onChange={e => onUpdateWarehouseName(i, e.target.value)}
                />
              </div>
            ))}
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
                disabled={!!placingRack}
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
            {catalogUpdatedAt
              ? <p className="catalog-timestamp">Last synced: {fmtTimestamp(catalogUpdatedAt)}</p>
              : <p className="catalog-timestamp" style={{ color: '#5a6a7a' }}>Never synced</p>
            }
            <label className="btn-secondary csv-import-btn">
              {Object.keys(skuCatalog ?? {}).length > 0 ? '↻ Re-import CSV' : '↑ Import NetSuite CSV'}
              <input type="file" accept=".csv" hidden onChange={handleCsvFile} />
            </label>
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
                  style={{ gridTemplateColumns: `repeat(${panelRack.cols}, 1fr)` }}
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

                <div className="section-label">Contents</div>

                {/* SKU list — each entry has an editable qty and shows "of Y total" when catalog is loaded */}
                {(selectedBin.skus ?? []).length > 0 ? (
                  <div className="sku-list">
                    {selectedBin.skus.map(entry => {
                      const catalogTotal = skuCatalog?.[entry.sku]?.qty
                      const editVal = editingQtys[entry.id] ?? entry.qty
                      return (
                        <div key={entry.id} className="sku-entry">
                          <span className="sku-code">{entry.sku}</span>
                          <div className="sku-qty-group">
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
                            {catalogTotal != null && (
                              <span className="sku-of-total">of {catalogTotal.toLocaleString()}</span>
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

    </aside>
  )
}

export default ControlPanel

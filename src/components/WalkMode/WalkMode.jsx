import { useState, useMemo, useEffect } from 'react'
import BarcodeScanner from '../BarcodeScanner/BarcodeScanner'
import './WalkMode.css'

export default function WalkMode({
  warehouses = [],
  racks = [],
  bins = [],
  locationNames = [],
  locationQtys = {},
  skuCatalog = {},
  onSelectBin,
  onAddSku,
  onRemoveSku,
  onUpdateSkuQty,
  onUpdateSkuLocation,
  onCreateRack,
  onUpdateBin,
  onRequestDeleteBin,
  suggestedRackId,
}) {
  const [view, setView] = useState('finder')  // 'finder' | 'rack' | 'bin' | 'create-rack'
  const [activeBinId, setActiveBinId] = useState(null)
  const [browsedRackId, setBrowsedRackId] = useState(null)
  const [binBackView, setBinBackView] = useState('finder')  // where ← Back goes from bin detail

  const [searchInput, setSearchInput] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [scanning, setScanning] = useState(null)  // 'bin' | 'sku'
  const [skuInput, setSkuInput] = useState('')
  const [qtyInput, setQtyInput] = useState(1)
  const [locationInput, setLocationInput] = useState(() => locationNames[0] ?? 'TBD')
  const [skuError, setSkuError] = useState('')
  const [recentBinIds, setRecentBinIds] = useState([])
  const [flagNoteInput, setFlagNoteInput] = useState('')

  // Create rack form
  const [crWhIndex, setCrWhIndex] = useState(0)
  const [crRackId, setCrRackId] = useState('')
  const [crCols, setCrCols] = useState(4)
  const [crRows, setCrRows] = useState(6)
  const [crCreated, setCrCreated] = useState(null)

  const activeBin   = bins.find(b => b.id === activeBinId)
  const browsedRack = racks.find(r => r.id === browsedRackId)

  // If the open bin was deleted out from under us (confirmed via the app-level
  // delete modal), back out instead of rendering a blank bin-detail screen.
  useEffect(() => {
    if (view === 'bin' && activeBinId && !activeBin) setView(binBackView)
  }, [view, activeBinId, activeBin, binBackView])

  // Bins for the rack currently being browsed — sorted for display:
  // rows top-to-bottom (highest level first), columns left-to-right
  const browsedRackBins = useMemo(() => {
    if (!browsedRackId) return []
    return bins
      .filter(b => b.rackId === browsedRackId)
      .sort((a, b) => b.row - a.row || a.col - b.col)
  }, [bins, browsedRackId])

  // Bins in the same rack as activeBin — sorted column-first for prev/next navigation
  const rackBins = useMemo(() => {
    if (!activeBin?.rackId) return []
    return bins
      .filter(b => b.rackId === activeBin.rackId)
      .sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row)
  }, [bins, activeBin])

  const activeBinIndex = rackBins.findIndex(b => b.id === activeBinId)
  const prevBin = activeBinIndex > 0 ? rackBins[activeBinIndex - 1] : null
  const nextBin = activeBinIndex < rackBins.length - 1 ? rackBins[activeBinIndex + 1] : null

  // All bins flagged for recount, across every warehouse/rack — surfaced in the finder
  // so a full-day flagging pass can be reviewed from any device without hunting rack by rack.
  const flaggedBins = useMemo(() => bins.filter(b => b.flagged), [bins])

  const openBin = (bin, backView = 'finder') => {
    setActiveBinId(bin.id)
    setBinBackView(backView)
    onSelectBin?.(bin.id)
    setRecentBinIds(prev => [bin.id, ...prev.filter(id => id !== bin.id)].slice(0, 8))
    setView('bin')
    setSkuInput('')
    setQtyInput(1)
    setSkuError('')
    setNotFound(false)
    setFlagNoteInput(bin.flagNote ?? '')
  }

  const handleToggleFlag = () => {
    if (!activeBin) return
    onUpdateBin(activeBinId, activeBin.flagged
      ? { flagged: false, flagNote: '' }
      : { flagged: true, flagNote: flagNoteInput })
  }

  const handleFlagNoteBlur = () => {
    if (!activeBin?.flagged) return
    if (flagNoteInput !== activeBin.flagNote) onUpdateBin(activeBinId, { flagNote: flagNoteInput })
  }

  const openRack = (rack) => {
    setBrowsedRackId(rack.id)
    setView('rack')
  }

  const handleSearch = (value) => {
    const q = (value ?? '').trim().toUpperCase()
    if (!q) return
    // Match against full bin ID or just the short suffix (e.g. "A3" within browsed rack)
    const found = bins.find(b => b.binId?.toUpperCase() === q)
    if (found) {
      openBin(found)
      setSearchInput('')
    } else {
      setNotFound(true)
    }
  }

  const handleBarcodeDetect = (code) => {
    setScanning(null)
    if (scanning === 'bin') {
      handleSearch(code)
    } else if (scanning === 'sku') {
      setSkuInput(code.trim().toUpperCase())
    }
  }

  const handleAddSku = () => {
    const sku = skuInput.trim().toUpperCase()
    if (!sku) { setSkuError('Enter a SKU'); return }
    const qty = parseInt(qtyInput, 10)
    if (!qty || qty < 1) { setSkuError('Enter a valid quantity'); return }
    onAddSku(activeBinId, sku, qty, locationInput || 'TBD')
    setSkuInput('')
    setQtyInput(1)
    setSkuError('')
  }

  const handleCreateRack = () => {
    const rackId = crRackId.trim().toUpperCase()
    if (!rackId) return
    onCreateRack(crWhIndex, rackId, parseInt(crCols) || 4, parseInt(crRows) || 6)
    setCrCreated(rackId)
    setCrRackId('')
  }

  const totalUnits = (bin) => (bin.skus ?? []).reduce((s, e) => s + e.qty, 0)
  const shortBinId = (bin) => bin.binId?.split('-').pop() ?? bin.binId  // "A1" from "WH1-R01-A1"

  const crBinCount  = (parseInt(crCols) || 0) * (parseInt(crRows) || 0)
  const crLastBinId = crBinCount > 0
    ? `${crRackId || 'RACK'}-${String.fromCharCode(64 + (parseInt(crCols) || 1))}${parseInt(crRows) || 1}`
    : '—'

  return (
    <div className="walk-mode">
      {scanning && (
        <BarcodeScanner
          onDetect={handleBarcodeDetect}
          onClose={() => setScanning(null)}
        />
      )}

      {/* ══════════════ BIN FINDER ══════════════ */}
      {view === 'finder' && (
        <div className="walk-finder">
          <div className="walk-section-title">Find a bin to fill</div>

          <div className="walk-search-row">
            <input
              className="walk-input"
              placeholder="Bin ID, e.g. WH1-R01-A3"
              value={searchInput}
              onChange={e => { setSearchInput(e.target.value); setNotFound(false) }}
              onKeyDown={e => e.key === 'Enter' && handleSearch(searchInput)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="walk-btn-accent" onClick={() => handleSearch(searchInput)}>Go</button>
          </div>

          <button className="walk-scan-btn" onClick={() => setScanning('bin')}>
            ⌗ Scan Bin Label
          </button>

          {notFound && (
            <div className="walk-not-found">
              <span>No bin found — check the ID or create the rack first.</span>
              <button className="walk-link-btn" onClick={() => { setView('create-rack'); setCrCreated(null); setCrRackId(suggestedRackId?.(crWhIndex) ?? '') }}>
                + Create Rack
              </button>
            </div>
          )}

          {/* ── Needs Review ── */}
          {flaggedBins.length > 0 && (
            <div className="walk-flagged-list">
              <div className="walk-row-header">
                <span className="walk-label">🚩 Needs Review</span>
                <span className="walk-count-badge">{flaggedBins.length}</span>
              </div>
              {flaggedBins.map(bin => (
                <button key={bin.id} className="walk-flagged-item" onClick={() => openBin(bin)}>
                  <span className="walk-bin-badge">{bin.binId}</span>
                  {bin.flagNote && <span className="walk-flagged-note">{bin.flagNote}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Rack Browser ── */}
          <div className="walk-rack-browser">
            <div className="walk-row-header">
              <span className="walk-label">Browse Racks</span>
              <button
                className="walk-link-btn"
                onClick={() => { setView('create-rack'); setCrCreated(null); setCrRackId(suggestedRackId?.(crWhIndex) ?? '') }}
              >
                + New Rack
              </button>
            </div>

            {racks.length === 0 && (
              <div className="walk-empty-msg">No racks yet — tap + New Rack to create one</div>
            )}

            {warehouses.map((wh, whIdx) => {
              const whRacks = racks
                .filter(r => r.whIndex === whIdx)
                .sort((a, b) => a.rackId.localeCompare(b.rackId))
              if (whRacks.length === 0) return null
              return (
                <div key={wh.code} className="walk-wh-group">
                  <div className="walk-wh-label">{wh.code} — {wh.name}</div>
                  {whRacks.map(rack => {
                    const rBins    = bins.filter(b => b.rackId === rack.id)
                    const filled   = rBins.filter(b => (b.skus ?? []).length > 0).length
                    return (
                      <button
                        key={rack.id}
                        className="walk-rack-item"
                        onClick={() => openRack(rack)}
                      >
                        <span className="walk-rack-id">{rack.rackId}</span>
                        <span className="walk-rack-meta">
                          {rack.cols}×{rack.rows} · {filled}/{rBins.length} filled
                        </span>
                        <span className="walk-rack-chevron">›</span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {recentBinIds.length > 0 && (
            <div className="walk-recent">
              <div className="walk-label">Recent</div>
              {recentBinIds.map(id => {
                const bin = bins.find(b => b.id === id)
                if (!bin) return null
                return (
                  <button key={id} className="walk-recent-item" onClick={() => openBin(bin)}>
                    <span className="walk-bin-badge">{bin.flagged && '🚩 '}{bin.binId}</span>
                    <span className="walk-recent-meta">
                      {totalUnits(bin) === 0 ? 'empty' : `${totalUnits(bin)} units`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ══════════════ RACK VIEW ══════════════ */}
      {view === 'rack' && browsedRack && (
        <div className="walk-rack-view">
          <div className="walk-bin-nav">
            <button className="walk-back-btn" onClick={() => setView('finder')}>← Racks</button>
            <span className="walk-bin-id" style={{ color: 'var(--text)' }}>{browsedRack.rackId}</span>
            <span className="walk-bin-rack-label">
              {warehouses[browsedRack.whIndex]?.code}
            </span>
          </div>

          <div className="walk-rack-summary">
            <span>{browsedRack.cols} columns · {browsedRack.rows} levels</span>
            <span>
              {browsedRackBins.filter(b => (b.skus ?? []).length > 0).length} / {browsedRackBins.length} filled
            </span>
          </div>

          {/* Column header row */}
          <div
            className="walk-bin-grid walk-bin-grid-header"
            style={{ gridTemplateColumns: `repeat(${browsedRack.cols}, 1fr)` }}
          >
            {Array.from({ length: browsedRack.cols }, (_, i) => (
              <div key={i} className="walk-grid-col-header">
                {String.fromCharCode(65 + i)}
              </div>
            ))}
          </div>

          {/* Bin grid — highest level at top */}
          <div
            className="walk-bin-grid"
            style={{ gridTemplateColumns: `repeat(${browsedRack.cols}, 1fr)` }}
          >
            {browsedRackBins.map(bin => {
              const units   = totalUnits(bin)
              const filled  = (bin.skus ?? []).length > 0
              return (
                <button
                  key={bin.id}
                  className={`walk-bin-cell ${filled ? 'filled' : 'empty'} ${bin.flagged ? 'flagged' : ''}`}
                  onClick={() => openBin(bin, 'rack')}
                >
                  {bin.flagged && <span className="walk-bin-cell-flag">🚩</span>}
                  <span className="walk-bin-cell-label">{shortBinId(bin)}</span>
                  {filled && <span className="walk-bin-cell-count">{units}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ══════════════ BIN DETAIL ══════════════ */}
      {view === 'bin' && activeBin && (
        <div className="walk-bin-detail">
          <div className="walk-bin-nav">
            <button className="walk-back-btn" onClick={() => setView(binBackView)}>
              {binBackView === 'rack' ? `← ${browsedRack?.rackId ?? 'Rack'}` : '← Back'}
            </button>
            <span className="walk-bin-id">{activeBin.binId}</span>
            <span className="walk-bin-rack-label">
              {racks.find(r => r.id === activeBin.rackId)?.rackId ?? (activeBin.displaced ? 'Unplaced' : '—')}
            </span>
            <button
              className="walk-delete-bin-btn"
              title="Delete this bin"
              onClick={() => onRequestDeleteBin(activeBinId)}
            >
              🗑
            </button>
          </div>

          {/* Flag for review */}
          <div className="walk-flag-section">
            <button
              className={`walk-flag-btn ${activeBin.flagged ? 'flagged' : ''}`}
              onClick={handleToggleFlag}
            >
              {activeBin.flagged ? '🚩 Flagged for review — tap to clear' : '🚩 Flag for review'}
            </button>
            {activeBin.flagged && (
              <textarea
                className="walk-flag-note"
                placeholder="Why? e.g. qty crossed out, label smudged, mixed carton…"
                value={flagNoteInput}
                onChange={e => setFlagNoteInput(e.target.value)}
                onBlur={handleFlagNoteBlur}
                rows={2}
              />
            )}
          </div>

          {/* SKU list */}
          <div className="walk-sku-section">
            <div className="walk-row-header">
              <span className="walk-label">Contents</span>
              <span className="walk-count-badge">{totalUnits(activeBin)} units</span>
            </div>

            {(activeBin.skus ?? []).length === 0 && (
              <div className="walk-empty-msg">Bin is empty — add a SKU below</div>
            )}

            {(activeBin.skus ?? []).map(entry => {
              const catQty = skuCatalog[entry.sku]?.qty
              const locQty = locationQtys[entry.sku]?.[entry.location]
              return (
                <div key={entry.id} className="walk-sku-row">
                  <div className="walk-sku-info">
                    <span className="walk-sku-code">{entry.sku}</span>
                    <div className="walk-sku-sub">
                      {entry.location && entry.location !== 'TBD' && (
                        <span className="walk-sku-loc">{entry.location}</span>
                      )}
                      {catQty != null && (
                        <span className="walk-sku-of">
                          of {catQty} in stock{locQty != null ? ` · ${locQty} here` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="walk-qty-controls">
                    <button
                      className="walk-qty-btn"
                      onClick={() => entry.qty > 1 && onUpdateSkuQty(activeBinId, entry.id, entry.qty - 1)}
                    >−</button>
                    <span className="walk-qty-display">{entry.qty}</span>
                    <button
                      className="walk-qty-btn"
                      onClick={() => onUpdateSkuQty(activeBinId, entry.id, entry.qty + 1)}
                    >+</button>
                    <button
                      className="walk-remove-btn"
                      onClick={() => onRemoveSku(activeBinId, entry.id)}
                    >✕</button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Add SKU form */}
          <div className="walk-add-sku">
            <div className="walk-label" style={{ marginBottom: 10 }}>Add SKU</div>

            <div className="walk-add-row">
              <input
                className="walk-input walk-input-flex"
                placeholder="SKU code"
                value={skuInput}
                onChange={e => { setSkuInput(e.target.value.toUpperCase()); setSkuError('') }}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="walk-scan-icon" title="Scan barcode" onClick={() => setScanning('sku')}>⌗</button>
            </div>

            <div className="walk-add-row">
              <input
                className="walk-input walk-input-qty"
                type="number"
                inputMode="numeric"
                min="1"
                placeholder="Qty"
                value={qtyInput}
                onChange={e => setQtyInput(e.target.value)}
              />
              {locationNames.length > 0 && (
                <select
                  className="walk-select walk-input-flex"
                  value={locationInput}
                  onChange={e => setLocationInput(e.target.value)}
                >
                  {locationNames.map(loc => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                  <option value="TBD">TBD</option>
                </select>
              )}
            </div>

            {skuError && <div className="walk-error">{skuError}</div>}
            <button className="walk-btn-primary" onClick={handleAddSku}>Add to Bin</button>
          </div>

          {/* Prev / Next navigation */}
          {rackBins.length > 0 && (
            <div className="walk-bin-pagination">
              <button
                className="walk-nav-btn walk-nav-prev"
                disabled={!prevBin}
                onClick={() => prevBin && openBin(prevBin, binBackView)}
              >
                ← {prevBin ? shortBinId(prevBin) : ''}
              </button>
              <span className="walk-nav-pos">{activeBinIndex + 1} / {rackBins.length}</span>
              <button
                className="walk-nav-btn walk-nav-next"
                disabled={!nextBin}
                onClick={() => nextBin && openBin(nextBin, binBackView)}
              >
                {nextBin ? shortBinId(nextBin) : ''} →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════════ CREATE RACK ══════════════ */}
      {view === 'create-rack' && (
        <div className="walk-create-rack">
          <div className="walk-bin-nav">
            <button className="walk-back-btn" onClick={() => setView('finder')}>← Back</button>
            <span className="walk-bin-id" style={{ color: 'var(--text)' }}>Create Rack</span>
            <span />
          </div>

          <div className="walk-form-note">
            You choose the Rack ID — bins will be named {'{'}YourRackID{'}'}-A1, -B2, etc.
            This format is NetSuite-compatible.
          </div>

          {crCreated && (
            <div className="walk-success">
              Rack <strong>{crCreated}</strong> created — tap it in the rack list to fill its bins.
            </div>
          )}

          <div className="walk-form">
            <div className="walk-form-field">
              <label>Warehouse</label>
              <select
                className="walk-select"
                value={crWhIndex}
                onChange={e => { const i = parseInt(e.target.value); setCrWhIndex(i); setCrRackId(suggestedRackId?.(i) ?? '') }}
              >
                {warehouses.map((wh, i) => (
                  <option key={wh.code} value={i}>{wh.code} — {wh.name}</option>
                ))}
              </select>
            </div>

            <div className="walk-form-field">
              <label>Rack ID — you decide the name</label>
              <input
                className="walk-input"
                placeholder="e.g. WH1-R01"
                value={crRackId}
                onChange={e => { setCrRackId(e.target.value); setCrCreated(null) }}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className="walk-form-row">
              <div className="walk-form-field">
                <label>Columns</label>
                <input
                  className="walk-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="26"
                  value={crCols}
                  onChange={e => setCrCols(e.target.value)}
                />
              </div>
              <div className="walk-form-field">
                <label>Levels (Rows)</label>
                <input
                  className="walk-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="20"
                  value={crRows}
                  onChange={e => setCrRows(e.target.value)}
                />
              </div>
            </div>

            {crBinCount > 0 && (
              <div className="walk-form-hint">
                Creates {crBinCount} bins — {crRackId || 'RACK'}-A1 through {crLastBinId}
              </div>
            )}

            <button
              className="walk-btn-primary"
              disabled={!crRackId.trim()}
              onClick={handleCreateRack}
            >
              Create Rack
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

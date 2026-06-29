import { useState, useMemo } from 'react'
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
}) {
  const [view, setView] = useState('finder')  // 'finder' | 'bin' | 'create-rack'
  const [activeBinId, setActiveBinId] = useState(null)
  const [searchInput, setSearchInput] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [scanning, setScanning] = useState(null)  // 'bin' | 'sku'
  const [skuInput, setSkuInput] = useState('')
  const [qtyInput, setQtyInput] = useState(1)
  const [locationInput, setLocationInput] = useState(() => locationNames[0] ?? 'TBD')
  const [skuError, setSkuError] = useState('')
  const [recentBinIds, setRecentBinIds] = useState([])

  // Create rack form
  const [crWhIndex, setCrWhIndex] = useState(0)
  const [crRackId, setCrRackId] = useState('')
  const [crCols, setCrCols] = useState(4)
  const [crRows, setCrRows] = useState(6)
  const [crCreated, setCrCreated] = useState(null)

  const activeBin = bins.find(b => b.id === activeBinId)

  // Bins in the same rack as activeBin, sorted column-first then level
  const rackBins = useMemo(() => {
    if (!activeBin?.rackId) return []
    return bins
      .filter(b => b.rackId === activeBin.rackId)
      .sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row)
  }, [bins, activeBin])

  const activeBinIndex = rackBins.findIndex(b => b.id === activeBinId)
  const prevBin = activeBinIndex > 0 ? rackBins[activeBinIndex - 1] : null
  const nextBin = activeBinIndex < rackBins.length - 1 ? rackBins[activeBinIndex + 1] : null

  const openBin = (bin) => {
    setActiveBinId(bin.id)
    onSelectBin?.(bin.id)
    setRecentBinIds(prev => [bin.id, ...prev.filter(id => id !== bin.id)].slice(0, 8))
    setView('bin')
    setSkuInput('')
    setQtyInput(1)
    setSkuError('')
    setNotFound(false)
  }

  const handleSearch = (value) => {
    const q = (value ?? '').trim().toUpperCase()
    if (!q) return
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

  const crBinCount = (parseInt(crCols) || 0) * (parseInt(crRows) || 0)
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

      {/* ── Bin Finder ── */}
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
              <button className="walk-link-btn" onClick={() => { setView('create-rack'); setCrCreated(null) }}>
                + Create Rack
              </button>
            </div>
          )}

          {recentBinIds.length > 0 && (
            <div className="walk-recent">
              <div className="walk-label">Recent</div>
              {recentBinIds.map(id => {
                const bin = bins.find(b => b.id === id)
                if (!bin) return null
                return (
                  <button key={id} className="walk-recent-item" onClick={() => openBin(bin)}>
                    <span className="walk-bin-badge">{bin.binId}</span>
                    <span className="walk-recent-meta">
                      {totalUnits(bin) === 0 ? 'empty' : `${totalUnits(bin)} units`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="walk-divider" />

          <button className="walk-create-rack-btn" onClick={() => { setView('create-rack'); setCrCreated(null) }}>
            + Create New Rack
          </button>
        </div>
      )}

      {/* ── Bin Detail ── */}
      {view === 'bin' && activeBin && (
        <div className="walk-bin-detail">
          {/* Nav bar */}
          <div className="walk-bin-nav">
            <button className="walk-back-btn" onClick={() => setView('finder')}>← Back</button>
            <span className="walk-bin-id">{activeBin.binId}</span>
            <span className="walk-bin-rack-label">
              {racks.find(r => r.id === activeBin.rackId)?.rackId ?? (activeBin.displaced ? 'Unplaced' : '—')}
            </span>
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
                        <span className="walk-sku-of">of {catQty} in stock{locQty != null ? ` · ${locQty} here` : ''}</span>
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
                onClick={() => prevBin && openBin(prevBin)}
              >
                ← {prevBin ? prevBin.binId : ''}
              </button>
              <span className="walk-nav-pos">{activeBinIndex + 1} / {rackBins.length}</span>
              <button
                className="walk-nav-btn walk-nav-next"
                disabled={!nextBin}
                onClick={() => nextBin && openBin(nextBin)}
              >
                {nextBin ? nextBin.binId : ''} →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Create Rack ── */}
      {view === 'create-rack' && (
        <div className="walk-create-rack">
          <div className="walk-bin-nav">
            <button className="walk-back-btn" onClick={() => setView('finder')}>← Back</button>
            <span className="walk-bin-id" style={{ color: 'var(--text)' }}>Create Rack</span>
            <span />
          </div>

          {crCreated && (
            <div className="walk-success">
              Rack <strong>{crCreated}</strong> created — search for its bins to start filling them.
            </div>
          )}

          <div className="walk-form">
            <div className="walk-form-field">
              <label>Warehouse</label>
              <select
                className="walk-select"
                value={crWhIndex}
                onChange={e => setCrWhIndex(parseInt(e.target.value))}
              >
                {warehouses.map((wh, i) => (
                  <option key={wh.code} value={i}>{wh.code} — {wh.name}</option>
                ))}
              </select>
            </div>

            <div className="walk-form-field">
              <label>Rack ID</label>
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

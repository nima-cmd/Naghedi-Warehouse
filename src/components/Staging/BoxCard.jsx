import { useState, useMemo } from 'react'

// Detail card for a single staging box.
// Shown in a slide-in panel when a box is selected in the box list or 3D canvas.

export default function BoxCard({ box, netsuiteItems, poLocations = {}, onClose, onUpdateBox, onPrintLabel }) {
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  if (!box) return null

  const hasSkuIssue  = box.issues.includes('SKU_NOT_FOUND')
  const hasDimsIssue = box.issues.includes('DIMS_MISSING')
  const hasMultiPO   = box.issues.includes('MULTI_PO')
  const isMultiSku   = (box.skus?.length ?? 0) > 1
  const effectiveSku = box.skuOverride ?? box.sku

  // Autocomplete: search netsuiteItems by style prefix or name
  const suggestions = useMemo(() => {
    const q = searchQuery.trim().toUpperCase()
    if (!q || !netsuiteItems?.itemsBySku) return []
    return Object.entries(netsuiteItems.itemsBySku)
      .filter(([sku, item]) =>
        sku.toUpperCase().includes(q) ||
        (item.name || '').toUpperCase().includes(q)
      )
      .slice(0, 10)
      .map(([sku, item]) => ({ sku, name: item.name }))
  }, [searchQuery, netsuiteItems])

  const handleOverrideSku = (sku) => {
    const trimmed = sku.trim().toUpperCase()
    if (!trimmed) return
    onUpdateBox(box.id, { skuOverride: trimmed })
    setShowSearch(false)
    setSearchQuery('')
  }

  const handleClearOverride = () => {
    onUpdateBox(box.id, { skuOverride: null })
  }

  const labelBoxObj = {
    id:    box.id,
    binId: box.binId,
    skus:  box.skus.map((s, i) => ({ id: `${box.id}_${i}`, sku: s.sku, qty: s.qty })),
  }

  return (
    <div className="box-card">
      <div className="box-card-header">
        <span className="box-card-bin-id">{box.binId}</span>
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="box-card-body">

        {/* Issues */}
        {(hasSkuIssue || hasDimsIssue || hasMultiPO) && (
          <div className="box-card-issues">
            {hasMultiPO && (
              <div className="box-card-issue multi-po">
                <div className="multi-po-title">⊘ Multi-PO Carton — Clarification Needed</div>
                <p className="multi-po-desc">
                  This physical carton contains items committed to{' '}
                  <strong>{box.multiPOs?.length ?? 2} different POs</strong>:{' '}
                  {box.multiPOs?.map((po, i) => (
                    <span key={po}>
                      {i > 0 && ' and '}
                      <span className="multi-po-po-chip">{po}</span>
                    </span>
                  ))}
                </p>
                <div className="multi-po-sku-breakdown">
                  {box.multiPOs?.map(po => {
                    const poSkus = box.skus?.filter(s => (s.poNumber ?? box.poNumber) === po)
                    if (!poSkus?.length) return null
                    return (
                      <div key={po} className="multi-po-po-group">
                        <span className="multi-po-po-label">PO {po}</span>
                        {poSkus.map((s, i) => (
                          <span key={i} className="multi-po-sku-entry">{s.sku} × {s.qty}</span>
                        ))}
                      </div>
                    )
                  })}
                </div>
                <p className="multi-po-hint">
                  The export generator will automatically route each item to the correct PO's
                  Item Receipt. Verify the breakdown above matches your packing list before importing.
                </p>
              </div>
            )}
            {hasSkuIssue  && <div className="box-card-issue warn">⚠ SKU not found in catalog</div>}
            {hasDimsIssue && <div className="box-card-issue err">● Box dimensions missing</div>}
          </div>
        )}

        {/* Location info */}
        <div className="section-label">Bin</div>
        <div className="stat-group">
          <label>Bin ID</label>
          <span className="stat-value" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{box.binId}</span>
        </div>
        <div className="stat-group">
          <label>Carton No.</label>
          <span className="stat-value">{box.cartonId}</span>
        </div>
        {box.poNumber && (
          <div className="stat-group">
            <label>PO Number</label>
            <span className="stat-value">{box.poNumber}</span>
          </div>
        )}
        {box.poNumber && poLocations[box.poNumber]?.location && (
          <div className="stat-group">
            <label>Destination</label>
            <span className="stat-value" style={{ color: '#27ae60', fontWeight: 600 }}>
              {poLocations[box.poNumber].location}
            </span>
          </div>
        )}
        {box.poDescription && (
          <div className="stat-group">
            <label>Order</label>
            <span className="stat-value" style={{ fontSize: 11 }}>{box.poDescription}</span>
          </div>
        )}

        <div className="section-divider" />

        {/* SKU info */}
        <div className="section-label">SKU</div>

        {isMultiSku ? (
          <div>
            <p className="form-hint">Mixed carton — {box.skus.length} items:</p>
            <div className="box-sku-list">
              {box.skus.map((s, i) => (
                <div key={i} className="box-sku-entry">
                  <span className="sku-code">{s.sku}</span>
                  <span className="box-sku-qty">{s.qty} units</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="stat-group">
              <label>Constructed SKU</label>
              <span className="stat-value" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                {box.sku ?? '—'}
              </span>
            </div>
            {box.skuOverride && (
              <div className="stat-group">
                <label>Override SKU</label>
                <span className="stat-value" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#27ae60' }}>
                  {box.skuOverride}
                </span>
              </div>
            )}
          </>
        )}

        {/* SKU name from catalog */}
        {effectiveSku && netsuiteItems?.itemsBySku?.[effectiveSku] && (
          <p className="form-hint" style={{ marginTop: 4 }}>
            {netsuiteItems.itemsBySku[effectiveSku].name}
          </p>
        )}

        {/* Override control */}
        {hasSkuIssue && !isMultiSku && (
          <div style={{ marginTop: 8 }}>
            {!showSearch ? (
              <button
                className="btn-secondary"
                style={{ fontSize: 11, padding: '4px 10px', width: 'auto' }}
                onClick={() => { setShowSearch(true); setSearchQuery(box.sku ?? '') }}
              >
                Override SKU
              </button>
            ) : (
              <div>
                <input
                  className="form-input"
                  style={{ marginBottom: 4, fontSize: 11 }}
                  placeholder="Search SKU or product name…"
                  value={searchQuery}
                  autoFocus
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {suggestions.length > 0 && (
                  <div className="sku-suggestions">
                    {suggestions.map(s => (
                      <div
                        key={s.sku}
                        className="sku-suggestion-item"
                        onMouseDown={e => { e.preventDefault(); handleOverrideSku(s.sku) }}
                      >
                        <span className="suggestion-sku">{s.sku}</span>
                        {s.name && <span className="suggestion-name">{s.name}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="sku-add-row" style={{ marginTop: 4 }}>
                  <button
                    className="btn-primary"
                    style={{ fontSize: 11 }}
                    onClick={() => handleOverrideSku(searchQuery)}
                  >
                    Apply Override
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 11 }}
                    onClick={() => { setShowSearch(false); setSearchQuery('') }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {box.skuOverride && (
              <button
                className="btn-secondary"
                style={{ fontSize: 11, padding: '4px 10px', width: 'auto', marginLeft: 6 }}
                onClick={handleClearOverride}
              >
                Clear Override
              </button>
            )}
          </div>
        )}

        <div className="section-divider" />

        {/* Dimensions */}
        <div className="section-label">Dimensions</div>
        {box.dimsCm ? (
          <>
            <div className="stat-group">
              <label>CM (L × W × H)</label>
              <span className="stat-value">{box.dimsCm.l} × {box.dimsCm.w} × {box.dimsCm.h}</span>
            </div>
            <div className="stat-group">
              <label>Inches (L × W × H)</label>
              <span className="stat-value">{box.dimsIn.l}" × {box.dimsIn.w}" × {box.dimsIn.h}"</span>
            </div>
          </>
        ) : (
          <p className="form-hint" style={{ color: '#e74c3c' }}>Dimensions not found in packing slip.</p>
        )}

        <div className="section-divider" />

        {/* Actions */}
        <button
          className="btn-primary"
          style={{ marginBottom: 8 }}
          onClick={() => onPrintLabel?.(labelBoxObj)}
        >
          Print Bin Label
        </button>

        <div className="stat-group">
          <label>Qty per carton</label>
          <span className="stat-value">{box.qty} units</span>
        </div>
      </div>
    </div>
  )
}

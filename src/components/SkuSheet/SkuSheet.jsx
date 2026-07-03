import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import './SkuSheet.css'

// Bag-style SKUs are flat, no dashes: 1-3 letters + 4-6 digits + 2-letter color code
// (e.g. SN03013PN). Shoe/dash-style SKUs use STYLE-COLOR(-SIZE) instead.
// Falls back to the full SKU as its own group when neither pattern matches.
function styleGroupKey(sku) {
  const flat = sku.match(/^([A-Z]{1,3}\d{4,6})[A-Z]{2}$/)
  if (flat) return flat[1]
  const dash = sku.split('-')
  if (dash.length >= 2) return dash[0]
  return sku
}

// Printable master reference sheet — every in-stock SKU with a scannable QR code,
// grouped by style and sorted by color, so a phone camera scan (already wired into
// Walk Mode's Add SKU form) can fill in a SKU in one tap instead of typing it.
export default function SkuSheet({ skuCatalog, onClose }) {
  const [search, setSearch] = useState('')
  const [qrBySku, setQrBySku] = useState({})

  const groups = useMemo(() => {
    const inStock = Object.entries(skuCatalog ?? {}).filter(([, v]) => (v?.qty ?? 0) > 0)
    const byGroup = {}
    for (const [sku, v] of inStock) {
      const key = styleGroupKey(sku)
      ;(byGroup[key] ??= []).push({ sku, name: v.name ?? '', qty: v.qty ?? 0 })
    }
    for (const key of Object.keys(byGroup)) {
      byGroup[key].sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku))
    }
    return Object.entries(byGroup).sort(([a], [b]) => a.localeCompare(b))
  }, [skuCatalog])

  const filteredGroups = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return groups
    return groups
      .map(([key, items]) => [key, items.filter(i => i.sku.includes(q) || i.name.toUpperCase().includes(q))])
      .filter(([key, items]) => items.length > 0 || key.includes(q))
  }, [groups, search])

  const totalSkus = useMemo(() => groups.reduce((s, [, items]) => s + items.length, 0), [groups])

  // Still missing a QR for at least one in-stock SKU — drives the Print button's disabled state
  const generating = useMemo(
    () => groups.some(([, items]) => items.some(i => !qrBySku[i.sku])),
    [groups, qrBySku]
  )

  // Generate any QR codes not already cached, so printing doesn't race image loads.
  // Skips SKUs already in qrBySku (e.g. re-opening the sheet without a new catalog import).
  useEffect(() => {
    let cancelled = false
    const missing = groups.flatMap(([, items]) => items.map(i => i.sku)).filter(sku => !qrBySku[sku])
    if (missing.length === 0) return
    Promise.all(missing.map(sku =>
      QRCode.toDataURL(sku, { width: 160, margin: 0, errorCorrectionLevel: 'M' }).then(src => [sku, src])
    )).then(pairs => {
      if (cancelled) return
      setQrBySku(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
    }).catch(console.error)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes qrBySku to avoid re-running once populated
  }, [groups])

  const handlePrint = () => window.print()

  return (
    <div className="sheet-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="sheet-shell">

        <div className="sheet-controls no-print">
          <div className="sheet-controls-title">
            SKU Master Sheet — {totalSkus.toLocaleString()} in-stock SKUs · {groups.length} styles
          </div>
          <div className="sheet-controls-actions">
            <input
              className="sheet-search"
              placeholder="Filter by SKU or color…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button className="btn-primary" style={{ width: 'auto', padding: '7px 18px' }} onClick={handlePrint} disabled={generating}>
              {generating ? 'Generating…' : 'Print'}
            </button>
            <button className="btn-secondary" style={{ width: 'auto', padding: '7px 14px' }} onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="sku-sheet" id="sku-sheet-print">
          <div className="sheet-header no-print-border">
            <div className="sheet-title">Naghedi — SKU Master Sheet</div>
            <div className="sheet-subtitle">
              {totalSkus.toLocaleString()} in-stock SKUs across {groups.length} styles · generated {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
            <div className="sheet-index">
              {groups.map(([key]) => key).join(' · ')}
            </div>
          </div>

          {filteredGroups.length === 0 && (
            <div className="sheet-empty">No in-stock SKUs match "{search}".</div>
          )}

          {filteredGroups.map(([key, items]) => (
            <div className="sku-group" key={key}>
              <div className="sku-group-header">{key}</div>
              <div className="sku-grid">
                {items.map(item => (
                  <div className="sku-card" key={item.sku}>
                    {qrBySku[item.sku] && <img className="sku-card-qr" src={qrBySku[item.sku]} alt="" />}
                    <div className="sku-card-info">
                      <div className="sku-card-code">{item.sku}</div>
                      <div className="sku-card-name">{item.name || '—'}</div>
                      <div className="sku-card-qty">{item.qty.toLocaleString()} in stock</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}

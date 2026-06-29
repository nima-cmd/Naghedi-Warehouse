import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import './BinLabel.css'

// 4×6 thermal label for a bin.
// The QR code encodes the bin ID so the in-app camera scan selects it directly.
// Call onPrinted() after window.print() so the bin's labelPrintedAt is stamped.
function BinLabel({ bin, rack, skuCatalog, onClose, onPrinted }) {
  const [qrSrc, setQrSrc] = useState('')

  useEffect(() => {
    if (!bin?.binId) return
    QRCode.toDataURL(bin.binId, {
      width:         320,
      margin:        1,
      color:         { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setQrSrc).catch(console.error)
  }, [bin?.binId])

  const handlePrint = () => {
    window.print()
    onPrinted?.()
  }

  if (!bin) return null

  const skus       = bin.skus ?? []
  const bw         = bin.binW ?? rack?.binW ?? 2
  const bd         = bin.binD ?? rack?.binD ?? (4/3)
  const bh         = bin.binH ?? rack?.binH ?? (17/12)
  const toIn       = v => Math.ceil(v * 12)   // feet → whole inches, rounded up

  return (
    <div className="label-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="label-shell">

        {/* ── Screen controls (hidden when printing) ── */}
        <div className="label-controls no-print">
          <span className="label-controls-title">Label Preview — {bin.binId}</span>
          <div className="label-controls-actions">
            <button className="btn-primary" style={{ width: 'auto', padding: '7px 18px' }} onClick={handlePrint}>
              Print
            </button>
            <button className="btn-secondary" style={{ width: 'auto', padding: '7px 14px' }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {/* ── The actual 4×6 label (print target) ── */}
        <div className="bin-label" id="bin-label-print">
          {/* Top row: QR code + location */}
          <div className="label-top">
            {qrSrc && <img className="label-qr" src={qrSrc} alt="QR" />}
            <div className="label-location">
              <div className="label-bin-id">{bin.binId}</div>
              {rack && (
                <>
                  <div className="label-rack">Rack: {rack.rackId}</div>
                  <div className="label-pos">
                    Col {String.fromCharCode(65 + bin.col)} · Level {bin.row + 1}
                  </div>
                </>
              )}
              <div className="label-dims">
                {toIn(bw)}" W × {toIn(bd)}" D × {toIn(bh)}" H
              </div>
            </div>
          </div>

          <div className="label-divider" />

          {/* Contents */}
          <div className="label-contents-header">Contents</div>
          {skus.length === 0 ? (
            <div className="label-empty">No SKUs assigned</div>
          ) : (
            <table className="label-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Qty</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {skus.map(entry => (
                  <tr key={entry.id}>
                    <td className="label-sku">{entry.sku}</td>
                    <td className="label-qty">×{entry.qty}</td>
                    <td className="label-name">{skuCatalog?.[entry.sku]?.name ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="label-footer">
            Naghedi NYC · {bin.binId} · Printed {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        </div>

      </div>
    </div>
  )
}

export default BinLabel

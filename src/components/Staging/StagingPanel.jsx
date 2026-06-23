import { useState, useEffect } from 'react'
import { parsePackingSlip, validateContainer } from '../../services/packingSlip'
import { parseNetsuiteItemsCsv, saveNetsuiteItems } from '../../services/netsuiteItems'
import BinLabel from '../BinLabel/BinLabel'
import BoxCard from './BoxCard'
import StagingCanvas from './StagingCanvas'

const fmtDate = (iso) => {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

function issueSummary(boxes) {
  const skuBad  = boxes.filter(b => b.issues.includes('SKU_NOT_FOUND')).length
  const dimsBad = boxes.filter(b => b.issues.includes('DIMS_MISSING')).length
  const valid   = boxes.length - skuBad - dimsBad
  return { skuBad, dimsBad, valid }
}

function StagingPanel({
  containers,
  netsuiteItems,
  netsuiteUpdatedAt,
  onImportContainer,
  onUpdateBox,
  onDeleteContainer,
  onNetsuiteItemsUpdated,
}) {
  const [selectedId, setSelectedId]   = useState(null)
  const [selectedBoxId, setSelectedBoxId] = useState(null)
  const [labelBox, setLabelBox]       = useState(null)
  const [importError, setImportError] = useState(null)
  const [view3D, setView3D]           = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  // Auto-select first container
  useEffect(() => {
    if (containers.length > 0 && !selectedId) setSelectedId(containers[0].id)
  }, [containers, selectedId])

  const selectedContainer = containers.find(c => c.id === selectedId) ?? null
  const selectedBox = selectedContainer?.boxes.find(b => b.id === selectedBoxId) ?? null

  // ── File handlers ──────────────────────────────────────────────────────────

  const handleSlipFile = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)

    // Prompt for container number
    const containerNum = window.prompt('Enter the container number (e.g. 264):')
    if (!containerNum) return

    try {
      let parsed
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = await file.text()
        parsed = parsePackingSlip(text, { containerNum: containerNum.trim() })
      } else {
        // XLSX
        const buf = await file.arrayBuffer()
        parsed = parsePackingSlip(buf, { containerNum: containerNum.trim() })
      }

      // Post-parse SKU validation against loaded catalog
      const validated = validateContainer(parsed, netsuiteItems)
      onImportContainer(validated)
      setSelectedId(validated.id)
    } catch (err) {
      setImportError(err.message)
    }
  }

  const handleItemsFile = (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const { itemsBySku, styleColorIndex } = parseNetsuiteItemsCsv(ev.target.result)
        const ts = saveNetsuiteItems(itemsBySku, styleColorIndex)
        onNetsuiteItemsUpdated({ itemsBySku, styleColorIndex, updatedAt: ts })
      } catch (err) {
        setImportError(err.message)
      }
    }
    reader.readAsText(file)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const itemCount = Object.keys(netsuiteItems?.itemsBySku ?? {}).length

  return (
    <div className="staging-layout">

      {/* ── Header bar ── */}
      <div className="staging-header">
        <div className="staging-header-left">
          <label className="btn-primary staging-import-btn">
            + Import Packing Slip
            <input type="file" hidden accept=".csv,.xlsx,.xls" onChange={handleSlipFile} />
          </label>
          {importError && (
            <span className="staging-error">{importError}</span>
          )}
        </div>
        <div className="staging-header-right">
          <label className="btn-secondary staging-import-btn" style={{ fontSize: 11 }}>
            {itemCount > 0
              ? `↻ Items (${itemCount.toLocaleString()})`
              : '↑ Import NetSuite Items'}
            <input type="file" hidden accept=".csv" onChange={handleItemsFile} />
          </label>
          {netsuiteUpdatedAt && (
            <span className="staging-ts">Updated {fmtDate(netsuiteUpdatedAt)}</span>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="staging-body">

        {/* Left: container list */}
        <div className="staging-sidebar">
          <div className="staging-sidebar-label">CONTAINERS</div>
          {containers.length === 0 && (
            <p className="staging-empty">No containers imported yet.<br/>Import a packing slip to get started.</p>
          )}
          {containers.map(cnt => {
            const { skuBad, dimsBad } = issueSummary(cnt.boxes)
            const hasIssues = skuBad + dimsBad > 0
            return (
              <div
                key={cnt.id}
                className={`staging-cnt-item${cnt.id === selectedId ? ' selected' : ''}`}
                onClick={() => { setSelectedId(cnt.id); setSelectedBoxId(null) }}
              >
                <div className="staging-cnt-num">{cnt.containerNum}</div>
                <div className="staging-cnt-meta">
                  {cnt.poNumber && <span className="staging-cnt-po">{cnt.poNumber}</span>}
                  <div className="staging-cnt-badges">
                    <span className="staging-cnt-count">{cnt.boxCount} boxes</span>
                    {hasIssues && (
                      <span className="staging-issue-dot" title={`${skuBad} SKU issues, ${dimsBad} dims missing`}>⚠</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Right: container detail */}
        <div className="staging-detail">
          {!selectedContainer ? (
            <div className="staging-empty staging-empty-center">
              {containers.length === 0
                ? 'Import a packing slip using the button above.'
                : 'Select a container on the left.'}
            </div>
          ) : (
            <>
              {/* Container detail header */}
              <div className="staging-detail-header">
                <div className="staging-detail-title">
                  <span className="staging-detail-num">Container {selectedContainer.containerNum}</span>
                  {selectedContainer.poNumber && (
                    <span className="staging-detail-po">{selectedContainer.poNumber}</span>
                  )}
                </div>
                <div className="staging-detail-actions">
                  <button
                    className={`btn-secondary staging-view-toggle${view3D ? ' active' : ''}`}
                    onClick={() => setView3D(v => !v)}
                    title="Toggle 3D view"
                  >
                    {view3D ? '≡ List' : '⬛ 3D'}
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ borderColor: '#c0392b', color: '#c0392b', fontSize: 11, padding: '4px 8px' }}
                    onClick={() => setConfirmDeleteId(selectedContainer.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Issue summary bar */}
              {(() => {
                const { skuBad, dimsBad, valid } = issueSummary(selectedContainer.boxes)
                return (
                  <div className="staging-issue-bar">
                    <span className="staging-issue-stat ok">✓ {valid} valid</span>
                    {skuBad > 0 && (
                      <span className="staging-issue-stat warn">⚠ {skuBad} SKU unmatched</span>
                    )}
                    {dimsBad > 0 && (
                      <span className="staging-issue-stat err">● {dimsBad} dims missing</span>
                    )}
                    {itemCount === 0 && (
                      <span className="staging-issue-stat info">Import NetSuite Items to validate SKUs</span>
                    )}
                  </div>
                )
              })()}

              {/* 3D canvas or list view */}
              {view3D ? (
                <StagingCanvas
                  boxes={selectedContainer.boxes}
                  onSelectBox={(box) => setSelectedBoxId(box?.id ?? null)}
                  selectedBoxId={selectedBoxId}
                />
              ) : (
                <BoxList
                  boxes={selectedContainer.boxes}
                  selectedBoxId={selectedBoxId}
                  onSelectBox={(id) => setSelectedBoxId(id)}
                  onPrintLabel={(box) => {
                    setLabelBox({
                      id:    box.id,
                      binId: box.binId,
                      skus:  box.skus.map((s, i) => ({ id: `${box.id}_${i}`, sku: s.sku, qty: s.qty })),
                    })
                  }}
                />
              )}
            </>
          )}
        </div>

        {/* Box detail card (slides in from right) */}
        {selectedBox && (
          <BoxCard
            box={selectedBox}
            netsuiteItems={netsuiteItems}
            onClose={() => setSelectedBoxId(null)}
            onUpdateBox={(boxId, updates) => onUpdateBox(selectedContainer.id, boxId, updates)}
            onPrintLabel={(box) => {
              setLabelBox({
                id:    box.id,
                binId: box.binId,
                skus:  box.skus.map((s, i) => ({ id: `${box.id}_${i}`, sku: s.sku, qty: s.qty })),
              })
            }}
          />
        )}
      </div>

      {/* Confirm delete modal */}
      {confirmDeleteId && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Delete this container?</h3>
            <p>Container {containers.find(c => c.id === confirmDeleteId)?.containerNum} and all its box data will be removed.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => {
                onDeleteContainer(confirmDeleteId)
                if (selectedId === confirmDeleteId) setSelectedId(null)
                setConfirmDeleteId(null)
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Bin label print modal — reuses existing BinLabel component */}
      {labelBox && (
        <BinLabel
          bin={labelBox}
          rack={null}
          skuCatalog={{}}
          onClose={() => setLabelBox(null)}
          onPrinted={() => setLabelBox(null)}
        />
      )}
    </div>
  )
}

// ── Box list (inline, not exported) ──────────────────────────────────────────

function BoxList({ boxes, selectedBoxId, onSelectBox, onPrintLabel }) {
  if (boxes.length === 0) {
    return <p className="staging-empty" style={{ padding: 16 }}>No boxes found in this container.</p>
  }

  return (
    <div className="box-list">
      {boxes.map(box => {
        const hasSkuIssue  = box.issues.includes('SKU_NOT_FOUND')
        const hasDimsIssue = box.issues.includes('DIMS_MISSING')
        const isMultiSku   = box.issues.includes('MULTI_SKU')
        const isSelected   = box.id === selectedBoxId

        const primarySku = box.skuOverride ?? box.sku
          ?? (box.skus?.[0]?.sku ?? null)

        return (
          <div
            key={box.id}
            className={[
              'box-item',
              isSelected     ? 'selected'   : '',
              hasSkuIssue    ? 'issue-sku'  : '',
              hasDimsIssue   ? 'issue-dims' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelectBox(isSelected ? null : box.id)}
          >
            <div className="box-item-row">
              <span className="box-bin-id">{box.binId}</span>
              <div className="box-item-badges">
                {hasSkuIssue  && <span className="issue-badge warn">SKU?</span>}
                {hasDimsIssue && <span className="issue-badge err">DIMS?</span>}
                {isMultiSku   && <span className="issue-badge info">MULTI</span>}
              </div>
              <button
                className="box-print-btn"
                title="Print label"
                onClick={e => { e.stopPropagation(); onPrintLabel(box) }}
              >
                ⬒
              </button>
            </div>
            <div className="box-item-meta">
              <span className="box-sku">{primarySku ?? '—'}</span>
              <span className="box-qty">{box.qty} units</span>
              {box.dimsCm && (
                <span className="box-dims">
                  {box.dimsCm.l}×{box.dimsCm.w}×{box.dimsCm.h} cm
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default StagingPanel

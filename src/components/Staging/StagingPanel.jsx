import { useState, useEffect, useMemo } from 'react'
import { parsePackingSlip, validateContainer } from '../../services/packingSlip'
import BinLabel from '../BinLabel/BinLabel'
import BoxCard from './BoxCard'
import StagingCanvas from './StagingCanvas'

// Convert a staging box's physical dimensions to the feet-based format BinLabel expects.
// dimsIn is already ceil'd to whole inches; dividing by 12 gives feet for BinLabel.
function boxLabelDims(box) {
  if (box.dimsIn) {
    return { binW: box.dimsIn.l / 12, binD: box.dimsIn.w / 12, binH: box.dimsIn.h / 12 }
  }
  if (box.dimsCm) {
    return {
      binW: Math.ceil(box.dimsCm.l / 2.54) / 12,
      binD: Math.ceil(box.dimsCm.w / 2.54) / 12,
      binH: Math.ceil(box.dimsCm.h / 2.54) / 12,
    }
  }
  return {}
}

function issueSummary(boxes) {
  const skuBad  = boxes.filter(b => b.issues.includes('SKU_NOT_FOUND')).length
  const dimsBad = boxes.filter(b => b.issues.includes('DIMS_MISSING')).length
  const multiPO = boxes.filter(b => b.issues.includes('MULTI_PO')).length
  const valid   = boxes.filter(b => b.issues.length === 0).length
  return { skuBad, dimsBad, multiPO, valid }
}

function StagingPanel({
  containers,
  netsuiteItems,
  onImportContainer,
  onUpdateContainer,
  onUpdateBox,
  onDeleteContainer,
  onReceiveContainer,
  onSyncToAirtable,
  syncStatus = 'idle',
  syncError = null,
  onImportPOCsv,
  poImportStatus = 'idle',
  poImportError = null,
  poImportResult = null,
  onExportInventoryTransfer,
  hasPOLocations = false,
  poLocations = {},
}) {
  const [selectedId, setSelectedId]   = useState(null)
  const [selectedBoxId, setSelectedBoxId] = useState(null)
  const [labelBox, setLabelBox]       = useState(null)
  const [importError, setImportError] = useState(null)
  const [view3D, setView3D]           = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedPO, setFocusedPO]     = useState(null)

  // Auto-select first container
  useEffect(() => {
    if (containers.length > 0 && !selectedId) setSelectedId(containers[0].id)
  }, [containers, selectedId])

  // Reset focused PO when switching containers
  useEffect(() => { setFocusedPO(null) }, [selectedId])

  const selectedContainer = containers.find(c => c.id === selectedId) ?? null
  const selectedBox = selectedContainer?.boxes.find(b => b.id === selectedBoxId) ?? null

  const filteredBoxes = useMemo(() => {
    const all = selectedContainer?.boxes ?? []
    const q = searchQuery.trim().toUpperCase()
    if (!q) return all
    return all.filter(box => {
      if ((box.poNumber ?? '').toUpperCase().includes(q)) return true
      if ((box.skuOverride ?? box.sku ?? '').toUpperCase().includes(q)) return true
      if (box.skus?.some(s => s.sku?.toUpperCase().includes(q))) return true
      return false
    })
  }, [selectedContainer?.boxes, searchQuery])

  // ── File handlers ──────────────────────────────────────────────────────────

  const handlePOFile = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || !onImportPOCsv) return
    onImportPOCsv(await file.text())
  }

  const handleSlipFile = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)

    const containerNum = window.prompt('Enter the shipping container number (e.g. 264):')
    if (!containerNum?.trim()) return

    // Date is metadata only — it never appears in the bin ID.
    // It makes the container record unique so two imports of "264" on different days coexist.
    const today = new Date().toLocaleDateString('en-CA')  // YYYY-MM-DD
    const rawDate = window.prompt('Enter arrival / import date (leave blank for today):', today)
    if (rawDate === null) return  // user pressed Cancel
    const containerDate = rawDate.trim() || today

    try {
      const opts = { containerNum: containerNum.trim(), containerDate }
      let parsed
      if (file.name.toLowerCase().endsWith('.csv')) {
        parsed = parsePackingSlip(await file.text(), opts)
      } else {
        parsed = parsePackingSlip(await file.arrayBuffer(), opts)
      }

      const validated = validateContainer(parsed, netsuiteItems)
      onImportContainer(validated)
      setSelectedId(validated.id)
    } catch (err) {
      setImportError(err.message)
    }
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
          {/* PO Warehouse View CSV import */}
          {onImportPOCsv && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <label
                className="btn-secondary staging-import-btn"
                style={{
                  fontSize: 11, cursor: poImportStatus === 'importing' ? 'wait' : 'pointer',
                  color:       poImportStatus === 'done'  ? '#27ae60' : poImportStatus === 'error' ? '#c0392b' : undefined,
                  borderColor: poImportStatus === 'done'  ? '#27ae60' : poImportStatus === 'error' ? '#c0392b' : undefined,
                  opacity:     poImportStatus === 'importing' ? 0.6 : 1,
                  pointerEvents: poImportStatus === 'importing' ? 'none' : 'auto',
                }}
              >
                {poImportStatus === 'importing' ? 'Importing POs…'
                  : poImportStatus === 'done'    ? `✓ ${poImportResult?.poCount ?? ''} POs Imported`
                  : poImportStatus === 'error'   ? '✗ PO Import Failed'
                  : '↑ Import PO CSV'}
                <input type="file" hidden accept=".csv" onChange={handlePOFile} />
              </label>
              {poImportStatus === 'error' && poImportError && (
                <span style={{ fontSize: 10, color: '#c0392b', maxWidth: 240, textAlign: 'right', lineHeight: 1.3 }}>
                  {poImportError}
                </span>
              )}
              {poImportStatus === 'done' && poImportResult && (
                <span style={{ fontSize: 10, color: '#27ae60', textAlign: 'right' }}>
                  {poImportResult.lineCount} lines synced to Airtable
                </span>
              )}
            </div>
          )}
          {onSyncToAirtable && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <button
                className="btn-secondary staging-import-btn"
                style={{
                  fontSize: 11,
                  color: syncStatus === 'done' ? '#27ae60' : syncStatus === 'error' ? '#c0392b' : undefined,
                  borderColor: syncStatus === 'done' ? '#27ae60' : syncStatus === 'error' ? '#c0392b' : undefined,
                }}
                onClick={onSyncToAirtable}
                disabled={syncStatus === 'syncing'}
              >
                {syncStatus === 'syncing' ? 'Syncing…'
                  : syncStatus === 'done'    ? '✓ Synced'
                  : syncStatus === 'error'   ? '✗ Sync Failed'
                  : '↑ Sync to Airtable'}
              </button>
              {syncStatus === 'error' && syncError && (
                <span style={{ fontSize: 10, color: '#c0392b', maxWidth: 260, textAlign: 'right', lineHeight: 1.3 }}>
                  {syncError}
                </span>
              )}
            </div>
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
            const { skuBad, dimsBad, multiPO } = issueSummary(cnt.boxes)
            const hasIssues = skuBad + dimsBad + multiPO > 0
            return (
              <div
                key={cnt.id}
                className={`staging-cnt-item${cnt.id === selectedId ? ' selected' : ''}`}
                onClick={() => { setSelectedId(cnt.id); setSelectedBoxId(null) }}
              >
                <div className="staging-cnt-num">
                  {cnt.containerNum}
                  {cnt.containerDate && <span className="staging-cnt-date">{cnt.containerDate}</span>}
                </div>
                <div className="staging-cnt-meta">
                  {cnt.poNumbers?.length > 0 && <span className="staging-cnt-po">{cnt.poNumbers.join(', ')}</span>}
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
                  {selectedContainer.containerDate && (
                    <span className="staging-detail-date">{selectedContainer.containerDate}</span>
                  )}
                  {selectedContainer.poNumbers?.length > 0 && (
                    <span className="staging-detail-po">
                      {selectedContainer.poNumbers.map((po, i) => (
                        <span key={po}>
                          {i > 0 && <span style={{ opacity: 0.4 }}> · </span>}
                          <span
                            className={`staging-po-chip${focusedPO === po ? ' active' : ''}`}
                            title="Click to focus in 3D view"
                            onClick={() => { setView3D(true); setFocusedPO(prev => prev === po ? null : po) }}
                          >
                            {po}
                          </span>
                        </span>
                      ))}
                    </span>
                  )}
                  {/* Item Receipt / Transfer Order override fields */}
                  <span className="staging-ir-to">
                    <input
                      className="staging-ir-input"
                      placeholder="IR number"
                      value={selectedContainer.itemReceiptNum ?? ''}
                      onChange={e => onUpdateContainer?.(selectedContainer.id, { itemReceiptNum: e.target.value || null })}
                      title="NetSuite Item Receipt number (e.g. IR12345)"
                    />
                    <input
                      className="staging-ir-input"
                      placeholder="TO number"
                      value={selectedContainer.transferOrderNum ?? ''}
                      onChange={e => onUpdateContainer?.(selectedContainer.id, { transferOrderNum: e.target.value || null })}
                      title="NetSuite Transfer Order number (e.g. TO67890)"
                    />
                  </span>
                </div>
                <div className="staging-detail-actions">
                  <button
                    className={`btn-secondary staging-view-toggle${view3D ? ' active' : ''}`}
                    onClick={() => setView3D(v => !v)}
                    title="Toggle 3D view"
                  >
                    {view3D ? '≡ List' : '⬛ 3D'}
                  </button>
                  {onExportInventoryTransfer && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      title={hasPOLocations
                        ? 'Download Item Receipt + Transfer Order CSVs for NetSuite import'
                        : 'Import PO CSV first to get destination locations for Transfer Orders'}
                      onClick={() => onExportInventoryTransfer(selectedContainer)}
                    >
                      ↓ Export to NetSuite
                    </button>
                  )}
                  <button
                    className="btn-primary"
                    style={{ fontSize: 11, padding: '4px 10px', width: 'auto', background: '#27ae60', borderColor: '#27ae60' }}
                    onClick={() => {
                      if (window.confirm(
                        `Receive container ${selectedContainer.containerNum} into warehouse?\n\n` +
                        `This will create ${selectedContainer.boxCount} unassigned bins in the warehouse tab ` +
                        `and remove the container from staging.`
                      )) {
                        onReceiveContainer?.(selectedContainer.id)
                      }
                    }}
                  >
                    ✓ Receive
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
                const { skuBad, dimsBad, multiPO, valid } = issueSummary(selectedContainer.boxes)
                return (
                  <div className="staging-issue-bar">
                    <span className="staging-issue-stat ok">✓ {valid} valid</span>
                    {multiPO > 0 && (
                      <span className="staging-issue-stat crit">
                        ⊘ {multiPO} multi-PO carton{multiPO !== 1 ? 's' : ''} — needs clarification
                      </span>
                    )}
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

              {/* Search bar */}
              <div className="staging-search-bar">
                <input
                  type="text"
                  className="staging-search-input"
                  placeholder="Search by PO number or SKU…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="staging-search-clear" onClick={() => setSearchQuery('')}>✕</button>
                )}
                {searchQuery && (
                  <span className="staging-search-count">
                    {/^\d+$/.test(searchQuery.trim())
                      ? `${filteredBoxes.length} box${filteredBoxes.length !== 1 ? 'es' : ''}`
                      : `${filteredBoxes.length} matched`}
                    {' '}/ {selectedContainer.boxes.length}
                  </span>
                )}
              </div>

              {/* 3D canvas or list view */}
              {view3D ? (
                <StagingCanvas
                  boxes={selectedContainer.boxes}
                  onSelectBox={(box) => setSelectedBoxId(box?.id ?? null)}
                  selectedBoxId={selectedBoxId}
                  searchQuery={searchQuery}
                  focusPO={focusedPO}
                />
              ) : (
                <BoxList
                  boxes={filteredBoxes}
                  selectedBoxId={selectedBoxId}
                  onSelectBox={(id) => setSelectedBoxId(id)}
                  onPrintLabel={(box) => {
                    setLabelBox({
                      id:    box.id,
                      binId: box.binId,
                      skus:  box.skus.map((s, i) => ({ id: `${box.id}_${i}`, sku: s.sku, qty: s.qty })),
                      ...boxLabelDims(box),
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
            poLocations={poLocations}
            onClose={() => setSelectedBoxId(null)}
            onUpdateBox={(boxId, updates) => onUpdateBox(selectedContainer.id, boxId, updates)}
            onPrintLabel={(box) => {
              setLabelBox({
                id:    box.id,
                binId: box.binId,
                skus:  box.skus.map((s, i) => ({ id: `${box.id}_${i}`, sku: s.sku, qty: s.qty })),
                ...boxLabelDims(box),
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
        const hasMultiPO   = box.issues.includes('MULTI_PO')
        const isSelected   = box.id === selectedBoxId

        const primarySku = box.skuOverride ?? box.sku
          ?? (box.skus?.[0]?.sku ?? null)

        return (
          <div
            key={box.id}
            className={[
              'box-item',
              isSelected   ? 'selected'       : '',
              hasMultiPO   ? 'issue-multi-po' : '',
              hasSkuIssue  ? 'issue-sku'      : '',
              hasDimsIssue ? 'issue-dims'     : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelectBox(isSelected ? null : box.id)}
          >
            <div className="box-item-row">
              <span className="box-bin-id">{box.binId}</span>
              <div className="box-item-badges">
                {hasMultiPO   && <span className="issue-badge crit">MULTI PO</span>}
                {hasSkuIssue  && <span className="issue-badge warn">SKU?</span>}
                {hasDimsIssue && <span className="issue-badge err">DIMS?</span>}
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
              <span className="box-sku">{primarySku ?? '—'}{box.skus?.length > 1 ? ` +${box.skus.length - 1}` : ''}</span>
              <span className="box-qty">{box.qty} units</span>
              {box.dimsCm && (
                <span className="box-dims">
                  {box.dimsCm.l}×{box.dimsCm.w}×{box.dimsCm.h} cm
                </span>
              )}
              {hasMultiPO
                ? <span className="box-po multi-po-label">PO {box.multiPOs?.join(' + ')}</span>
                : box.poNumber && <span className="box-po">PO {box.poNumber}</span>
              }
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default StagingPanel

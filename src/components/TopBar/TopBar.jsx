function TopBar({ panelVisible, onTogglePanel, saveStatus, saveError, isDirty, onSave, onUndo, canUndo, undoCount = 0 }) {
  const isBusy = saveStatus === 'loading' || saveStatus === 'saving'

  const saveLabel =
    saveStatus === 'loading' ? '⟳ Loading…' :
    saveStatus === 'saving'  ? '⟳ Saving…'  :
    saveStatus === 'saved'   ? '✓ Saved'    :
    saveStatus === 'error'   ? '✕ Error'    :
    isDirty                  ? '● Save'     :
                               '○ Save'

  const saveClass =
    saveStatus === 'saved'  ? 'topbar-save saved'  :
    saveStatus === 'error'  ? 'topbar-save error'  :
    isDirty                 ? 'topbar-save dirty'  :
                              'topbar-save'

  return (
    <div className="topbar">
      <h1>Naghedi Warehouse Layout Editor</h1>
      <div className="topbar-actions">
        {saveStatus === 'error' && saveError && (
          <span className="topbar-error-msg" title={saveError}>
            {saveError.length > 60 ? saveError.slice(0, 57) + '…' : saveError}
          </span>
        )}
        <button
          className="topbar-undo"
          onClick={onUndo}
          disabled={!canUndo}
          title={canUndo ? `Undo last rack/bin change (${undoCount} available)` : 'Nothing to undo'}
        >
          ↶ Undo
        </button>
        <button
          className={saveClass}
          onClick={onSave}
          disabled={isBusy || (!isDirty && saveStatus === 'idle')}
          title={saveStatus === 'error' ? saveError : undefined}
        >
          {saveLabel}
        </button>
        <button onClick={onTogglePanel}>
          {panelVisible ? '◀ Hide Panel' : '▶ Show Panel'}
        </button>
      </div>
    </div>
  )
}

export default TopBar

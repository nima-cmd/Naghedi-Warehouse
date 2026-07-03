# Naghedi Warehouse Layout Editor

Browser-based 3D tool to map two physical warehouses (Main Bag Warehouse / `WH1`,
Shoe Warehouse / `WH2`), assign SKUs to bins, look up inventory, print labels,
and track staged/receiving orders. React 19 + Three.js + Vite, Airtable backend.

Base Airtable: `apppmmp5Bt5ohmlaF` ("Warehouse 3D"). Layout and SKU catalog are
each stored as a single JSON blob in the `Warehouse 3D` table (`Key` = `"layout"`
or `"catalog"`), not as normalized Airtable records — see `src/services/airtable.js`.
(There's also a `Bins`/`SKUs`/`BinContents` normalized schema in that same base
from `scripts/setup-airtable-schema.js` — it's unused by the app; ignore it.)

## ⚠️ Read before touching Airtable data

- **Catalog CSV imports (`Import NetSuite Quantities/Items CSV`) push to Airtable
  immediately on import** — there is no "unsaved changes" gate like the layout has.
  Never simulate/test a catalog import against the real base; it overwrites the
  real SKU catalog instantly. (This bit us once already this session.)
- **Rack/bin layout changes require a Save** (manual button, or the autosave
  below) before they reach Airtable — normal edits are safe to try locally.
- **Autosave**: layout changes save ~8s after you stop editing, and immediately
  if the tab is hidden/backgrounded (`App.jsx`, the effect right after
  `handleSave`). If you're testing edits against the real Airtable-connected app
  (not a fresh empty local state), assume autosave WILL fire within ~8s and push
  whatever's in state — don't leave test/junk data sitting dirty.
- **Autosave is guarded against mid-move saves** (`placingRack`/`placingGroup`/
  `placingRoom` block it) — this was NOT true earlier in the session and is how
  `WH1-R13` went missing: a rack gets pulled out of `racks` the moment you pick
  it up to move it, and if autosave fires before you click to drop it, that
  "rack missing" snapshot gets persisted. Root-caused and fixed; don't remove
  the guard. R13's bins survived as harmless orphans (empty, no SKU data) —
  126 orphaned bin records exist in the real Airtable base referencing rack ids
  that no longer exist. They're invisible/inert (nothing renders or reads
  orphaned bins) but haven't been cleaned up.
- **When testing rack/bin edits against the real Airtable-connected app**,
  install a fetch guard first to block writes (see any recent session
  transcript for the exact snippet — intercepts non-GET calls to
  `api.airtable.com` and rejects them) so autosave can't push test/throwaway
  data. Verify via Airtable directly afterward that nothing changed.

## Current warehouse mapping project (in progress)

Doing a fresh physical inventory count of the Main Bag Warehouse — walking the
floor, mapping racks/bins, and logging what's actually in each box. This is a
staging pass: capture now, reconcile against real NetSuite inventory later.
Real racks are height-adjustable (level counts can change later); column counts
are physically fixed. Racks are not uniform — some columns are shorter than others.

As of this writing: ~15-17 racks placed in WH1 (some still being organized into
proper rows/aisles — a single row of 16 racks doesn't fit the real 45×64 ft
footprint, so racks need to be arranged into multiple parallel rows with aisles,
not one long line). Catalog has ~2,423 in-stock SKUs imported; Items CSV has
~4,007 SKUs imported (separate reference dataset used for packing-slip SKU
validation — no qty field, don't confuse it with the Quantities catalog).

**WH1-R13 is missing** — went missing via the autosave-mid-move bug described
below (now fixed). Its rack metadata (position, cols/rows) is gone; recreate it
fresh next session (ask the user for real specs — don't guess). No SKU data was
lost, since none had been assigned yet.

**WH1-R15**: confirmed real (22 cartons long), not a typo. Recommended splitting
it into two 11-column racks placed side by side instead of one 22-column rack —
matches physical reality better (almost certainly two rack frames pushed
together, not one continuous 22-bay unit), keeps bin IDs sane (A-K instead of
A-V), and composes with the group-move/row-label feature to still treat both
halves as one unit when needed. Not done automatically — no "split rack" tool
was built (one-off action, manual resize-and-add-new is enough): shrink the
existing rack's cols to 11, add a new 11-col rack next to it, optionally apply
the same row label to both.

## Features built this session

- **Bin flag-for-review** (Walk Mode) — `flagged`/`flagNote` fields on bins,
  toggle button in bin detail, a "Needs Review" list on the Walk Mode home
  screen. Packing-slip issues (`DIMS_MISSING`, `SKU_NOT_FOUND`, `MULTI_PO`) auto-
  flag bins when a staged container is received (`handleReceiveContainer`).
- **Delete bin from Walk Mode** — 🗑 button in bin detail, wired to the existing
  app-level confirm modal. Needed because racks aren't uniform rectangles.
- **SKU Master Sheet** (`src/components/SkuSheet/`) — printable reference sheet
  of every in-stock SKU (qty > 0 only) with a scannable QR code, grouped by
  style and sorted by color. Button lives in the desktop Warehouse 3D tab under
  the Quantities CSV import. Feeds Walk Mode's existing barcode-scan-to-fill
  Add SKU flow — scan a SKU off the printed sheet instead of typing it.
- **Rack multi-select + group move** (`Canvas.jsx`, `ControlPanel.jsx`) —
  cmd/ctrl+click a rack's name label to add/remove it from a group (separate
  from normal single-select, which still drills into that rack's detail view).
  With 2+ racks grouped: "Pick Up Group" does a true click-to-place move (same
  gesture as the existing single-rack move, extended to N racks, preserving
  exact relative spacing — anchor point is the group's bounding-box min
  corner). "Nudge Group" is a numeric X/Z shift for precise adjustments (e.g. a
  known aisle width). "Row label" stamps a shared name across the group so it
  can be re-selected later via "Select all in Row X".
- **Render performance fix** (`Canvas.jsx`) — selection changes (clicking a
  rack/bin) used to tear down and rebuild the *entire* 3D scene (~1,500+ meshes)
  on every click. Split into a structural rebuild effect (deps: racks/bins/
  movingBinId — only runs when the layout actually changes) and a cheap
  recolor-only effect (deps: selection state — just mutates existing
  materials/label styles via `rackMeshMap`/`binMeshMap`/`displacedMeshMap`
  stored in `threeRef.current`). Noticeably less "chugging" on click.
- **Wider desktop panel + scrollable bin-grid** — `.panel` was a fixed 340px,
  and the rack detail "Slots" grid used `1fr` columns with no minimum width, so
  a wide rack (e.g. 22 columns) squeezed every cell down to ~10px and became
  unreadable. Panel is now 420px, and `.bin-grid` cells have a 26px floor with
  horizontal scroll (`minmax(26px, 1fr)` + `overflow-x: auto`) so any column
  count stays legible regardless of panel width.
- **Undo** — "↶ Undo" button in the top bar (also cmd/ctrl+Z), for rack/bin
  structural changes: create, move/place (single and group), delete, resize,
  row-label, bin delete/move. Coarse-grained — snapshots the full `{racks,
  bins}` pair before each mutating action onto a capped 20-entry stack
  (`pushUndoSnapshot()` in `App.jsx`), rather than per-field diffs. Does NOT
  cover SKU content edits (add/remove SKU, qty change) — explicitly scoped to
  placement mistakes only, per what was asked for. Note: `handleUpdateRack`
  fires on every keystroke in the Cols/Levels number inputs, so typing a
  multi-digit value pushes multiple snapshots — harmless (each is a valid
  restore point) but means Undo may need a couple of clicks after a resize.

## Ideas noted for later (not built)

- **Physical count sheets via the same generate-and-print pattern as the SKU
  Master Sheet** — for the eventual real inventory reconciliation against
  NetSuite, generate a similar printable/scannable export listing just the
  SKUs due for a physical recount (e.g. everything flagged during the staging
  pass), to make manual counting faster. Explicitly deferred — revisit when
  it's time to reconcile against NetSuite.
- Deploy to Vercel — config exists (`vercel.json`, `.env.example`) but never
  actually deployed; Walk Mode currently only reachable via local dev server.

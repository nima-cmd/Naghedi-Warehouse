// Airtable REST API — warehouse layout save / load
//
// The "Warehouse 3D" table stores the entire layout as a single JSON record:
//   Key   = "layout"      (so we can find it with a filter)
//   State = JSON string   (full snapshot: warehouses, racks, bins, counters)
//
// We use Airtable's own REST API (fetch from the browser) rather than the
// Airtable JS SDK so there are no extra dependencies.

const BASE  = import.meta.env.VITE_AIRTABLE_BASE_ID          // apppmmp5Bt5ohmlaF
const TABLE = import.meta.env.VITE_AIRTABLE_LAYOUT_TABLE      // tbljOEruBHdcuS4oq
const API   = `https://api.airtable.com/v0/${BASE}/${TABLE}`

// Build the Authorization header from the token in .env.local
function authHeaders() {
  const token = import.meta.env.VITE_AIRTABLE_TOKEN
  if (!token || token === 'your_personal_access_token_here') {
    throw new Error(
      'Airtable token missing. Open .env.local and replace ' +
      'VITE_AIRTABLE_TOKEN with your Personal Access Token, ' +
      'then restart the dev server.'
    )
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// Helper: throw a readable error from an Airtable error response
async function checkResponse(res) {
  if (res.ok) return
  let msg = `Airtable ${res.status}`
  try {
    const body = await res.json()
    msg = body?.error?.message ?? msg
  } catch {}
  throw new Error(msg)
}

// ── Load ─────────────────────────────────────────────────────────────────────
// Fetches the saved layout from Airtable.
// Returns { recordId, layout } if a saved snapshot exists, or null if this
// is the first time (no record yet).
export async function loadLayout() {
  const filter = encodeURIComponent('{Key}="layout"')
  const res = await fetch(`${API}?filterByFormula=${filter}&maxRecords=1`, {
    headers: authHeaders(),
  })
  await checkResponse(res)
  const data = await res.json()
  if (!data.records.length) return null

  const rec = data.records[0]
  return {
    recordId: rec.id,
    layout: JSON.parse(rec.fields.State),
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
// Saves the current layout to Airtable.
// Pass existingRecordId (from a previous load or save) to PATCH the existing
// record; omit it to POST a brand-new one.
// Always returns the Airtable record ID so App.jsx can cache it.
export async function saveLayout(layoutData, existingRecordId = null) {
  const fields = {
    Layout: 'Warehouse Layout',
    Key:    'layout',
    State:  JSON.stringify(layoutData),
  }

  const method = existingRecordId ? 'PATCH' : 'POST'
  const body   = existingRecordId
    ? { records: [{ id: existingRecordId, fields }] }
    : { records: [{ fields }] }

  const res = await fetch(API, {
    method,
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  await checkResponse(res)
  const data = await res.json()
  return data.records[0].id
}

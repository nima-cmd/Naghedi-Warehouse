// Container CRUD — localStorage-backed, mirrors catalog.js pattern.
// Airtable sync will be added in a later phase.

const CACHE_KEY = 'wh_containers'

export function loadContainers() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveContainers(containers) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(containers))
  } catch {}
}

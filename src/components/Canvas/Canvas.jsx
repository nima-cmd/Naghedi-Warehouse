import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer'

const W = 25
const D = 100
const GAP = 15
const WH_POS = [-(W / 2 + GAP / 2), (W / 2 + GAP / 2)]
const BIN = { w: 2, d: 4 / 3, h: 17 / 12 }

function clearGroup(group) {
  group.traverse(child => {
    // CSS2DObjects wrap a real DOM <div>. Three.js never removes these from the
    // overlay automatically — if we don't call element.remove() ourselves, the
    // div stays visible in the DOM even after the object leaves the scene graph.
    if (child.isCSS2DObject) {
      child.element.remove()
      return
    }
    if (!child.isMesh) return
    child.geometry.dispose()
    Array.isArray(child.material)
      ? child.material.forEach(m => m.dispose())
      : child.material.dispose()
  })
  while (group.children.length) group.remove(group.children[0])
}

// Build a rack mesh without using group.rotation — the mesh is built with the
// correct orientation directly. At rotated=false, columns run along Z (warehouse
// depth). At rotated=true, columns run along X (warehouse width).
// In both cases, group origin (0,0,0) = the min-X, min-Z, bottom corner of the footprint.
function buildRackMesh(rack, ghost = false, selected = false) {
  const cols = rack.cols
  const rows = rack.rows
  const bw = rack.binW ?? BIN.w
  const bd = rack.binD ?? BIN.d
  const bh = rack.binH ?? BIN.h
  const rotated = rack.rotated ?? false
  const totalY = rows * bh
  const s = 0.05  // post/rail cross-section thickness

  let color = selected ? 0xffb020 : 0x607080
  const mat = ghost
    ? new THREE.MeshLambertMaterial({ color: 0x4499ff, transparent: true, opacity: 0.35 })
    : new THREE.MeshLambertMaterial({ color })

  const group = new THREE.Group()

  if (!rotated) {
    // Columns along Z, rack depth along X
    for (let col = 0; col <= cols; col++) {
      for (const x of [s / 2, bd - s / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(s, totalY, s), mat)
        post.position.set(x, totalY / 2, col * bw)
        group.add(post)
      }
    }
    for (let row = 0; row <= rows; row++) {
      for (const x of [s / 2, bd - s / 2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(s, s, cols * bw), mat)
        rail.position.set(x, row * bh, (cols * bw) / 2)
        group.add(rail)
      }
    }
  } else {
    // Rotated 90°: columns along X, rack depth along Z
    for (let col = 0; col <= cols; col++) {
      for (const z of [s / 2, bd - s / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(s, totalY, s), mat)
        post.position.set(col * bw, totalY / 2, z)
        group.add(post)
      }
    }
    for (let row = 0; row <= rows; row++) {
      for (const z of [s / 2, bd - s / 2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(cols * bw, s, s), mat)
        rail.position.set((cols * bw) / 2, row * bh, z)
        group.add(rail)
      }
    }
  }

  return group
}

// Returns the label div element so it can be updated later
function buildWarehouse(scene, offsetX, name, floorMeshes, whIndex, whW = W, whD = D) {
  const group = new THREE.Group()
  group.position.x = offsetX

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(whW, whD),
    new THREE.MeshLambertMaterial({ color: 0x161b22 })
  )
  floor.rotation.x = -Math.PI / 2
  group.add(floor)

  // Invisible floor plane lives in WORLD space for accurate raycasting
  const hitPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(whW, whD),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  )
  hitPlane.rotation.x = -Math.PI / 2
  hitPlane.position.x = offsetX
  hitPlane.userData.whIndex = whIndex
  scene.add(hitPlane)
  floorMeshes.push(hitPlane)

  const gv = []
  for (let x = 0; x <= whW; x++) { gv.push(x-whW/2,0.01,-whD/2, x-whW/2,0.01,whD/2) }
  for (let z = 0; z <= whD; z++) { gv.push(-whW/2,0.01,z-whD/2, whW/2,0.01,z-whD/2) }
  const gGeo = new THREE.BufferGeometry()
  gGeo.setAttribute('position', new THREE.Float32BufferAttribute(gv, 3))
  group.add(new THREE.LineSegments(gGeo, new THREE.LineBasicMaterial({ color: 0x2a323d })))

  const mv = []
  for (let x = 0; x <= whW; x+=5) { mv.push(x-whW/2,0.015,-whD/2, x-whW/2,0.015,whD/2) }
  for (let z = 0; z <= whD; z+=5) { mv.push(-whW/2,0.015,z-whD/2, whW/2,0.015,z-whD/2) }
  const mGeo = new THREE.BufferGeometry()
  mGeo.setAttribute('position', new THREE.Float32BufferAttribute(mv, 3))
  group.add(new THREE.LineSegments(mGeo, new THREE.LineBasicMaterial({ color: 0x3d4f63 })))

  const bv = [-whW/2,0.02,-whD/2, whW/2,0.02,-whD/2, whW/2,0.02,whD/2, -whW/2,0.02,whD/2, -whW/2,0.02,-whD/2]
  const bGeo = new THREE.BufferGeometry()
  bGeo.setAttribute('position', new THREE.Float32BufferAttribute(bv, 3))
  group.add(new THREE.Line(bGeo, new THREE.LineBasicMaterial({ color: 0xffb020 })))

  const div = document.createElement('div')
  div.textContent = name
  div.style.cssText = "color:#ffb020;font-family:'Space Grotesk',system-ui,sans-serif;font-size:13px;font-weight:600;background:rgba(14,17,22,.85);padding:4px 12px;border:1px solid #ffb020;border-radius:4px;pointer-events:none;white-space:nowrap"
  const label = new CSS2DObject(div)
  label.position.set(0, 1, -whD / 2 - 1)
  group.add(label)

  // ── Floor ruler labels ─────────────────────────────────────────────────────
  // Depth (Z) axis: labels every 10 units along the left edge
  const rulerStyle = "color:#3d4f63;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;pointer-events:none;white-space:nowrap"
  for (let z = -whD / 2; z <= whD / 2; z += 10) {
    const d = document.createElement('div')
    d.textContent = z === 0 ? '0' : (z > 0 ? `+${z}` : `${z}`)
    d.style.cssText = rulerStyle
    const lbl = new CSS2DObject(d)
    lbl.position.set(-whW / 2 - 0.5, 0.1, z)
    group.add(lbl)
  }
  // Width (X) axis: labels every 5 units along the front edge
  for (let x = -whW / 2; x <= whW / 2; x += 5) {
    const d = document.createElement('div')
    d.textContent = x === 0 ? '0' : (x > 0 ? `+${x}` : `${x}`)
    d.style.cssText = rulerStyle
    const lbl = new CSS2DObject(d)
    lbl.position.set(x, 0.1, whD / 2 + 0.5)
    group.add(lbl)
  }

  scene.add(group)
  return div  // returned so the name can be updated without rebuilding
}

// Build a single bin box mesh, positioned in local rack coordinates
// Returns the Three.js hex color representing a bin's dominant SKU location.
// Priority: most qty-weighted non-TBD location wins; pure-TBD → dark gold warning.
// Returns null if the bin has no SKU content (caller handles empty gray).
function getBinLocColor(bin, locationColors) {
  const skus = bin.skus ?? []
  if (skus.length === 0) return null
  // Tally total qty per location
  const totals = {}
  for (const s of skus) {
    const loc = s.location ?? 'TBD'
    totals[loc] = (totals[loc] ?? 0) + (s.qty ?? 0)
  }
  // Pick location with highest qty; TBD participates but loses to any named location of equal qty
  let best = null, bestQty = -1
  for (const [loc, qty] of Object.entries(totals)) {
    if (qty > bestQty || (qty === bestQty && loc !== 'TBD')) { best = loc; bestQty = qty }
  }
  return locationColors[best] ?? (best === 'TBD' ? 0xb8860b : 0x1a5cb8)
}

function buildBinMesh(bin, rack, selected = false, ghost = false, hasContent = false, locColor = null) {
  // Per-bin dimension overrides fall back to rack level, then global defaults
  const bw = bin.binW ?? rack.binW ?? BIN.w
  const bd = bin.binD ?? rack.binD ?? BIN.d
  const bh = bin.binH ?? rack.binH ?? BIN.h
  const gap = 0.05

  const geo = new THREE.BoxGeometry(bd - gap * 2, bh - gap * 2, bw - gap * 2)
  const mat = ghost
    ? new THREE.MeshLambertMaterial({ color: 0x4499ff, transparent: true, opacity: 0.3 })
    : new THREE.MeshLambertMaterial({
        color: selected ? 0xffb020 : locColor ?? (hasContent ? 0x1a5cb8 : 0x444444),
      })
  const mesh = new THREE.Mesh(geo, mat)

  if (!rack.rotated) {
    mesh.position.set(bd / 2, bin.row * bh + bh / 2, bin.col * bw + bw / 2)
  } else {
    mesh.position.set(bin.col * bw + bw / 2, bin.row * bh + bh / 2, bd / 2)
  }

  return mesh
}

function buildEmptySlotMesh(col, row, rack) {
  const bw = rack.binW ?? BIN.w, bd = rack.binD ?? BIN.d, bh = rack.binH ?? BIN.h
  const gap = 0.05
  const geo = new THREE.BoxGeometry(bd - gap * 2, bh - gap * 2, bw - gap * 2)
  const mat = new THREE.MeshLambertMaterial({ color: 0x2a4060, transparent: true, opacity: 0.3 })
  const mesh = new THREE.Mesh(geo, mat)
  if (!rack.rotated) {
    mesh.position.set(bd / 2, row * bh + bh / 2, col * bw + bw / 2)
  } else {
    mesh.position.set(col * bw + bw / 2, row * bh + bh / 2, bd / 2)
  }
  mesh.userData.emptySlot = { rackId: rack.id, col, row }
  return mesh
}

// Compute footprint extents based on rotation — used for snapping and bounds checking
function getExtents(rack) {
  const bw = rack.binW ?? BIN.w
  const bd = rack.binD ?? BIN.d
  return rack.rotated
    ? { extentX: rack.cols * bw, extentZ: bd }
    : { extentX: bd, extentZ: rack.cols * bw }
}

function Canvas({
  warehouses = [],
  racks = [],
  bins = [],
  placingRack,
  selectedRackId,
  selectedBinId,
  movingBinId,
  onPlaceRack,
  onCancelPlace,
  onToggleRotation,
  onSelectRack,
  onSelectBin,
  onMoveRack,
  onUpdateRack,
  onMoveBin,
  onCancelMoveBin,
  onRequestDeleteBin,
  locationColors = {},
  rooms = [],
  selectedRoomId,
  placingRoom,
  onPlaceRoom,
  onSelectRoom,
}) {
  const mountRef = useRef(null)
  const threeRef = useRef({})

  // Keep callbacks and latest state in refs so event handlers (set up once) always see fresh values
  const placingRackRef      = useRef(placingRack)
  const onPlaceRackRef      = useRef(onPlaceRack)
  const onCancelPlaceRef    = useRef(onCancelPlace)
  const onToggleRotationRef = useRef(onToggleRotation)
  const onSelectRackRef     = useRef(onSelectRack)
  const onMoveRackRef       = useRef(onMoveRack)
  const onUpdateRackRef     = useRef(onUpdateRack)
  const onSelectBinRef      = useRef(onSelectBin)
  const selectedRackIdRef   = useRef(selectedRackId)
  const racksRef            = useRef(racks)
  const binsRef             = useRef(bins)
  const movingBinRef          = useRef(movingBinId)
  const onMoveBinRef          = useRef(onMoveBin)
  const onCancelMoveBinRef    = useRef(onCancelMoveBin)
  const selectedBinIdRef      = useRef(selectedBinId)
  const onRequestDeleteBinRef = useRef(onRequestDeleteBin)
  useEffect(() => { placingRackRef.current      = placingRack },      [placingRack])
  useEffect(() => { onPlaceRackRef.current      = onPlaceRack },      [onPlaceRack])
  useEffect(() => { onCancelPlaceRef.current    = onCancelPlace },    [onCancelPlace])
  useEffect(() => { onToggleRotationRef.current = onToggleRotation }, [onToggleRotation])
  useEffect(() => { onSelectRackRef.current     = onSelectRack },     [onSelectRack])
  useEffect(() => { onMoveRackRef.current       = onMoveRack },       [onMoveRack])
  useEffect(() => { onUpdateRackRef.current     = onUpdateRack },     [onUpdateRack])
  useEffect(() => { onSelectBinRef.current      = onSelectBin },      [onSelectBin])
  useEffect(() => { selectedRackIdRef.current   = selectedRackId },   [selectedRackId])
  useEffect(() => { racksRef.current            = racks },            [racks])
  useEffect(() => { binsRef.current             = bins },             [bins])
  useEffect(() => { movingBinRef.current          = movingBinId },        [movingBinId])
  useEffect(() => { onMoveBinRef.current          = onMoveBin },          [onMoveBin])
  useEffect(() => { onCancelMoveBinRef.current    = onCancelMoveBin },    [onCancelMoveBin])
  useEffect(() => { selectedBinIdRef.current      = selectedBinId },      [selectedBinId])
  useEffect(() => { onRequestDeleteBinRef.current = onRequestDeleteBin }, [onRequestDeleteBin])

  const roomsRef          = useRef(rooms)
  const placingRoomRef    = useRef(placingRoom)
  const onPlaceRoomRef    = useRef(onPlaceRoom)
  const onSelectRoomRef   = useRef(onSelectRoom)
  useEffect(() => { roomsRef.current         = rooms },        [rooms])
  useEffect(() => { placingRoomRef.current   = placingRoom },  [placingRoom])
  useEffect(() => { onPlaceRoomRef.current   = onPlaceRoom },  [onPlaceRoom])
  useEffect(() => { onSelectRoomRef.current  = onSelectRoom }, [onSelectRoom])

  // ── Effect 1: One-time Three.js setup ───────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    const w = mount.clientWidth, h = mount.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0e1116)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    camera.position.set(0, 100, 100)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(w, h)
    labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none'
    mount.appendChild(labelRenderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.minDistance = 5
    controls.maxDistance = 350
    controls.maxPolarAngle = Math.PI / 2 - 0.05

    const floorMeshes = []
    const w0 = warehouses[0]?.width ?? W
    const w1 = warehouses[1]?.width ?? W
    const d0 = warehouses[0]?.depth ?? D
    const d1 = warehouses[1]?.depth ?? D
    const whPos = [-(w0 / 2 + GAP / 2), (w1 / 2 + GAP / 2)]
    const warehouseLabelDivs = [
      buildWarehouse(scene, whPos[0], warehouses[0]?.name ?? 'Warehouse 1', floorMeshes, 0, w0, d0),
      buildWarehouse(scene, whPos[1], warehouses[1]?.name ?? 'Warehouse 2', floorMeshes, 1, w1, d1),
    ]

    const racksGroup = new THREE.Group()
    const ghostGroup = new THREE.Group()
    const displacedGroup = new THREE.Group()
    const roomsGroup = new THREE.Group()
    ghostGroup.visible = false
    scene.add(racksGroup)
    scene.add(ghostGroup)
    scene.add(displacedGroup)
    scene.add(roomsGroup)

    scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const sun = new THREE.DirectionalLight(0xffffff, 0.6)
    sun.position.set(20, 40, 20)
    scene.add(sun)

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    const updateMouse = (e) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
      mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
    }

    const snapAndClamp = (rawLocalX, rawZ, cfg, whIdx) => {
      const thisW = whIdx === 0 ? w0 : w1
      const thisD = whIdx === 0 ? d0 : d1
      const extentX = cfg.roomW != null ? cfg.roomW : getExtents(cfg).extentX
      const extentZ = cfg.roomD != null ? cfg.roomD : getExtents(cfg).extentZ
      const localX = Math.max(-thisW / 2, Math.min(Math.round(rawLocalX), thisW / 2 - extentX))
      const localZ = Math.max(-thisD / 2, Math.min(Math.round(rawZ),      thisD / 2 - extentZ))
      return { localX, localZ }
    }

    // Track mousedown position to distinguish a click from a drag
    let mouseDownAt = null
    const onMouseDown = (e) => { mouseDownAt = { x: e.clientX, y: e.clientY } }

    const onMouseMove = (e) => {
      const cfg = placingRackRef.current
      const room = placingRoomRef.current
      const movingBin = movingBinRef.current
      mount.style.cursor = (cfg || room || movingBin) ? 'crosshair' : 'default'
      if (!cfg && !room) { ghostGroup.visible = false; return }

      updateMouse(e)
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(floorMeshes)
      if (!hits.length) { ghostGroup.visible = false; return }

      const hit = hits[0]
      const whIndex = hit.object.userData.whIndex
      const activePlacing = placingRackRef.current || placingRoomRef.current
      const { localX, localZ } = snapAndClamp(
        hit.point.x - whPos[whIndex], hit.point.z, activePlacing, whIndex
      )
      ghostGroup.visible = true
      ghostGroup.position.set(whPos[whIndex] + localX, 0, localZ)
    }

    const onClick = (e) => {
      // Ignore drag events (mouse moved more than 5px between down and up)
      if (mouseDownAt) {
        const dx = e.clientX - mouseDownAt.x
        const dy = e.clientY - mouseDownAt.y
        if (Math.sqrt(dx * dx + dy * dy) > 5) return
      }

      updateMouse(e)
      raycaster.setFromCamera(mouse, camera)

      const cfg = placingRackRef.current
      if (cfg) {
        // ── Place mode: drop rack on floor ──────────────────────────────────
        const hits = raycaster.intersectObjects(floorMeshes)
        if (!hits.length) return
        const hit = hits[0]
        const whIndex = hit.object.userData.whIndex
        const { localX, localZ } = snapAndClamp(
          hit.point.x - whPos[whIndex], hit.point.z, cfg, whIndex
        )
        onPlaceRackRef.current?.(whIndex, localX, localZ)
      } else if (placingRoomRef.current) {
        const hits = raycaster.intersectObjects(floorMeshes)
        if (!hits.length) return
        const hit = hits[0]
        const whIndex = hit.object.userData.whIndex
        const roomCfg = placingRoomRef.current
        const { localX, localZ } = snapAndClamp(hit.point.x - whPos[whIndex], hit.point.z, roomCfg, whIndex)
        onPlaceRoomRef.current?.(whIndex, localX, localZ)
      } else {
        // ── Select mode: bins take priority over rack frames ──────────────────
        // Raycast recursively (hits bins and rack posts/rails)
        const hits = raycaster.intersectObjects(racksGroup.children, true)
        if (hits.length) {
          const topHit = hits[0].object
          if (topHit.userData.emptySlot && movingBinRef.current) {
            // Clicked an empty slot placeholder — move the bin here
            const { rackId, col, row } = topHit.userData.emptySlot
            onMoveBinRef.current?.(movingBinRef.current, rackId, col, row)
          } else if (topHit.userData.binId) {
            if (movingBinRef.current && topHit.userData.binId !== movingBinRef.current) {
              // Clicked a different occupied bin while in move mode.
              // Skip the swap if the source is a displaced bin — displaced bins can only
              // move into empty slots (clicking an occupied slot is a no-op for them).
              const movingBin = binsRef.current.find(b => b.id === movingBinRef.current)
              if (!movingBin?.displaced) {
                onMoveBinRef.current?.(
                  movingBinRef.current,
                  topHit.userData.binRackId,
                  topHit.userData.binCol,
                  topHit.userData.binRow,
                )
              }
            } else if (!movingBinRef.current) {
              onSelectBinRef.current?.(topHit.userData.binId)
            }
          }
          // Clicking rack frame: no action — rack is selected via name label only
        } else {
          // No rack/bin hit — check displaced bins in the limbo zone
          const dispHits = raycaster.intersectObjects(displacedGroup.children, true)
          if (dispHits.length && dispHits[0].object.userData.binId && !movingBinRef.current) {
            onSelectBinRef.current?.(dispHits[0].object.userData.binId)
          } else {
            // Check rooms
            const roomHits = raycaster.intersectObjects(roomsGroup.children, true)
            if (roomHits.length && roomHits[0].object.userData.roomId && !movingBinRef.current) {
              onSelectRoomRef.current?.(roomHits[0].object.userData.roomId)
            } else {
              // Clicked empty floor → deselect and cancel any move
              const floorHit = raycaster.intersectObjects(floorMeshes)
              if (floorHit.length) {
                onSelectRackRef.current?.(null)
                onSelectBinRef.current?.(null)
                onSelectRoomRef.current?.(null)
                if (movingBinRef.current) onCancelMoveBinRef.current?.()
              }
            }
          }
        }
      }
    }

    const onKeyDown = (e) => {
      // Don't fire shortcuts while the user is typing in an input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

      if (e.key === 'Escape') {
        onCancelPlaceRef.current?.()
      }

      if (e.key === 'r' || e.key === 'R') {
        if (placingRackRef.current) {
          // R during placement → toggle the ghost's rotation
          onToggleRotationRef.current?.()
        } else if (selectedRackIdRef.current) {
          // R with a rack selected → rotate that rack in place
          const rack = racksRef.current.find(r => r.id === selectedRackIdRef.current)
          if (rack) onUpdateRackRef.current?.(rack.id, { rotated: !rack.rotated })
        }
      }

      if (e.key === 'w' || e.key === 'W') {
        if (selectedRackIdRef.current && !placingRackRef.current) {
          onMoveRackRef.current?.(selectedRackIdRef.current)
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBinIdRef.current && !movingBinRef.current) {
          e.preventDefault()
          onRequestDeleteBinRef.current?.(selectedBinIdRef.current)
        }
      }

      if (e.key === 'f' || e.key === 'F') {
        if (!placingRackRef.current) {
          // Focus on selected rack, or on the rack that owns the selected bin
          let rackId = selectedRackIdRef.current
          if (!rackId && selectedBinIdRef.current) {
            const bin = binsRef.current.find(b => b.id === selectedBinIdRef.current)
            rackId = bin?.rackId ?? null
          }
          if (rackId) focusOnRack(rackId)
        }
      }
    }

    renderer.domElement.addEventListener('mousedown', onMouseDown)
    renderer.domElement.addEventListener('mousemove', onMouseMove)
    renderer.domElement.addEventListener('click', onClick)
    window.addEventListener('keydown', onKeyDown)

    // Camera focus animation state — plain object so the animate closure captures it by ref
    const cameraAnim = { current: null }

    // Move camera smoothly to look at the center of a rack
    const focusOnRack = (rackId) => {
      const rack = racksRef.current.find(r => r.id === rackId)
      if (!rack) return
      const { extentX, extentZ } = getExtents(rack)
      const bh = rack.binH ?? BIN.h
      const cx = whPos[rack.whIndex] + rack.localX + extentX / 2
      const cy = (rack.rows * bh) / 2
      const cz = rack.localZ + extentZ / 2
      const maxDim = Math.max(extentX, extentZ, rack.rows * bh, 4)
      const dist = maxDim * 2.2 + 6
      cameraAnim.current = {
        fromPos:    camera.position.clone(),
        fromTarget: controls.target.clone(),
        toPos:      new THREE.Vector3(cx, cy + dist * 0.55, cz + dist * 0.8),
        toTarget:   new THREE.Vector3(cx, cy, cz),
        t: 0,
      }
    }

    let frameId
    const animate = () => {
      frameId = requestAnimationFrame(animate)
      // Smooth camera focus animation (ease-out cubic)
      const anim = cameraAnim.current
      if (anim) {
        anim.t = Math.min(anim.t + 0.07, 1)
        const ease = 1 - Math.pow(1 - anim.t, 3)
        camera.position.lerpVectors(anim.fromPos, anim.toPos, ease)
        controls.target.lerpVectors(anim.fromTarget, anim.toTarget, ease)
        if (anim.t >= 1) cameraAnim.current = null
      }
      controls.update()
      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const rw = mount.clientWidth, rh = mount.clientHeight
      camera.aspect = rw / rh
      camera.updateProjectionMatrix()
      renderer.setSize(rw, rh)
      labelRenderer.setSize(rw, rh)
    }
    window.addEventListener('resize', onResize)

    threeRef.current = {
      scene, camera, renderer, labelRenderer, controls,
      racksGroup, ghostGroup, displacedGroup, roomsGroup, floorMeshes,
      warehouseLabelDivs, rackMeshMap: new Map(),
      focusOnRack, whPos,
    }

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown)
      renderer.domElement.removeEventListener('mousedown', onMouseDown)
      renderer.domElement.removeEventListener('mousemove', onMouseMove)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      if (mount.contains(labelRenderer.domElement)) mount.removeChild(labelRenderer.domElement)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 2: Update warehouse name labels ──────────────────────────────────
  useEffect(() => {
    const { warehouseLabelDivs } = threeRef.current
    if (!warehouseLabelDivs) return
    warehouses.forEach((wh, i) => {
      if (warehouseLabelDivs[i]) warehouseLabelDivs[i].textContent = wh.name
    })
  }, [warehouses])

  // ── Effect 3: Rebuild rack meshes + bin boxes when anything changes ─────────
  useEffect(() => {
    const { racksGroup, displacedGroup, rackMeshMap } = threeRef.current
    if (!racksGroup) return

    clearGroup(racksGroup)
    if (displacedGroup) clearGroup(displacedGroup)
    rackMeshMap?.clear()

    // Index bins by rackId for O(1) lookup — skip displaced bins (rendered separately)
    const binsByRack = {}
    for (const bin of bins) {
      if (bin.displaced) continue
      if (!binsByRack[bin.rackId]) binsByRack[bin.rackId] = []
      binsByRack[bin.rackId].push(bin)
    }

    for (const rack of racks) {
      const isSelected = rack.id === selectedRackId
      const mesh = buildRackMesh(rack, false, isSelected)
      const rWhPos = (threeRef.current.whPos ?? WH_POS)[rack.whIndex]
      mesh.position.set(rWhPos + rack.localX, 0, rack.localZ)
      mesh.userData.rackId = rack.id
      racksGroup.add(mesh)
      rackMeshMap?.set(rack.id, mesh)

      // Bin boxes inside this rack
      const rackBins = binsByRack[rack.id] ?? []
      const occupiedSlots = new Set(rackBins.map(b => `${b.col}_${b.row}`))

      for (const bin of rackBins) {
        const isSelected  = bin.id === selectedBinId
        const isMoving    = bin.id === movingBinId
        const hasContent  = (bin.skus ?? []).length > 0
        const locColor    = hasContent ? getBinLocColor(bin, locationColors) : null
        const binMesh = buildBinMesh(bin, rack, isSelected, isMoving, hasContent, locColor)
        binMesh.userData.binId    = bin.id
        binMesh.userData.binRackId = bin.rackId
        binMesh.userData.binCol   = bin.col
        binMesh.userData.binRow   = bin.row
        mesh.add(binMesh)

        // Label floating above the selected bin
        if (isSelected) {
          const bh = rack.binH ?? BIN.h
          const div = document.createElement('div')
          div.textContent = bin.binId
          div.style.cssText = "color:#1a1206;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;font-weight:700;background:rgba(255,176,32,.95);padding:1px 5px;border-radius:3px;pointer-events:none;white-space:nowrap"
          const lbl = new CSS2DObject(div)
          lbl.position.set(0, bh / 2 + 0.15, 0)
          binMesh.add(lbl)
        }
      }

      // Empty slot placeholders — only visible when moving a bin, so user can click a target
      if (movingBinId) {
        for (let row = 0; row < rack.rows; row++) {
          for (let col = 0; col < rack.cols; col++) {
            if (!occupiedSlots.has(`${col}_${row}`)) {
              mesh.add(buildEmptySlotMesh(col, row, rack))
            }
          }
        }
      }

      // Floating rack name label
      const { extentX, extentZ } = getExtents(rack)
      const bh = rack.binH ?? BIN.h
      const div = document.createElement('div')
      div.textContent = rack.rackId
      div.style.cssText = [
        isSelected ? 'color:#ffb020;border-color:#ffb020' : 'color:#d7dde5;border-color:#2a323d',
        "font-family:'Space Grotesk',system-ui,sans-serif",
        'font-size:11px;font-weight:600',
        'background:rgba(14,17,22,.85)',
        'padding:2px 8px;border-radius:3px;border:1px solid',
        'pointer-events:auto;cursor:pointer;white-space:nowrap',
      ].join(';')
      div.addEventListener('click', () => onSelectRackRef.current?.(rack.id))
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        onSelectRackRef.current?.(rack.id)
        threeRef.current.focusOnRack?.(rack.id)
      })
      const label = new CSS2DObject(div)
      label.position.set(extentX / 2, rack.rows * bh + 0.5, extentZ / 2)
      mesh.add(label)
    }
    // ── Displaced bins — rendered in the gap between warehouses (x≈0) ──────────
    if (displacedGroup) {
      // Sort by PO number so incoming bins from the same PO are grouped together
      const displacedBins = bins
        .filter(b => b.displaced)
        .sort((a, b) => (a.poNumber ?? '') < (b.poNumber ?? '') ? -1 : 1)
      if (displacedBins.length > 0) {
        const COLS    = 4
        const xSpacing = BIN.d + 0.4   // ~1.73
        const zSpacing = BIN.w + 0.4   // 2.4
        const startZ   = -(Math.ceil(displacedBins.length / COLS) * zSpacing) / 2

        displacedBins.forEach((bin, i) => {
          const gridCol = i % COLS
          const gridRow = Math.floor(i / COLS)
          const x = (gridCol - (COLS - 1) / 2) * xSpacing
          const z = startZ + gridRow * zSpacing

          const isSelected = bin.id === selectedBinId
          const isMoving   = bin.id === movingBinId
          const hasContent = (bin.skus ?? []).length > 0
          const dispLocColor = hasContent ? getBinLocColor(bin, locationColors) : null

          const geo = new THREE.BoxGeometry(BIN.d * 0.88, BIN.h * 0.88, BIN.w * 0.88)
          const mat = new THREE.MeshLambertMaterial({
            color:       isSelected ? 0xffb020 : isMoving ? 0x4499ff : dispLocColor ?? 0xc0392b,
            transparent: isMoving,
            opacity:     isMoving ? 0.5 : 1,
          })
          const mesh = new THREE.Mesh(geo, mat)
          mesh.position.set(x, BIN.h / 2, z)
          mesh.userData.binId = bin.id
          displacedGroup.add(mesh)

          const baseStyle = isSelected
            ? 'color:#1a1206;background:rgba(255,176,32,.95)'
            : 'color:#fff8f0;background:rgba(160,60,10,.95)'
          const lblDiv = document.createElement('div')
          lblDiv.style.cssText = [
            baseStyle,
            "font-family:'JetBrains Mono',ui-monospace,monospace",
            'font-size:8px;font-weight:700',
            'padding:2px 4px;border-radius:3px;pointer-events:none;white-space:nowrap;line-height:1.3',
          ].join(';')
          if (bin.poNumber) {
            const poDiv = document.createElement('div')
            poDiv.style.cssText = 'font-size:6px;opacity:0.75;margin-bottom:1px;letter-spacing:0.03em'
            poDiv.textContent = `PO ${bin.poNumber}`
            lblDiv.appendChild(poDiv)
          }
          const idDiv = document.createElement('div')
          idDiv.textContent = bin.binId
          lblDiv.appendChild(idDiv)

          const lbl = new CSS2DObject(lblDiv)
          lbl.position.set(0, BIN.h / 2 + 0.15, 0)
          mesh.add(lbl)
        })

        // Zone header label
        const hasIncoming = displacedBins.some(b => b.fromStaging)
        const zoneDiv = document.createElement('div')
        zoneDiv.textContent = hasIncoming
          ? `${displacedBins.length} incoming bin${displacedBins.length !== 1 ? 's' : ''} — grouped by PO — click to select`
          : `${displacedBins.length} displaced ${displacedBins.length === 1 ? 'bin' : 'bins'} — click to select`
        zoneDiv.style.cssText = [
          'color:#c05218',
          "font-family:'Space Grotesk',system-ui,sans-serif",
          'font-size:10px;font-weight:600',
          'background:rgba(14,17,22,.9);padding:2px 8px',
          'border:1px solid #c05218;border-radius:4px',
          'pointer-events:none;white-space:nowrap',
        ].join(';')
        const zoneLbl = new CSS2DObject(zoneDiv)
        const gridRows = Math.ceil(displacedBins.length / COLS)
        zoneLbl.position.set(0, BIN.h + 0.8, startZ - 1)
        displacedGroup.add(zoneLbl)
      }
    }
  }, [racks, bins, selectedRackId, selectedBinId, movingBinId])

  // ── Effect 4: Rebuild ghost when placing config changes ─────────────────────
  useEffect(() => {
    const { ghostGroup } = threeRef.current
    if (!ghostGroup) return

    clearGroup(ghostGroup)
    if (mountRef.current) mountRef.current.style.cursor = (placingRack || placingRoom) ? 'crosshair' : 'default'

    if (placingRack) {
      ghostGroup.add(buildRackMesh(placingRack, true))
      ghostGroup.visible = false
    } else if (placingRoom) {
      const geo = new THREE.PlaneGeometry(placingRoom.roomW, placingRoom.roomD)
      const mat = new THREE.MeshLambertMaterial({ color: 0x4499ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
      const planeMesh = new THREE.Mesh(geo, mat)
      planeMesh.rotation.x = -Math.PI / 2
      planeMesh.position.set(placingRoom.roomW / 2, 0.03, placingRoom.roomD / 2)
      ghostGroup.add(planeMesh)
      ghostGroup.visible = false
    } else {
      ghostGroup.visible = false
    }
  }, [placingRack, placingRoom])

  // ── Effect 5: Rebuild room meshes ────────────────────────────────────────────
  useEffect(() => {
    const { roomsGroup, whPos: currentWhPos } = threeRef.current
    if (!roomsGroup) return
    clearGroup(roomsGroup)

    const ROOM_COLORS = {
      office:   0x1a5cb8,
      bathroom: 0x16a085,
      snack:    0xe67e22,
      storage:  0x8e44ad,
      other:    0x607080,
    }

    for (const room of rooms) {
      const pos = (currentWhPos ?? WH_POS)[room.whIndex]
      const isSelected = room.id === selectedRoomId
      const color = ROOM_COLORS[room.type] ?? ROOM_COLORS.other

      const rg = new THREE.Group()
      rg.position.set(pos + room.localX + room.roomW / 2, 0, room.localZ + room.roomD / 2)

      const geo = new THREE.PlaneGeometry(room.roomW, room.roomD)
      const mat = new THREE.MeshLambertMaterial({
        color: isSelected ? 0xffb020 : color,
        transparent: true,
        opacity: isSelected ? 0.6 : 0.4,
        side: THREE.DoubleSide,
      })
      const planeMesh = new THREE.Mesh(geo, mat)
      planeMesh.rotation.x = -Math.PI / 2
      planeMesh.position.y = 0.03
      planeMesh.userData.roomId = room.id
      rg.add(planeMesh)

      const bv = new Float32Array([
        -room.roomW/2, 0.05, -room.roomD/2,
         room.roomW/2, 0.05, -room.roomD/2,
         room.roomW/2, 0.05,  room.roomD/2,
        -room.roomW/2, 0.05,  room.roomD/2,
        -room.roomW/2, 0.05, -room.roomD/2,
      ])
      const bGeo = new THREE.BufferGeometry()
      bGeo.setAttribute('position', new THREE.BufferAttribute(bv, 3))
      rg.add(new THREE.Line(bGeo, new THREE.LineBasicMaterial({ color: isSelected ? 0xffb020 : color })))

      const div = document.createElement('div')
      div.textContent = room.name || room.type
      div.style.cssText = [
        isSelected ? 'color:#1a1206;background:rgba(255,176,32,.95)' : 'color:#fff;background:rgba(14,17,22,.85)',
        "font-family:'Space Grotesk',system-ui,sans-serif",
        'font-size:10px;font-weight:600',
        'padding:2px 8px;border-radius:3px;pointer-events:none;white-space:nowrap',
      ].join(';')
      const lbl = new CSS2DObject(div)
      lbl.position.set(0, 0.4, 0)
      rg.add(lbl)

      roomsGroup.add(rg)
    }
  }, [rooms, selectedRoomId])

  const legendEntries = Object.entries(locationColors).filter(([loc]) => loc !== 'TBD')
  return (
    <div ref={mountRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {legendEntries.length > 0 && (
        <div style={{
          position: 'absolute', top: 12, right: 12, zIndex: 10,
          background: 'rgba(10,16,26,0.78)', backdropFilter: 'blur(4px)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 6, padding: '6px 10px',
          display: 'flex', flexDirection: 'column', gap: 4,
          pointerEvents: 'none',
        }}>
          {legendEntries.map(([loc, hex]) => {
            const css = '#' + hex.toString(16).padStart(6, '0')
            return (
              <span key={loc} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: css, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ color: 'rgba(255,255,255,0.65)', whiteSpace: 'nowrap' }}>{loc}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Canvas

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

const CM_TO_FT   = 1 / 30.48
const COLS       = 10
const ROWS       = 10
const SLOT_W     = 2.5
const SLOT_D     = 2.0
const LAYER_H    = 2.1
const CORRIDOR   = 5.0
const PALLET_W   = COLS * SLOT_W
const PALLET_D   = ROWS * SLOT_D

const COLORS = {
  valid:      0x4a90c4,
  skuBad:     0xe67e22,
  dimsBad:    0xe74c3c,
  selected:   0xffb020,
  highlight:  0xe67e22,
  dimmed:     0x1e2830,
  floor:      0x0e1116,
  palletArea: 0x182535,
  palletEdge: 0x1e3a50,
}

function groupByPO(boxes) {
  const map = {}
  for (const box of boxes) {
    const key = box.poNumber ?? '_'
    if (!map[key]) map[key] = []
    map[key].push(box)
  }
  return Object.entries(map)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([key, poBoxes]) => ({ po: key === '_' ? null : key, boxes: poBoxes }))
}

function slotPos(idx, dimsCm) {
  const dims   = dimsCm ?? { l: 60, w: 40, h: 43 }
  const lFt    = dims.l * CM_TO_FT
  const wFt    = dims.w * CM_TO_FT
  const hFt    = dims.h * CM_TO_FT
  const layer  = Math.floor(idx / (COLS * ROWS))
  const inLay  = idx % (COLS * ROWS)
  const col    = inLay % COLS
  const row    = Math.floor(inLay / COLS)
  return { x: col * SLOT_W + lFt / 2, y: layer * LAYER_H + hFt / 2, z: row * SLOT_D + wFt / 2, lFt, wFt, hFt }
}

export default function StagingCanvas({ boxes, selectedBoxId, onSelectBox, searchQuery = '', focusPO = null }) {
  const mountRef             = useRef(null)
  const sceneRef             = useRef(null)
  const rendererRef          = useRef(null)
  const labelRendererRef     = useRef(null)
  const cameraRef            = useRef(null)
  const controlsRef          = useRef(null)
  const meshMapRef           = useRef({})
  const cartonLabelMapRef    = useRef({})  // boxId → CSS2DObject (permanent carton labels)
  const palletObjectsRef     = useRef({})  // po → { floor, border, poLabel }
  const highlightLabelMapRef = useRef({})  // boxId → CSS2DObject (dynamic qty labels)
  const animRef              = useRef(null)
  const boxesRef             = useRef(boxes)
  const selectedBoxIdRef     = useRef(selectedBoxId)
  const mouseDownRef         = useRef(null)
  const needsRenderRef       = useRef(true)   // perf: demand rendering
  const searchQueryRef       = useRef(searchQuery)

  useEffect(() => { boxesRef.current = boxes }, [boxes])
  useEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])
  useEffect(() => { selectedBoxIdRef.current = selectedBoxId }, [selectedBoxId])

  // ── Build scene (rebuilds whenever boxes array changes) ─────────────────────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const W = el.clientWidth  || 800
    const H = el.clientHeight || 500

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(COLORS.floor)
    scene.fog = new THREE.FogExp2(COLORS.floor, 0.005)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 800)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(W, H)
    el.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(W, H)
    labelRenderer.domElement.style.position  = 'absolute'
    labelRenderer.domElement.style.top       = '0'
    labelRenderer.domElement.style.left      = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    el.appendChild(labelRenderer.domElement)
    labelRendererRef.current = labelRenderer

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping  = true
    controls.dampingFactor  = 0.07
    controls.minDistance    = 3
    controls.maxDistance    = 300
    controls.maxPolarAngle  = Math.PI / 2.05
    controlsRef.current = controls

    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const sun = new THREE.DirectionalLight(0xffffff, 0.9)
    sun.position.set(30, 60, 30)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x8899aa, 0.3)
    fill.position.set(-20, 10, -10)
    scene.add(fill)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshLambertMaterial({ color: COLORS.floor })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.02
    scene.add(ground)

    // Geometry cache: identical dims → same BoxGeometry (reduces GPU memory for large containers)
    const geoCache = {}
    const getBoxGeo = (l, h, w) => {
      const key = `${l.toFixed(3)}_${h.toFixed(3)}_${w.toFixed(3)}`
      if (!geoCache[key]) geoCache[key] = new THREE.BoxGeometry(l, h, w)
      return geoCache[key]
    }

    const groups         = groupByPO(boxes)
    const meshMap        = {}
    const cartonLabelMap = {}
    const palletObjects  = {}
    let palletX          = 0

    for (const group of groups) {
      const pFloor = new THREE.Mesh(
        new THREE.PlaneGeometry(PALLET_W, PALLET_D),
        new THREE.MeshLambertMaterial({ color: COLORS.palletArea })
      )
      pFloor.rotation.x = -Math.PI / 2
      pFloor.position.set(palletX + PALLET_W / 2, 0.001, PALLET_D / 2)
      scene.add(pFloor)

      const pts = [
        new THREE.Vector3(palletX,            0.02, 0),
        new THREE.Vector3(palletX + PALLET_W, 0.02, 0),
        new THREE.Vector3(palletX + PALLET_W, 0.02, PALLET_D),
        new THREE.Vector3(palletX,            0.02, PALLET_D),
        new THREE.Vector3(palletX,            0.02, 0),
      ]
      const borderLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: COLORS.palletEdge })
      )
      scene.add(borderLine)

      // PO info label (front-center of pallet)
      const po       = group.po ?? '—'
      const poDesc   = group.boxes.find(b => b.poDescription)?.poDescription ?? ''
      const boxCount = group.boxes.length

      const root = document.createElement('div')
      root.style.cssText = [
        'background:rgba(14,17,22,0.9)',
        'border:1px solid #2a323d',
        'border-radius:5px',
        'padding:6px 12px',
        'text-align:center',
        'white-space:nowrap',
        'pointer-events:none',
        'user-select:none',
        'line-height:1.4',
      ].join(';')
      const poRow = document.createElement('div')
      poRow.style.cssText = 'font-family:monospace;font-size:13px;font-weight:700;color:#ffb020;letter-spacing:0.5px'
      poRow.textContent = `PO ${po}`
      root.appendChild(poRow)
      if (poDesc) {
        const descRow = document.createElement('div')
        descRow.style.cssText = 'font-size:10px;color:#8a9aaa;max-width:220px;overflow:hidden;text-overflow:ellipsis;margin-top:2px'
        descRow.textContent = poDesc
        root.appendChild(descRow)
      }
      const cntRow = document.createElement('div')
      cntRow.style.cssText = 'font-size:10px;color:#5a6a7a;margin-top:2px'
      cntRow.textContent = `${boxCount} carton${boxCount !== 1 ? 's' : ''}`
      root.appendChild(cntRow)

      const poLabel = new CSS2DObject(root)
      poLabel.position.set(palletX + PALLET_W / 2, 0.5, PALLET_D + 1.5)
      scene.add(poLabel)

      palletObjects[group.po ?? '_'] = { floor: pFloor, border: borderLine, poLabel }

      // Box meshes + per-box carton labels
      group.boxes.forEach((box, idx) => {
        const { x, y, z, lFt, wFt, hFt } = slotPos(idx, box.dimsCm)
        const hasSkuIssue  = box.issues.includes('SKU_NOT_FOUND')
        const hasDimsIssue = box.issues.includes('DIMS_MISSING')

        let mesh
        if (hasDimsIssue) {
          mesh = new THREE.Mesh(
            getBoxGeo(2.0, 1.5, 1.5),
            new THREE.MeshBasicMaterial({ color: COLORS.dimsBad, wireframe: true })
          )
        } else {
          mesh = new THREE.Mesh(
            getBoxGeo(lFt, hFt, wFt),
            new THREE.MeshLambertMaterial({ color: hasSkuIssue ? COLORS.skuBad : COLORS.valid, transparent: true, opacity: 0.88 })
          )
        }
        mesh.position.set(palletX + x, y, z)
        mesh.userData = { boxId: box.id }
        scene.add(mesh)
        meshMap[box.id] = mesh

        // Carton label: "PO-boxNum" (e.g. "1688-001") above the box
        const parts  = (box.cartonId ?? '').split('-')
        const ctText = parts.length >= 3
          ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}`
          : (box.cartonId ?? '')
        const ctDiv = document.createElement('div')
        ctDiv.style.cssText = [
          'font-size:9px',
          'font-family:monospace',
          'color:#8aaccc',
          'background:rgba(14,17,22,0.72)',
          'padding:1px 3px',
          'border-radius:2px',
          'pointer-events:none',
          'white-space:nowrap',
          'line-height:1.2',
        ].join(';')
        ctDiv.textContent = ctText
        const ctLabel = new CSS2DObject(ctDiv)
        ctLabel.position.set(mesh.position.x, mesh.position.y + hFt / 2 + 0.25, mesh.position.z)
        scene.add(ctLabel)
        cartonLabelMap[box.id] = ctLabel
      })

      palletX += PALLET_W + CORRIDOR
    }

    meshMapRef.current           = meshMap
    cartonLabelMapRef.current    = cartonLabelMap
    palletObjectsRef.current     = palletObjects
    highlightLabelMapRef.current = {}

    const totalW  = Math.max(PALLET_W, palletX - CORRIDOR)
    const centerX = totalW / 2
    const centerZ = PALLET_D / 2
    camera.position.set(centerX, totalW * 0.3 + 8, centerZ + totalW * 0.4 + 20)
    camera.lookAt(centerX, 0, centerZ)
    controls.target.set(centerX, 0, centerZ)
    controls.update()

    // Demand rendering: only render when camera moves or scene state changes.
    // CSS2DRenderer is especially expensive (DOM mutations per frame) — also skip it
    // when the camera is too far out for labels to be readable, unless search is active.
    let cameraChanged = true  // start true so the first frame always renders
    controls.addEventListener('change', () => { cameraChanged = true })

    const animate = () => {
      animRef.current = requestAnimationFrame(animate)
      controls.update()  // must run every frame for damping
      if (cameraChanged || needsRenderRef.current) {
        renderer.render(scene, camera)
        labelRenderer.render(scene, camera)
        cameraChanged = false
        needsRenderRef.current = false
      }
    }
    animate()

    const onResize = () => {
      const W2 = el.clientWidth
      const H2 = el.clientHeight
      if (!W2 || !H2) return
      camera.aspect = W2 / H2
      camera.updateProjectionMatrix()
      renderer.setSize(W2, H2)
      labelRenderer.setSize(W2, H2)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      if (el.contains(renderer.domElement))      el.removeChild(renderer.domElement)
      if (el.contains(labelRenderer.domElement)) el.removeChild(labelRenderer.domElement)
      sceneRef.current = null
    }
  }, [boxes]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection + search / filter / highlight ─────────────────────────────────
  // Runs when searchQuery OR selectedBoxId changes. Handles:
  //   numeric query   → PO filter   (hide non-matching pallets/boxes)
  //   text query      → SKU highlight (amber + qty label; dim non-matching)
  //   empty           → reset to default colors
  useEffect(() => {
    const scene          = sceneRef.current
    if (!scene) return
    const meshMap        = meshMapRef.current
    const cartonLabelMap = cartonLabelMapRef.current
    const palletObjects  = palletObjectsRef.current
    const allBoxes       = boxesRef.current

    // Remove previous qty highlight labels
    for (const lbl of Object.values(highlightLabelMapRef.current)) {
      scene.remove(lbl)
      lbl.element?.remove()
    }
    highlightLabelMapRef.current = {}

    const q           = (searchQuery ?? '').trim().toUpperCase()
    const isPoFilter  = q.length > 0 && /^\d+$/.test(q)
    const isSkuSearch = q.length > 0 && !isPoFilter

    // Reset visibility of all objects
    for (const m   of Object.values(meshMap))        m.visible = true
    for (const lbl of Object.values(cartonLabelMap)) lbl.visible = true
    for (const objs of Object.values(palletObjects)) {
      objs.floor.visible = objs.border.visible = objs.poLabel.visible = true
    }

    // PO filter: hide pallets + boxes that don't contain the PO substring
    if (isPoFilter) {
      for (const [id, mesh] of Object.entries(meshMap)) {
        const box = allBoxes.find(b => b.id === id)
        const vis = (box?.poNumber ?? '').includes(q)
        mesh.visible = vis
        if (cartonLabelMap[id]) cartonLabelMap[id].visible = vis
      }
      for (const [po, objs] of Object.entries(palletObjects)) {
        const vis = (po === '_' ? '' : po).includes(q)
        objs.floor.visible = objs.border.visible = objs.poLabel.visible = vis
      }
    }

    // Color pass (selection + SKU highlight / default)
    for (const [id, mesh] of Object.entries(meshMap)) {
      if (mesh.material.wireframe || !mesh.visible) continue
      const box = allBoxes.find(b => b.id === id)
      if (!box) continue

      if (id === selectedBoxId) {
        mesh.material.color.set(COLORS.selected)
        mesh.material.opacity = 0.95
        continue
      }

      if (isSkuSearch) {
        const matched = (box.skus ?? []).filter(s => s.sku?.toUpperCase().includes(q))
        if (matched.length > 0) {
          mesh.material.color.set(COLORS.highlight)
          mesh.material.opacity = 0.95
          if (cartonLabelMap[id]) cartonLabelMap[id].visible = false  // qty label replaces it

          const totalQty = matched.reduce((s, e) => s + e.qty, 0)
          const qtyDiv = document.createElement('div')
          qtyDiv.style.cssText = [
            'background:rgba(230,126,34,0.92)',
            'color:#fff',
            'font-size:11px',
            'font-weight:700',
            'padding:2px 6px',
            'border-radius:3px',
            'pointer-events:none',
            'white-space:nowrap',
          ].join(';')
          qtyDiv.textContent = `${totalQty} units`
          const qtyLabel = new CSS2DObject(qtyDiv)
          const hFt = (box.dimsCm?.h ?? 43) * CM_TO_FT
          qtyLabel.position.set(mesh.position.x, mesh.position.y + hFt / 2 + 1.0, mesh.position.z)
          scene.add(qtyLabel)
          highlightLabelMapRef.current[id] = qtyLabel
        } else {
          mesh.material.color.set(COLORS.dimmed)
          mesh.material.opacity = 0.2
          if (cartonLabelMap[id]) cartonLabelMap[id].visible = false
        }
      } else {
        mesh.material.color.set(box.issues.includes('SKU_NOT_FOUND') ? COLORS.skuBad : COLORS.valid)
        mesh.material.opacity = 0.88
      }
    }

    needsRenderRef.current = true  // ensure one frame renders after changes
  }, [searchQuery, selectedBoxId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus on PO when focusPO prop changes ──────────────────────────────────
  useEffect(() => {
    if (!focusPO) return
    const palletObjs = palletObjectsRef.current
    const camera     = cameraRef.current
    const controls   = controlsRef.current
    if (!camera || !controls) return

    const obj = palletObjs[focusPO]
    if (!obj) return

    const { x, z } = obj.floor.position
    camera.position.set(x, 14, z + PALLET_D + 10)
    controls.target.set(x, 0, z)
    controls.update()
    needsRenderRef.current = true
  }, [focusPO])

  // ── F key: focus camera on selected box (or reset if nothing selected) ──────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return
      const camera   = cameraRef.current
      const controls = controlsRef.current
      if (!camera || !controls) return

      const boxId = selectedBoxIdRef.current
      const mesh  = meshMapRef.current[boxId]
      if (mesh) {
        const { x, y, z } = mesh.position
        controls.target.set(x, 0, z)
        camera.position.set(x + 2, y + 6, z + 9)
      } else {
        // No selection — reset to full overview
        const palletFloors = Object.values(palletObjectsRef.current).map(o => o.floor.position)
        if (!palletFloors.length) return
        const cx = palletFloors.reduce((s, p) => s + p.x, 0) / palletFloors.length
        const cz = PALLET_D / 2
        camera.position.set(cx, cx * 0.3 + 8, cz + cx * 0.4 + 20)
        controls.target.set(cx, 0, cz)
      }
      controls.update()
      needsRenderRef.current = true
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Click to select (ignore drags) ─────────────────────────────────────────
  const handleMouseDown = (e) => {
    mouseDownRef.current = { x: e.clientX, y: e.clientY }
  }

  const handleClick = (e) => {
    const down = mouseDownRef.current
    if (down) {
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (Math.sqrt(dx * dx + dy * dy) > 4) return
    }

    const renderer = rendererRef.current
    const camera   = cameraRef.current
    const el       = mountRef.current
    if (!renderer || !camera || !el) return

    const rect = el.getBoundingClientRect()
    const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
    const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera({ x, y }, camera)

    const hits = raycaster.intersectObjects(Object.values(meshMapRef.current))
    if (hits.length > 0) {
      const boxId = hits[0].object.userData.boxId
      onSelectBox?.(boxesRef.current.find(b => b.id === boxId) ?? null)
    } else {
      onSelectBox?.(null)
    }
  }

  return (
    <div
      ref={mountRef}
      className="staging-canvas-mount"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      title="Drag to orbit · Scroll to zoom · Right-drag to pan · Click box to inspect"
    />
  )
}

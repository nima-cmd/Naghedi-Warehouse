import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// 3D staging view — boxes arranged in rows grouped by CM size.
// One row per unique dimension group, largest-volume first.
// Color coding: blue-grey = valid, amber = SKU_NOT_FOUND, red wireframe = DIMS_MISSING.

const CM_TO_FT = 1 / 30.48   // 1 cm = 1/30.48 ft

const COLORS = {
  valid:     0x4a90c4,
  skuBad:    0xe67e22,
  dimsBad:   0xe74c3c,
  selected:  0xffb020,
  floor:     0x1a2230,
  gridLine:  0x2a3545,
}

const BOX_GAP_FT = 0.25  // gap between boxes
const ROW_GAP_FT = 1.0   // gap between size rows

function dimsKey(box) {
  if (!box.dimsCm) return 'unknown'
  const { l, w, h } = box.dimsCm
  return `${l}x${w}x${h}`
}

function groupByDims(boxes) {
  const groups = {}
  for (const box of boxes) {
    const key = dimsKey(box)
    if (!groups[key]) groups[key] = { key, boxes: [], dimsCm: box.dimsCm }
    groups[key].boxes.push(box)
  }
  return Object.values(groups).sort((a, b) => {
    if (!a.dimsCm) return 1
    if (!b.dimsCm) return -1
    const volA = a.dimsCm.l * a.dimsCm.w * a.dimsCm.h
    const volB = b.dimsCm.l * b.dimsCm.w * b.dimsCm.h
    return volB - volA  // largest first
  })
}

export default function StagingCanvas({ boxes, selectedBoxId, onSelectBox }) {
  const mountRef   = useRef(null)
  const sceneRef   = useRef(null)
  const rendererRef = useRef(null)
  const cameraRef  = useRef(null)
  const meshMapRef = useRef({})    // boxId → mesh
  const animRef    = useRef(null)

  // ── Setup scene ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const W = el.clientWidth
    const H = el.clientHeight

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0e1116)
    sceneRef.current = scene

    // Camera — top-down isometric-ish
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000)
    camera.position.set(0, 30, 20)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(W, H)
    el.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(10, 20, 10)
    scene.add(dir)

    // Build box meshes
    const groups = groupByDims(boxes)
    const meshMap = {}
    let zOffset = 0

    for (const group of groups) {
      let xOffset = 0
      const rowDepth = group.dimsCm ? group.dimsCm.w * CM_TO_FT : 1.5

      for (const box of group.boxes) {
        const hasSkuIssue  = box.issues.includes('SKU_NOT_FOUND')
        const hasDimsIssue = box.issues.includes('DIMS_MISSING')

        const lFt = box.dimsCm ? box.dimsCm.l * CM_TO_FT : 1.5
        const wFt = box.dimsCm ? box.dimsCm.w * CM_TO_FT : 1.5
        const hFt = box.dimsCm ? box.dimsCm.h * CM_TO_FT : 1.5

        let mesh
        if (hasDimsIssue) {
          // Red wireframe for unknown dims
          const geo = new THREE.BoxGeometry(1.5, 1, 1.5)
          const mat = new THREE.MeshBasicMaterial({ color: COLORS.dimsBad, wireframe: true })
          mesh = new THREE.Mesh(geo, mat)
        } else {
          const geo = new THREE.BoxGeometry(lFt, hFt, wFt)
          const color = hasSkuIssue ? COLORS.skuBad : COLORS.valid
          const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.85 })
          mesh = new THREE.Mesh(geo, mat)
        }

        const boxW = box.dimsCm ? box.dimsCm.l * CM_TO_FT : 1.5
        const boxH = box.dimsCm ? box.dimsCm.h * CM_TO_FT : 1
        mesh.position.set(xOffset + boxW / 2, boxH / 2, zOffset + rowDepth / 2)
        mesh.userData = { boxId: box.id }
        scene.add(mesh)
        meshMap[box.id] = mesh

        xOffset += boxW + BOX_GAP_FT
      }

      zOffset += rowDepth + ROW_GAP_FT
    }

    meshMapRef.current = meshMap

    // Center camera on all boxes
    if (boxes.length > 0) {
      const maxX = Math.max(...Object.values(meshMap).map(m => m.position.x))
      const maxZ = Math.max(...Object.values(meshMap).map(m => m.position.z))
      camera.position.set(maxX / 2, 25, maxZ + 15)
      camera.lookAt(maxX / 2, 0, maxZ / 2)
    }

    // Animation loop
    const animate = () => {
      animRef.current = requestAnimationFrame(animate)
      renderer.render(scene, camera)
    }
    animate()

    // Resize
    const onResize = () => {
      const W2 = el.clientWidth
      const H2 = el.clientHeight
      camera.aspect = W2 / H2
      camera.updateProjectionMatrix()
      renderer.setSize(W2, H2)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [boxes]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Highlight selected box ──────────────────────────────────────────────────
  useEffect(() => {
    const meshMap = meshMapRef.current
    for (const [id, mesh] of Object.entries(meshMap)) {
      const box = boxes.find(b => b.id === id)
      if (!box) continue
      if (mesh.material.wireframe) continue  // don't recolor wireframe
      const hasSkuIssue = box.issues.includes('SKU_NOT_FOUND')
      mesh.material.color.set(
        id === selectedBoxId
          ? COLORS.selected
          : hasSkuIssue ? COLORS.skuBad : COLORS.valid
      )
    }
  }, [selectedBoxId, boxes])

  // ── Click to select ─────────────────────────────────────────────────────────
  const handleClick = (e) => {
    const el = mountRef.current
    const renderer = rendererRef.current
    const camera = cameraRef.current
    const scene = sceneRef.current
    if (!el || !renderer || !camera || !scene) return

    const rect = el.getBoundingClientRect()
    const x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera({ x, y }, camera)

    const meshes = Object.values(meshMapRef.current)
    const hits = raycaster.intersectObjects(meshes)
    if (hits.length > 0) {
      const hit = hits[0].object
      onSelectBox?.(boxes.find(b => b.id === hit.userData.boxId) ?? null)
    } else {
      onSelectBox?.(null)
    }
  }

  return (
    <div
      ref={mountRef}
      className="staging-canvas-mount"
      onClick={handleClick}
      title="Click a box to inspect"
    />
  )
}

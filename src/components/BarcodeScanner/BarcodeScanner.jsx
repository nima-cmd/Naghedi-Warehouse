import { useEffect, useRef } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'

// BarcodeScanner — full-screen overlay that reads barcodes from the device camera.
// Fires onDetect(codeString) the moment a barcode is decoded, then closes itself.
// Uses @zxing/browser which supports 1D barcodes (UPC, EAN, Code128) and QR codes.
function BarcodeScanner({ onDetect, onClose }) {
  const videoRef    = useRef(null)
  const onDetectRef = useRef(onDetect)

  // Keep the callback ref current so the ZXing callback doesn't stale-close over an old one
  useEffect(() => { onDetectRef.current = onDetect }, [onDetect])

  useEffect(() => {
    const reader = new BrowserMultiFormatReader()
    let controls = null
    let fired    = false  // prevent double-firing if two frames decode the same code

    reader
      .decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (result && !fired) {
          fired = true
          onDetectRef.current(result.getText())
        }
      })
      .then(c => { controls = c })
      .catch(err => {
        console.error('Camera access failed:', err)
      })

    // Stop the camera stream when the modal unmounts
    return () => { controls?.stop() }
  }, []) // runs once — reader setup doesn't depend on props

  return (
    <div className="scanner-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="scanner-modal">
        <div className="scanner-header">
          <span>Scan Barcode / QR Code</span>
          <button className="scanner-close" onClick={onClose}>✕ Close</button>
        </div>
        <div className="scanner-video-wrap">
          <video ref={videoRef} className="scanner-video" />
          <div className="scanner-target" />
          <div className="scanner-laser" />
        </div>
        <p className="scanner-hint">Point the camera at a barcode — it will be detected automatically</p>
      </div>
    </div>
  )
}

export default BarcodeScanner

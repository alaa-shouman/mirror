import { useEffect, useMemo, useRef, useState } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import GarmentRenderer, { DEFAULT_RIGGED_GARMENT_FIT } from './GarmentRenderer'
import FitProfileModal, { loadFitProfile } from './FitProfileModal'
import { BODY_RIG_LANDMARKS, computeBodyRigFrame } from '../lib/ar/bodyRig'
import { createPendingGarmentAdapter, GARMENT_ASSET_CONTRACT } from '../lib/ar/garmentAdapter'

// MediaPipe skeleton connections to draw
const SKELETON_CONNECTIONS = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso sides
  [23, 24], // hips
  [23, 25], [25, 27], // left leg
  [24, 26], [26, 28], // right leg
]

// Key landmark indices we care about for the debug panel
const KEY_LM = [
  { idx: 11, label: 'L Shoulder' },
  { idx: 12, label: 'R Shoulder' },
  { idx: 23, label: 'L Hip' },
  { idx: 24, label: 'R Hip' },
  { idx: 0,  label: 'Nose' },
  { idx: 15, label: 'L Wrist' },
  { idx: 16, label: 'R Wrist' },
]

const TRYON_TIMEOUT_MS = Number(import.meta.env.VITE_TRYON_TIMEOUT_MS || 120000)
const TORSO_MASK_ENABLED = import.meta.env.VITE_ENABLE_TORSO_MASK === '1'

function toDegrees(radians) {
  return (radians * 180) / Math.PI
}

function toCanvasPoint(landmark, width, height) {
  return { x: landmark.x * width, y: landmark.y * height }
}

function strokeJointPath(context, start, end, radius) {
  context.lineWidth = radius * 2
  context.beginPath()
  context.moveTo(start.x, start.y)
  context.lineTo(end.x, end.y)
  context.stroke()
}

function drawArmOcclusionLayer(context, sourceCanvas, maskImage, landmarks, width, height) {
  if (!sourceCanvas || !Array.isArray(landmarks) || landmarks.length < 29) return

  const lm = BODY_RIG_LANDMARKS
  const leftShoulder = landmarks[lm.LEFT_SHOULDER]
  const rightShoulder = landmarks[lm.RIGHT_SHOULDER]
  const leftElbow = landmarks[lm.LEFT_ELBOW]
  const rightElbow = landmarks[lm.RIGHT_ELBOW]
  const leftWrist = landmarks[lm.LEFT_WRIST]
  const rightWrist = landmarks[lm.RIGHT_WRIST]

  if (!leftShoulder || !rightShoulder) return
  if ((leftShoulder.visibility ?? 0) < 0.45 || (rightShoulder.visibility ?? 0) < 0.45) return

  const shoulderSpan = Math.hypot(
    (rightShoulder.x - leftShoulder.x) * width,
    (rightShoulder.y - leftShoulder.y) * height
  )

  if (shoulderSpan < 24) return

  const upperArmRadius = shoulderSpan * 0.12
  const forearmRadius = shoulderSpan * 0.1
  const jointRadius = shoulderSpan * 0.13
  const headRadius = shoulderSpan * 0.28
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) * 0.5,
    y: (leftShoulder.y + rightShoulder.y) * 0.5,
  }
  const headCenter = {
    x: shoulderMid.x * width,
    y: shoulderMid.y * height - shoulderSpan * 0.34,
  }

  context.drawImage(sourceCanvas, 0, 0, width, height)
  context.globalCompositeOperation = 'destination-in'
  context.strokeStyle = '#000'
  context.fillStyle = '#000'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.filter = 'blur(2px)'

  const segments = [
    [leftShoulder, leftElbow, upperArmRadius],
    [leftElbow, leftWrist, forearmRadius],
    [rightShoulder, rightElbow, upperArmRadius],
    [rightElbow, rightWrist, forearmRadius],
  ]

  for (const [start, end, radius] of segments) {
    if (!start || !end) continue
    if ((start.visibility ?? 0) < 0.35 || (end.visibility ?? 0) < 0.35) continue
    strokeJointPath(
      context,
      toCanvasPoint(start, width, height),
      toCanvasPoint(end, width, height),
      radius
    )
  }

  for (const joint of [leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist]) {
    if (!joint || (joint.visibility ?? 0) < 0.35) continue
    const point = toCanvasPoint(joint, width, height)
    context.beginPath()
    context.arc(point.x, point.y, jointRadius, 0, Math.PI * 2)
    context.fill()
  }

  context.beginPath()
  context.arc(headCenter.x, headCenter.y, headRadius, 0, Math.PI * 2)
  context.fill()

  if (maskImage) {
    context.filter = 'none'
    context.drawImage(maskImage, 0, 0, width, height)
  }

  context.globalCompositeOperation = 'source-over'
  context.filter = 'none'
}

// Reusable collapsible panel
function DebugPanel({ title, color = '#00ff88', open, onToggle, children }) {
  return (
    <div style={{
      background: 'rgba(0,0,0,0.82)', borderRadius: 8, overflow: 'hidden',
      border: `1px solid ${color}33`, minWidth: 240,
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', padding: '5px 10px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color, fontWeight: 'bold', fontSize: 12,
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10 }}>{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 10px 8px', color: '#fff', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 0.01, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 96, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} style={{ flex: 1 }} />
      <span style={{ width: 40, textAlign: 'right', fontFamily: 'monospace' }}>{value.toFixed(2)}</span>
    </label>
  )
}

function fillRoundedRect(context, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  context.beginPath()
  context.moveTo(left + radius, top)
  context.lineTo(right - radius, top)
  context.quadraticCurveTo(right, top, right, top + radius)
  context.lineTo(right, bottom - radius)
  context.quadraticCurveTo(right, bottom, right - radius, bottom)
  context.lineTo(left + radius, bottom)
  context.quadraticCurveTo(left, bottom, left, bottom - radius)
  context.lineTo(left, top + radius)
  context.quadraticCurveTo(left, top, left + radius, top)
  context.closePath()
  context.fill()
}

function createDemoTryonImage(sourceCanvas, product, selectedSize) {
  if (!sourceCanvas || typeof document === 'undefined') return null

  const previewCanvas = document.createElement('canvas')
  previewCanvas.width = sourceCanvas.width || 640
  previewCanvas.height = sourceCanvas.height || 480
  const context = previewCanvas.getContext('2d')
  context.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height)

  const torsoWidth = previewCanvas.width * 0.34
  const torsoHeight = previewCanvas.height * 0.38
  const torsoLeft = (previewCanvas.width - torsoWidth) / 2
  const torsoTop = previewCanvas.height * 0.27
  const sleeveWidth = previewCanvas.width * 0.12
  const sleeveHeight = previewCanvas.height * 0.15

  context.fillStyle = 'rgba(43, 103, 210, 0.72)'
  fillRoundedRect(context, torsoLeft, torsoTop, torsoWidth, torsoHeight, 26)
  fillRoundedRect(context, torsoLeft - sleeveWidth, torsoTop + 26, sleeveWidth + 20, sleeveHeight, 22)
  fillRoundedRect(context, torsoLeft + torsoWidth - 20, torsoTop + 26, sleeveWidth + 20, sleeveHeight, 22)

  context.fillStyle = 'rgba(18, 35, 72, 0.42)'
  fillRoundedRect(context, torsoLeft + 22, torsoTop + 18, torsoWidth - 44, 42, 18)

  const badgeHeight = Math.max(56, previewCanvas.height * 0.11)
  context.fillStyle = 'rgba(0, 0, 0, 0.68)'
  context.fillRect(0, previewCanvas.height - badgeHeight, previewCanvas.width, badgeHeight)
  context.fillStyle = 'rgba(255, 255, 255, 0.92)'
  context.font = '14px system-ui, sans-serif'
  context.fillText('Demo preview - live AI try-on unavailable', 18, previewCanvas.height - badgeHeight + 22)
  context.fillStyle = 'rgba(224, 201, 127, 0.95)'
  context.fillText(`${product.name} / ${selectedSize}`, 18, previewCanvas.height - badgeHeight + 44)

  return previewCanvas.toDataURL('image/png')
}

function ARPopup({ product, onClose, onAddToCart }) {
  const [selectedSize, setSelectedSize] = useState(product.sizes?.[0] || 'M')
  const [sizeAutoSelected, setSizeAutoSelected] = useState(false)

  // Fit profile: user-provided anthropometry (height, chest, waist, EU size).
  // Loaded from localStorage on mount; if absent, the profile modal is shown.
  const [fitProfile, setFitProfile] = useState(() => loadFitProfile())
  const [profileModalOpen, setProfileModalOpen] = useState(() => !loadFitProfile())

  // "See Real Fit" (diffusion try-on) state
  const [tryonState, setTryonState] = useState('idle') // idle | loading | result | error
  const [tryonImage, setTryonImage] = useState(null)
  const [tryonError, setTryonError] = useState(null)
  const [tryonElapsed, setTryonElapsed] = useState(0)
  const [tryonMode, setTryonMode] = useState(null)
  const [tryonNotice, setTryonNotice] = useState(null)

  // Debug state
  const [debugMode, setDebugMode] = useState(false)
  const [posOffset, setPosOffset] = useState({ x: 0, y: 0, z: 0 })
  const [rotOffset, setRotOffset] = useState({ x: 0, y: 0, z: 0 })
  const [scaleMult, setScaleMult] = useState(1.0)
  const [riggedFit, setRiggedFit] = useState(DEFAULT_RIGGED_GARMENT_FIT)
  const [showGarmentPanel, setShowGarmentPanel] = useState(true)
  const [showLandmarkPanel, setShowLandmarkPanel] = useState(true)
  const [showRigPanel, setShowRigPanel] = useState(true)
  const [showAssetPanel, setShowAssetPanel] = useState(true)
  const [assetState, setAssetState] = useState(() => createPendingGarmentAdapter(product.model_url || null))

  const {
    landmarks, cameraFrame, segMask,
    measurements, recommendedSize,
    connected, source, cameraError, disconnect,
  } = useWebSocket()

  // The "Best Fit" the UI will highlight. Prefer the user's self-reported
  // EU size when available (deterministic, no guessing), fall back to
  // MediaPipe's shoulder-width heuristic otherwise.
  const profileSize    = fitProfile && !fitProfile.skipped ? fitProfile.euSize : null
  const effectiveRecommendedSize = profileSize || recommendedSize
  const bodyRigFrame = useMemo(
    () =>
      computeBodyRigFrame(landmarks, {
        posOffset,
        rotOffset,
        scaleMult,
        fitProfile,
      }),
    [fitProfile, landmarks, posOffset, rotOffset, scaleMult]
  )

  useEffect(() => {
    setAssetState(createPendingGarmentAdapter(product.model_url || null))
  }, [product.model_url])

  // Auto-select recommended size
  useEffect(() => {
    if (!effectiveRecommendedSize || sizeAutoSelected) return
    if (product.sizes?.includes(effectiveRecommendedSize)) {
      setSelectedSize(effectiveRecommendedSize)
      setSizeAutoSelected(true)
    }
  }, [effectiveRecommendedSize, sizeAutoSelected, product.sizes])

  // Canvas refs
  const bgCanvasRef   = useRef(null)
  const maskCanvasRef = useRef(null)
  const skelCanvasRef = useRef(null)
  const camImgRef     = useRef(new Image())
  const maskImgRef    = useRef(new Image())
  // Layer 1: camera frame (throttled at WS source to ~10 fps)
  // Torso darkening was useful during alignment experiments, but it is off by
  // default because it makes the demo look artificially tinted.
  useEffect(() => {
    if (!cameraFrame || !bgCanvasRef.current) return
    const canvas = bgCanvasRef.current
    const ctx = canvas.getContext('2d')
    const drawScene = () => {
      ctx.drawImage(camImgRef.current, 0, 0, canvas.width, canvas.height)
      if (!landmarks || landmarks.length < 29) return
      const ls = landmarks[11], rs = landmarks[12]
      const lh = landmarks[23], rh = landmarks[24]
      if (!ls || !rs || !lh || !rh) return
      if (ls.visibility < 0.55 || rs.visibility < 0.55 ||
          lh.visibility < 0.55 || rh.visibility < 0.55) return
      if (!TORSO_MASK_ENABLED) return
      const W = canvas.width, H = canvas.height
      const padX = 0.06, padYTop = 0.05, padYBottom = 0.03
      const poly = [
        { x: (rs.x - padX) * W, y: (rs.y - padYTop)    * H }, // top-right
        { x: (ls.x + padX) * W, y: (ls.y - padYTop)    * H }, // top-left
        { x: (lh.x + padX) * W, y: (lh.y + padYBottom) * H }, // bottom-left
        { x: (rh.x - padX) * W, y: (rh.y + padYBottom) * H }, // bottom-right
      ]
      ctx.save()
      ctx.fillStyle = 'rgba(30, 30, 35, 0.72)'
      ctx.beginPath()
      ctx.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
      ctx.closePath()
      ctx.filter = 'blur(8px)'
      ctx.fill()
      ctx.restore()
    }
    camImgRef.current.onload = drawScene
    camImgRef.current.src = `data:image/jpeg;base64,${cameraFrame}`
    // If the image is already loaded (cached data URL), onload won't fire —
    // fall back to drawing immediately when it's complete.
    if (camImgRef.current.complete) drawScene()
  }, [cameraFrame, landmarks])

  // Layer 3: practical occlusion without hiding the whole shirt.
  // Arms, shoulders, wrists, and head are composited back over the garment.
  useEffect(() => {
    if (!maskCanvasRef.current) return

    const canvas = maskCanvasRef.current
    const context = canvas.getContext('2d')

    const drawOcclusion = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      drawArmOcclusionLayer(
        context,
        bgCanvasRef.current,
        segMask && maskImgRef.current.complete ? maskImgRef.current : null,
        landmarks,
        canvas.width,
        canvas.height
      )
    }

    if (!segMask) {
      drawOcclusion()
      return
    }

    maskImgRef.current.onload = drawOcclusion
    maskImgRef.current.src = `data:image/png;base64,${segMask}`
    if (maskImgRef.current.complete) drawOcclusion()
  }, [cameraFrame, landmarks, segMask])

  // Layer 4: skeleton overlay
  useEffect(() => {
    if (!skelCanvasRef.current) return
    const canvas = skelCanvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!debugMode) return
    if (!landmarks || landmarks.length < 29) return
    const W = canvas.width, H = canvas.height

    ctx.strokeStyle = 'rgba(0,255,136,0.85)'
    ctx.lineWidth = 2
    for (const [a, b] of SKELETON_CONNECTIONS) {
      const lmA = landmarks[a], lmB = landmarks[b]
      if (!lmA || !lmB || lmA.visibility < 0.4 || lmB.visibility < 0.4) continue
      ctx.beginPath()
      ctx.moveTo(lmA.x * W, lmA.y * H)
      ctx.lineTo(lmB.x * W, lmB.y * H)
      ctx.stroke()
    }
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i]
      if (!lm || lm.visibility < 0.4) continue
      ctx.beginPath()
      ctx.arc(lm.x * W, lm.y * H, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,80,80,0.9)'
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = '10px monospace'
    const labels = { 11: 'LS', 12: 'RS', 23: 'LH', 24: 'RH' }
    for (const [idx, label] of Object.entries(labels)) {
      const lm = landmarks[idx]
      if (lm && lm.visibility > 0.4) ctx.fillText(label, lm.x * W + 6, lm.y * H - 4)
    }
  }, [debugMode, landmarks])

  const handleClose = () => { disconnect(); onClose() }

  // Tick an elapsed-time counter while the AI try-on runs so the user
  // isn't staring at a frozen spinner for 60+ seconds.
  useEffect(() => {
    if (tryonState !== 'loading') return
    setTryonElapsed(0)
    const t0 = Date.now()
    const id = setInterval(() => setTryonElapsed(Math.floor((Date.now() - t0) / 1000)), 250)
    return () => clearInterval(id)
  }, [tryonState])

  const handleSeeRealFit = async () => {
    if (!bgCanvasRef.current) return
    // Snapshot the current camera frame as JPEG data URL
    const snapshot = bgCanvasRef.current.toDataURL('image/jpeg', 0.92)
    setTryonState('loading')
    setTryonError(null)
    setTryonImage(null)
    setTryonMode(null)
    setTryonNotice(null)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TRYON_TIMEOUT_MS)
    try {
      const resp = await fetch('/api/virtual-tryon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ user_image: snapshot, product_id: product.id, size: selectedSize }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      setTryonImage(data.image)
      setTryonMode(data.mode || 'live')
      setTryonNotice(data.message || null)
      setTryonState('result')
    } catch (error) {
      const message = error.name === 'AbortError'
        ? `Live try-on exceeded ${Math.round(TRYON_TIMEOUT_MS / 1000)} seconds.`
        : String(error.message || error)
      const fallbackImage = createDemoTryonImage(bgCanvasRef.current, product, selectedSize)
      if (fallbackImage) {
        setTryonImage(fallbackImage)
        setTryonMode('demo')
        setTryonNotice(`Demo fallback shown because live try-on is unavailable: ${message}`)
        setTryonState('result')
        return
      }
      setTryonError(message)
      setTryonState('error')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return (
    <>
    <FitProfileModal
      open={profileModalOpen}
      initial={fitProfile}
      onSave={(profile) => { setFitProfile(profile); setProfileModalOpen(false) }}
      onSkip={() => { setFitProfile({ skipped: true }); setProfileModalOpen(false) }}
    />
    <div className="ar-overlay">
      <div className="ar-popup">
        <button className="ar-close" onClick={handleClose}>&times;</button>

        {/* ── VIEWPORT ─────────────────────────────────────────── */}
        <div className="ar-viewport">
          {source === 'demo' && <div className="ar-mode-badge">Demo Vision</div>}
          <canvas ref={bgCanvasRef} className="ar-layer ar-layer--bg" width={640} height={480} />
          <div className="ar-layer ar-layer--garment">
            <GarmentRenderer
              modelUrl={product.model_url}
              landmarks={landmarks}
              posOffset={posOffset}
              rotOffset={rotOffset}
              scaleMult={scaleMult}
              fitProfile={fitProfile}
              riggedFit={riggedFit}
              debug={debugMode}
              onAssetState={setAssetState}
            />
          </div>
          <canvas ref={maskCanvasRef} className="ar-layer ar-layer--person" width={640} height={480} />
          <canvas ref={skelCanvasRef} className="ar-layer" width={640} height={480}
            style={{ zIndex: 10, pointerEvents: 'none', display: debugMode ? 'block' : 'none' }} />

          {measurements && (
            <div className="ar-measurements">
              <div className="ar-measurement-item">
                <span className="ar-measurement-label">Shoulders</span>
                <span className="ar-measurement-value">{(measurements.shoulder_width * 100).toFixed(0)} u</span>
              </div>
              <div className="ar-measurement-item">
                <span className="ar-measurement-label">Torso</span>
                <span className="ar-measurement-value">{(measurements.torso_length * 100).toFixed(0)} u</span>
              </div>
              <div className="ar-measurement-item">
                <span className="ar-measurement-label">Hips</span>
                <span className="ar-measurement-value">{(measurements.hip_width * 100).toFixed(0)} u</span>
              </div>
              {effectiveRecommendedSize && (
                <div className="ar-measurement-item ar-measurement-size">
                  <span className="ar-measurement-label">
                    Best Fit {profileSize ? '(your profile)' : '(est.)'}
                  </span>
                  <span className="ar-measurement-value ar-measurement-size-value">{effectiveRecommendedSize}</span>
                </div>
              )}
            </div>
          )}

          {connected && cameraFrame && landmarks.length === 0 && (
            <div className="ar-position-guide">
              <div className="ar-position-silhouette">
                <svg viewBox="0 0 80 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="40" cy="16" r="12" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                  <line x1="40" y1="28" x2="40" y2="90" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                  <line x1="40" y1="45" x2="12" y2="75" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                  <line x1="40" y1="45" x2="68" y2="75" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                  <line x1="40" y1="90" x2="24" y2="145" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                  <line x1="40" y1="90" x2="56" y2="145" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="4 3"/>
                </svg>
              </div>
              <p className="ar-position-text">Stand <strong>2–4 metres</strong> away</p>
              <p className="ar-position-sub">Face the camera directly · Full body in frame</p>
            </div>
          )}
          {!connected && !cameraError && (
            <div className="ar-status"><span className="ar-status-dot" />Connecting to camera...</div>
          )}
          {connected && !cameraFrame && !cameraError && (
            <div className="ar-status">Initializing pose detection...</div>
          )}
          {cameraError && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 15,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.82)', padding: 24, textAlign: 'center',
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📷</div>
              <div style={{ color: '#f87171', fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
                Camera not accessible
              </div>
              <div style={{ color: '#888', fontSize: 12, maxWidth: 320, marginBottom: 16 }}>
                {cameraError}
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => { window.location.reload() }}
                style={{ fontSize: 12 }}
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* ── AR CONTROLS ──────────────────────────────────────── */}
        <div className="ar-controls">
          <div className="ar-size-toggle">
            <span className="ar-controls-label">Size</span>
            {product.sizes?.map((size) => (
              <button
                key={size}
                className={`size-btn ${selectedSize === size ? 'active' : ''} ${effectiveRecommendedSize === size ? 'recommended' : ''}`}
                onClick={() => setSelectedSize(size)}
                title={effectiveRecommendedSize === size
                  ? (profileSize ? 'From your fit profile' : 'Recommended based on body shape')
                  : ''}
              >
                {size}
                {effectiveRecommendedSize === size && <span className="size-rec-dot" />}
              </button>
            ))}
          </div>
          <div className="ar-actions">
            <button
              onClick={() => setProfileModalOpen(true)}
              style={{
                background: fitProfile && !fitProfile.skipped ? '#7c3aed22' : 'transparent',
                border: `1px solid ${fitProfile && !fitProfile.skipped ? '#7c3aed' : '#444'}`,
                color: fitProfile && !fitProfile.skipped ? '#c4b5fd' : '#888',
                borderRadius: 6, padding: '6px 10px', fontSize: 11,
                cursor: 'pointer', fontFamily: 'monospace',
              }}
              title="Edit your fit profile (height, chest, waist, EU size)"
            >
              {fitProfile && !fitProfile.skipped
                ? `PROFILE · ${fitProfile.euSize}`
                : 'FIT PROFILE'}
            </button>
            <button
              onClick={() => setDebugMode(v => !v)}
              style={{
                background: debugMode ? '#00ff8822' : 'transparent',
                border: `1px solid ${debugMode ? '#00ff88' : '#444'}`,
                color: debugMode ? '#00ff88' : '#888',
                borderRadius: 6, padding: '6px 10px', fontSize: 11,
                cursor: 'pointer', fontFamily: 'monospace',
              }}
            >
              {debugMode ? 'DEBUG ON' : 'DEBUG'}
            </button>
            <button className="btn btn-secondary" onClick={handleClose}>Switch Item</button>
            <button
              className="btn btn-primary"
              onClick={handleSeeRealFit}
              disabled={tryonState === 'loading' || !connected || landmarks.length === 0}
              style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
              title="Generate a photorealistic preview of you wearing this item"
            >
              {tryonState === 'loading' ? `Generating... ${tryonElapsed}s` : 'See Real Fit'}
            </button>
            <button className="btn btn-primary" onClick={() => onAddToCart(selectedSize)}>
              Add to Cart - {selectedSize}
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* ── REAL-FIT RESULT MODAL ──────────────────────────────────── */}
    {(tryonState === 'loading' || tryonState === 'result' || tryonState === 'error') && (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 20000,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }}
        onClick={() => tryonState !== 'loading' && setTryonState('idle')}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: '#111', borderRadius: 12, padding: 20, maxWidth: 720,
            color: '#fff', textAlign: 'center', border: '1px solid #333',
            boxShadow: '0 20px 60px rgba(124,58,237,0.25)',
          }}
        >
          <div style={{ fontSize: 14, color: '#a78bfa', letterSpacing: 2, marginBottom: 8, textTransform: 'uppercase' }}>
            AI Real Fit
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>
            {product.name}
          </div>
          {tryonNotice && (
            <div className="ar-tryon-notice">
              {tryonMode === 'demo' ? 'Demo fallback' : 'Live result'}: {tryonNotice}
            </div>
          )}

          {tryonState === 'loading' && (
            <div style={{ padding: '48px 24px' }}>
              <div style={{
                width: 56, height: 56, margin: '0 auto 24px',
                border: '4px solid #333', borderTopColor: '#7c3aed',
                borderRadius: '50%', animation: 'spin 1s linear infinite',
              }} />
              <div style={{ fontSize: 16, marginBottom: 8 }}>
                Generating your real fit preview...
              </div>
              <div style={{ fontSize: 13, color: '#888' }}>
                {tryonElapsed}s elapsed - typical 45-90s - AI try-on via HuggingFace
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {tryonState === 'result' && tryonImage && (
            <>
              <img
                src={tryonImage}
                alt="AI try-on result"
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8, display: 'block', margin: '0 auto' }}
              />
              <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn btn-secondary" onClick={() => setTryonState('idle')}>Close</button>
                <button
                  className="btn btn-primary"
                  onClick={() => { onAddToCart(selectedSize); setTryonState('idle') }}
                >
                  Add to Cart - {selectedSize}
                </button>
              </div>
            </>
          )}

          {tryonState === 'error' && (
            <div style={{ padding: 24 }}>
              <div style={{ color: '#f87171', fontSize: 16, marginBottom: 12 }}>
                Couldn't generate preview
              </div>
              <div style={{ color: '#888', fontSize: 13, marginBottom: 20, wordBreak: 'break-word' }}>
                {tryonError}
              </div>
              <button className="btn btn-secondary" onClick={() => setTryonState('idle')}>Close</button>
              <button
                className="btn btn-primary"
                style={{ marginLeft: 8, background: '#7c3aed', borderColor: '#7c3aed' }}
                onClick={handleSeeRealFit}
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    )}

    {/* ── DEBUG SIDEBAR (fixed right panel, outside popup) ─────── */}
    {debugMode && <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 10000,
      width: 280, overflowY: 'auto', overflowX: 'hidden',
      background: 'rgba(10,10,10,0.92)', borderLeft: '1px solid #222',
      display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 6px',
    }}>
      <div style={{ color: '#666', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, paddingBottom: 4, borderBottom: '1px solid #222' }}>
        Debug Controls
      </div>

      {/* Garment Transform Panel */}
      <DebugPanel
        title="Garment Transform"
        color="#00ff88"
        open={showGarmentPanel}
        onToggle={() => setShowGarmentPanel(v => !v)}
      >
        <div style={{ color: '#00ff88', fontSize: 11, marginBottom: 2 }}>Position</div>
        <SliderRow label="Y (up/down)" value={posOffset.y} min={-2} max={2}
          onChange={v => setPosOffset(p => ({ ...p, y: v }))} />
        <SliderRow label="X (left/right)" value={posOffset.x} min={-2} max={2}
          onChange={v => setPosOffset(p => ({ ...p, x: v }))} />
        <SliderRow label="Z (depth)" value={posOffset.z} min={-2} max={2}
          onChange={v => setPosOffset(p => ({ ...p, z: v }))} />
        <div style={{ color: '#00ff88', fontSize: 11, margin: '4px 0 2px' }}>Scale</div>
        <SliderRow label="Scale x" value={scaleMult} min={0.3} max={3}
          onChange={v => setScaleMult(v)} />
        <div style={{ color: '#c084fc', fontSize: 11, margin: '4px 0 2px' }}>Rigged blouse fit</div>
        <SliderRow label="Rig width" value={riggedFit.width} min={0.8} max={4} step={0.05}
          onChange={v => setRiggedFit(p => ({ ...p, width: v }))} />
        <SliderRow label="Rig height" value={riggedFit.height} min={0.7} max={2.2} step={0.05}
          onChange={v => setRiggedFit(p => ({ ...p, height: v }))} />
        <SliderRow label="Rig depth" value={riggedFit.depth} min={0.5} max={2.5} step={0.05}
          onChange={v => setRiggedFit(p => ({ ...p, depth: v }))} />
        <SliderRow label="Rig up" value={riggedFit.anchorUp} min={-0.5} max={0.7} step={0.02}
          onChange={v => setRiggedFit(p => ({ ...p, anchorUp: v }))} />
        <SliderRow label="Rig right" value={riggedFit.anchorRight} min={-0.5} max={0.5} step={0.02}
          onChange={v => setRiggedFit(p => ({ ...p, anchorRight: v }))} />
        <SliderRow label="Rig depth pos" value={riggedFit.anchorForward} min={-0.5} max={0.5} step={0.02}
          onChange={v => setRiggedFit(p => ({ ...p, anchorForward: v }))} />
        <div style={{ color: '#ff88aa', fontSize: 11, margin: '4px 0 2px' }}>Rotation (rad)</div>
        <SliderRow label="Rot X (tilt)" value={rotOffset.x} min={-Math.PI} max={Math.PI}
          onChange={v => setRotOffset(r => ({ ...r, x: v }))} />
        <SliderRow label="Rot Y (turn)" value={rotOffset.y} min={-Math.PI} max={Math.PI}
          onChange={v => setRotOffset(r => ({ ...r, y: v }))} />
        <SliderRow label="Rot Z (lean)" value={rotOffset.z} min={-Math.PI} max={Math.PI}
          onChange={v => setRotOffset(r => ({ ...r, z: v }))} />
        <div style={{ color: '#555', fontSize: 10, marginTop: 4, wordBreak: 'break-all' }}>
          pos:{JSON.stringify(posOffset)} rot:{JSON.stringify(rotOffset)} sc:{scaleMult.toFixed(2)}
        </div>
      </DebugPanel>

      {/* Landmark Values Panel */}
      <DebugPanel
        title="Body Landmarks (0-1)"
        color="#ffaa00"
        open={showLandmarkPanel}
        onToggle={() => setShowLandmarkPanel(v => !v)}
      >
        {landmarks.length === 0 ? (
          <div style={{ color: '#888' }}>No landmarks detected yet</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%' }}>
            <thead>
              <tr style={{ color: '#ffaa00' }}>
                <th style={{ textAlign: 'left', paddingRight: 6 }}>Joint</th>
                <th style={{ paddingRight: 4 }}>x</th>
                <th style={{ paddingRight: 4 }}>y</th>
                <th style={{ paddingRight: 4 }}>vis</th>
              </tr>
            </thead>
            <tbody>
              {KEY_LM.map(({ idx, label }) => {
                const lm = landmarks[idx]
                if (!lm) return null
                const dim = lm.visibility < 0.5
                return (
                  <tr key={idx} style={{ color: dim ? '#555' : '#eee' }}>
                    <td style={{ paddingRight: 6 }}>{label}</td>
                    <td style={{ paddingRight: 4 }}>{lm.x.toFixed(3)}</td>
                    <td style={{ paddingRight: 4 }}>{lm.y.toFixed(3)}</td>
                    <td style={{ color: lm.visibility > 0.7 ? '#4f4' : '#f84' }}>
                      {lm.visibility.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
              {landmarks[11] && landmarks[12] && landmarks[23] && landmarks[24] && (() => {
                const ls = landmarks[11], rs = landmarks[12]
                const lh = landmarks[23], rh = landmarks[24]
                const cx = ((ls.x + rs.x) / 2 + (lh.x + rh.x) / 2) / 2
                const cy = ((ls.y + rs.y) / 2 + (lh.y + rh.y) / 2) / 2
                return (
                  <tr style={{ color: '#0af', borderTop: '1px solid #333' }}>
                    <td style={{ paddingRight: 6 }}>TorsoCenter</td>
                    <td>{cx.toFixed(3)}</td>
                    <td>{cy.toFixed(3)}</td>
                    <td>—</td>
                  </tr>
                )
              })()}
            </tbody>
          </table>
        )}
      </DebugPanel>

      <DebugPanel
        title="Body Rig Frame"
        color="#00d4ff"
        open={showRigPanel}
        onToggle={() => setShowRigPanel(v => !v)}
      >
        {!bodyRigFrame ? (
          <div style={{ color: '#888' }}>Body rig unavailable - waiting for stable shoulders and hips</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%' }}>
            <tbody>
              <tr>
                <td>Twist Y</td>
                <td style={{ textAlign: 'right' }}>{toDegrees(bodyRigFrame.rotation.yaw).toFixed(1)}deg</td>
              </tr>
              <tr>
                <td>Roll Z</td>
                <td style={{ textAlign: 'right' }}>{toDegrees(bodyRigFrame.rotation.roll).toFixed(1)}deg</td>
              </tr>
              <tr>
                <td>Pitch X</td>
                <td style={{ textAlign: 'right' }}>{toDegrees(bodyRigFrame.rotation.pitch).toFixed(1)}deg</td>
              </tr>
              <tr>
                <td>Shoulders</td>
                <td style={{ textAlign: 'right' }}>{bodyRigFrame.widths.shoulder.toFixed(3)}</td>
              </tr>
              <tr>
                <td>Hips</td>
                <td style={{ textAlign: 'right' }}>{bodyRigFrame.widths.hip.toFixed(3)}</td>
              </tr>
              <tr>
                <td>Torso</td>
                <td style={{ textAlign: 'right' }}>{bodyRigFrame.lengths.torso.toFixed(3)}</td>
              </tr>
              <tr>
                <td>Forward</td>
                <td style={{ textAlign: 'right' }}>
                  {bodyRigFrame.axes.forward.x.toFixed(2)} / {bodyRigFrame.axes.forward.y.toFixed(2)} / {bodyRigFrame.axes.forward.z.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td>Anchor</td>
                <td style={{ textAlign: 'right' }}>
                  {bodyRigFrame.anchor.x.toFixed(2)} / {bodyRigFrame.anchor.y.toFixed(2)} / {bodyRigFrame.anchor.z.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td>State</td>
                <td style={{ textAlign: 'right', color: bodyRigFrame.crossedShoulders ? '#f84' : '#8f8' }}>
                  {bodyRigFrame.crossedShoulders ? 'crossed' : 'stable'}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </DebugPanel>

      <DebugPanel
        title="Garment Asset"
        color="#c084fc"
        open={showAssetPanel}
        onToggle={() => setShowAssetPanel(v => !v)}
      >
        <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%' }}>
          <tbody>
            <tr>
              <td>Mode</td>
              <td style={{ textAlign: 'right', color: assetState.riggedReady ? '#8f8' : '#c4b5fd' }}>{assetState.mode}</td>
            </tr>
            <tr>
              <td>Runtime</td>
              <td style={{ textAlign: 'right', color: assetState.runtime?.mode === 'rigged-ready' ? '#8f8' : '#9ae6b4' }}>
                {assetState.runtime?.mode || assetState.mode}
              </td>
            </tr>
            <tr>
              <td>Format</td>
              <td style={{ textAlign: 'right' }}>{GARMENT_ASSET_CONTRACT.format}</td>
            </tr>
            <tr>
              <td>Rigged Ready</td>
              <td style={{ textAlign: 'right', color: assetState.riggedReady ? '#8f8' : '#f84' }}>
                {assetState.riggedReady ? 'yes' : 'no'}
              </td>
            </tr>
            <tr>
              <td>Required Bones</td>
              <td style={{ textAlign: 'right' }}>{GARMENT_ASSET_CONTRACT.skeleton.requiredRoles.length}</td>
            </tr>
            <tr>
              <td>Missing Bones</td>
              <td style={{ textAlign: 'right' }}>{assetState.missingRequiredRoles.length}</td>
            </tr>
            <tr>
              <td>Forearms</td>
              <td style={{ textAlign: 'right', color: assetState.optionalRoleCoverage?.forearmPair ? '#8f8' : '#fbbf24' }}>
                {assetState.optionalRoleCoverage?.forearmPair ? 'pair' : 'partial / none'}
              </td>
            </tr>
            <tr>
              <td>Skinned Meshes</td>
              <td style={{ textAlign: 'right' }}>{assetState.capabilities?.skinnedMeshCount ?? 0}</td>
            </tr>
            <tr>
              <td>Skin Weights</td>
              <td style={{ textAlign: 'right', color: assetState.capabilities?.hasSkinWeights ? '#8f8' : '#f84' }}>
                {assetState.capabilities?.hasSkinWeights ? 'yes' : 'no'}
              </td>
            </tr>
            <tr>
              <td>Mesh Roles</td>
              <td style={{ textAlign: 'right' }}>
                {Object.entries(assetState.meshRoleCounts || {})
                  .filter(([, count]) => count > 0)
                  .map(([role, count]) => `${role}:${count}`)
                  .join(' ') || 'none'}
              </td>
            </tr>
          </tbody>
        </table>

        {!product.model_url && (
          <div style={{ color: '#888', marginTop: 6 }}>
            Waiting for a shirt asset. Drop in a rigged GLB/GLTF and this panel will inspect its skeleton contract.
          </div>
        )}

        {Boolean(assetState.missingRequiredRoles.length) && (
          <div style={{ color: '#fca5a5', marginTop: 6, wordBreak: 'break-word' }}>
            Missing: {assetState.missingRequiredRoles.join(', ')}
          </div>
        )}

        {Boolean(assetState.capabilities?.boneNames?.length) && (
          <div style={{ color: '#aaa', marginTop: 6, wordBreak: 'break-word' }}>
            Bones: {assetState.capabilities.boneNames.slice(0, 8).join(', ')}
            {assetState.capabilities.boneNames.length > 8 ? ' ...' : ''}
          </div>
        )}
      </DebugPanel>
    </div>}
    </>
  )
}

export default ARPopup

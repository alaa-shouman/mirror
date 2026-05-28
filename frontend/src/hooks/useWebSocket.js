import { useState, useEffect, useRef, useCallback } from 'react'

function defaultWebSocketUrl() {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8000/ws/vision'
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const hostname = window.location.hostname
  // Empty hostname occurs in Electron prod (file:// protocol); fall back to loopback
  const host = !hostname || hostname === 'localhost' ? '127.0.0.1' : hostname
  return `${protocol}://${host}:8000/ws/vision`
}

const WS_URL = import.meta.env.VITE_WS_URL || defaultWebSocketUrl()
const DEMO_VISION_ENABLED = import.meta.env.VITE_DEMO_VISION !== 'off'
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 480

// EWA landmark smoothing factor — higher = more responsive, lower = smoother.
// 0.35 gives ~1-frame lag at 30fps while strongly damping per-frame noise.
const LANDMARK_SMOOTH_ALPHA = 0.35

function createLandmark(xPosition, yPosition, zPosition = 0, visibility = 0.96) {
  return {
    x: Number(xPosition.toFixed(4)),
    y: Number(yPosition.toFixed(4)),
    z: Number(zPosition.toFixed(4)),
    visibility,
  }
}

function createDemoLandmarks(timestamp) {
  const sway = Math.sin(timestamp / 900) * 0.025
  const shoulderLift = Math.sin(timestamp / 1300) * 0.01
  const landmarks = Array.from({ length: 33 }, () => createLandmark(0.5, 0.5, 0, 0.2))
  const setLandmark = (index, xPosition, yPosition, zPosition = 0, visibility = 0.96) => {
    landmarks[index] = createLandmark(xPosition + sway, yPosition + shoulderLift, zPosition, visibility)
  }

  setLandmark(0, 0.5, 0.17, -0.18, 0.98)
  setLandmark(11, 0.38, 0.34, -0.06)
  setLandmark(12, 0.62, 0.34, 0.06)
  setLandmark(13, 0.32, 0.48, -0.03)
  setLandmark(14, 0.68, 0.48, 0.03)
  setLandmark(15, 0.30, 0.62, -0.02)
  setLandmark(16, 0.70, 0.62, 0.02)
  setLandmark(23, 0.43, 0.64, -0.03)
  setLandmark(24, 0.57, 0.64, 0.03)
  setLandmark(25, 0.41, 0.82, -0.01)
  setLandmark(26, 0.59, 0.82, 0.01)
  setLandmark(27, 0.40, 0.96, 0)
  setLandmark(28, 0.60, 0.96, 0)

  return landmarks
}

function createDemoFrame(timestamp) {
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = FRAME_WIDTH
  canvas.height = FRAME_HEIGHT
  const context = canvas.getContext('2d')
  const swayPixels = Math.sin(timestamp / 900) * 14

  const background = context.createLinearGradient(0, 0, FRAME_WIDTH, FRAME_HEIGHT)
  background.addColorStop(0, '#111827')
  background.addColorStop(0.55, '#1f2937')
  background.addColorStop(1, '#0a0a0a')
  context.fillStyle = background
  context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT)

  context.fillStyle = 'rgba(255,255,255,0.06)'
  for (let column = 0; column < 8; column += 1) {
    context.fillRect(column * 96 - 12, 0, 32, FRAME_HEIGHT)
  }

  context.fillStyle = 'rgba(0,0,0,0.32)'
  context.fillRect(0, 350, FRAME_WIDTH, 130)

  const centerX = FRAME_WIDTH / 2 + swayPixels
  context.fillStyle = 'rgba(230,236,244,0.20)'
  context.beginPath()
  context.arc(centerX, 86, 34, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = 'rgba(230,236,244,0.18)'
  context.beginPath()
  context.moveTo(centerX - 76, 160)
  context.lineTo(centerX + 76, 160)
  context.lineTo(centerX + 48, 304)
  context.lineTo(centerX - 48, 304)
  context.closePath()
  context.fill()

  context.strokeStyle = 'rgba(224,201,127,0.72)'
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(centerX - 76, 160)
  context.lineTo(centerX - 122, 292)
  context.moveTo(centerX + 76, 160)
  context.lineTo(centerX + 122, 292)
  context.moveTo(centerX - 34, 304)
  context.lineTo(centerX - 44, 454)
  context.moveTo(centerX + 34, 304)
  context.lineTo(centerX + 44, 454)
  context.stroke()

  context.fillStyle = 'rgba(255,255,255,0.72)'
  context.font = '12px system-ui, sans-serif'
  context.fillText('DEMO CAMERA', 24, 34)
  context.fillStyle = 'rgba(224,201,127,0.72)'
  context.fillText('Synthetic pose feed', 24, 54)

  return canvas.toDataURL('image/jpeg', 0.86).split(',', 2)[1]
}

function demoMeasurements() {
  return {
    shoulder_width: 0.24,
    hip_width: 0.15,
    torso_length: 0.31,
    leg_length: 0.48,
  }
}

/**
 * Exponentially weighted average smoothing for MediaPipe landmarks.
 * Reduces per-frame jitter while keeping <1 frame tracking lag at 30fps.
 */
function smoothLandmarks(incoming, previous, alpha) {
  if (!previous || previous.length !== incoming.length) return incoming
  return incoming.map((lm, i) => {
    const p = previous[i]
    if (!p) return lm
    return {
      x: p.x + alpha * (lm.x - p.x),
      y: p.y + alpha * (lm.y - p.y),
      z: p.z + alpha * (lm.z - p.z),
      visibility: lm.visibility, // don't smooth visibility — needed for gating
    }
  })
}

export function useWebSocket() {
  const [landmarks, setLandmarks]               = useState([])
  const [cameraFrame, setCameraFrame]           = useState(null)
  const [segMask, setSegMask]                   = useState(null)
  const [measurements, setMeasurements]         = useState(null)
  const [recommendedSize, setRecommendedSize]   = useState(null)
  const [connected, setConnected]               = useState(false)
  const [source, setSource]                     = useState('disconnected')
  const [cameraError, setCameraError]           = useState(null)

  const wsRef               = useRef(null)
  const reconnectTimer      = useRef(null)
  const noFrameTimer        = useRef(null)
  const demoTimer           = useRef(null)
  const manualCloseRef      = useRef(false)
  const frameCountRef       = useRef(0)
  const smoothedLandmarks   = useRef([])

  const stopDemo = useCallback(() => {
    if (demoTimer.current) {
      clearInterval(demoTimer.current)
      demoTimer.current = null
    }
  }, [])

  const startDemo = useCallback(() => {
    if (!DEMO_VISION_ENABLED || demoTimer.current) return

    const renderDemoFrame = () => {
      const timestamp = Date.now()
      setConnected(true)
      setSource('demo')
      const demoLm = createDemoLandmarks(timestamp)
      smoothedLandmarks.current = demoLm
      setLandmarks(demoLm)
      setCameraFrame(createDemoFrame(timestamp))
      setSegMask(null)
      setMeasurements(demoMeasurements())
      setRecommendedSize('M')
    }

    renderDemoFrame()
    demoTimer.current = setInterval(renderDemoFrame, 100)
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || demoTimer.current) return

    manualCloseRef.current = false
    console.log('[WS] Attempting connection to', WS_URL)
    const ws = new WebSocket(WS_URL)
    ws.__manualClose = false

    ws.onopen = () => {
      stopDemo()
      setCameraError(null)
      console.log('[WS] Connected to backend')
      setConnected(true)
      setSource('live')
      ws.send(JSON.stringify({ action: 'start' }))
      console.log('[WS] Sent {action: start}')

      clearTimeout(noFrameTimer.current)
      noFrameTimer.current = setTimeout(() => {
        if (!DEMO_VISION_ENABLED || wsRef.current !== ws) return
        console.warn('[WS] No camera frames received; starting demo vision fallback')
        wsRef.current = null
        ws.close()
        startDemo()
      }, 4500)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        // Backend camera error — surface it to the UI instead of going to demo
        if (data.error) {
          console.error('[WS] Camera error from backend:', data.error)
          setCameraError(data.error)
          setSource('error')
          return
        }

        frameCountRef.current += 1

        // Clear the no-frame watchdog on every message that carries a frame,
        // regardless of throttle position — prevents spurious demo fallback.
        if (data.frame) {
          clearTimeout(noFrameTimer.current)
          noFrameTimer.current = null
        }

        // Apply EWA smoothing to landmarks on every frame (before throttle check)
        if (data.landmarks) {
          const smoothed = smoothLandmarks(data.landmarks, smoothedLandmarks.current, LANDMARK_SMOOTH_ALPHA)
          smoothedLandmarks.current = smoothed
          setLandmarks(smoothed)
        }

        // Throttle: only push canvas-heavy state every 3rd frame (~10 fps)
        if (frameCountRef.current % 3 !== 0) return

        if (frameCountRef.current % 30 === 0) {
          console.log(`[WS] Frame #${frameCountRef.current}`, {
            hasFrame: !!data.frame,
            frameSize: data.frame?.length,
            landmarkCount: data.landmarks?.length,
            hasMask: !!data.mask,
          })
        }

        if (data.frame)            setCameraFrame(data.frame)
        if (data.mask)             setSegMask(data.mask)
        if (data.measurements)     setMeasurements(data.measurements)
        if (data.recommended_size) setRecommendedSize(data.recommended_size)
      } catch (e) {
        console.error('[WS] Parse error:', e)
      }
    }

    ws.onclose = (event) => {
      wsRef.current = null
      if (demoTimer.current) return
      setConnected(false)
      if (ws.__manualClose || manualCloseRef.current) {
        setSource('disconnected')
        return
      }

      console.warn('[WS] Disconnected. Code:', event.code)
      if (DEMO_VISION_ENABLED) {
        console.warn('[WS] Starting demo vision fallback')
        startDemo()
        return
      }

      setSource('disconnected')
      reconnectTimer.current = setTimeout(connect, 2000)
    }

    ws.onerror = (event) => {
      console.error('[WS] Socket error:', event)
      ws.close()
    }

    wsRef.current = ws
  }, [startDemo, stopDemo])

  useEffect(() => {
    connect()
    return () => {
      manualCloseRef.current = true
      clearTimeout(reconnectTimer.current)
      clearTimeout(noFrameTimer.current)
      stopDemo()
      if (wsRef.current) {
        wsRef.current.__manualClose = true
        wsRef.current.close()
      }
    }
  }, [connect, stopDemo])

  const disconnect = useCallback(() => {
    manualCloseRef.current = true
    clearTimeout(reconnectTimer.current)
    clearTimeout(noFrameTimer.current)
    stopDemo()
    if (wsRef.current) {
      wsRef.current.__manualClose = true
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'stop' }))
      }
      wsRef.current.close()
      wsRef.current = null
    }
    setConnected(false)
    setSource('disconnected')
    setLandmarks([])
    smoothedLandmarks.current = []
    setCameraFrame(null)
    setSegMask(null)
    setMeasurements(null)
    setRecommendedSize(null)
  }, [stopDemo])

  return {
    landmarks,
    cameraFrame,
    segMask,
    measurements,
    recommendedSize,
    connected,
    source,
    cameraError,
    disconnect,
  }
}

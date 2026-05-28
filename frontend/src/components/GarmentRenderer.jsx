import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Component, Suspense, useEffect, useMemo, useRef } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as THREE from 'three'
import { computeBodyRigFrame, updateBodyRigCameraAspect } from '../lib/ar/bodyRig'
import { buildGarmentAdapter, createPendingGarmentAdapter } from '../lib/ar/garmentAdapter'
import {
  applyFallbackStaticDeformation,
  applyFallbackStaticTransform,
  applyRiggedSkeletonDriving,
  solveBodyFrame,
  solveGarmentPoseTargets,
  summarizeGarmentRuntime,
} from '../lib/ar/garmentRuntime'

export const DEFAULT_RIGGED_GARMENT_FIT = {
  width: 2.55,
  height: 1.22,
  depth: 1.45,
  anchorRight: 0,
  anchorUp: 0.2,
  anchorForward: 0.02,
}

function resolveRiggedGarmentFit(fit) {
  return {
    ...DEFAULT_RIGGED_GARMENT_FIT,
    ...(fit || {}),
  }
}

function runtimeStateKey(runtimeState) {
  if (!runtimeState) return 'runtime:none'

  return [
    runtimeState.mode,
    runtimeState.hasBodyFrame ? 'body' : 'nobody',
    runtimeState.poseTargetsReady ? 'targets' : 'notargets',
    runtimeState.forearmsReady ? 'forearms' : 'noforearms',
    runtimeState.channelCount,
  ].join(':')
}

function useGarmentRuntime({
  adapter,
  mirroredAdapters = [],
  deformation = null,
  hasAsset,
  allowMockRig,
  modelUrl,
  landmarks,
  group,
  posOffset,
  rotOffset,
  scaleMult,
  fitProfile,
  riggedFit,
  debug,
  onAssetState,
}) {
  const logCounter = useRef(0)
  const lastRuntimeKey = useRef('')

  useEffect(() => {
    if (!onAssetState || !adapter) return

    const runtime = summarizeGarmentRuntime({
      adapter,
      bodyRigFrame: null,
      poseTargets: null,
      hasAsset,
      mockRig: false,
    })

    lastRuntimeKey.current = runtimeStateKey(runtime)
    onAssetState({ ...adapter, modelUrl, runtime })
  }, [adapter, hasAsset, modelUrl, onAssetState])

  useFrame(() => {
    if (!group.current) return

    const bodyRigFrame = solveBodyFrame({
      landmarks,
      options: {
        posOffset,
        rotOffset,
        scaleMult,
        fitProfile,
      },
    })
    const poseTargets = solveGarmentPoseTargets(bodyRigFrame)
    const resolvedRiggedFit = resolveRiggedGarmentFit(riggedFit)

    if (bodyRigFrame) {
      applyFallbackStaticTransform(group.current, bodyRigFrame, {
        scaleEase: adapter?.riggedReady
          ? {
              x: resolvedRiggedFit.width,
              y: resolvedRiggedFit.height,
              z: resolvedRiggedFit.depth,
            }
          : undefined,
        anchorOffset: adapter?.riggedReady
          ? {
              right: resolvedRiggedFit.anchorRight,
              up: resolvedRiggedFit.anchorUp,
              forward: resolvedRiggedFit.anchorForward,
            }
          : undefined,
      })

      if (adapter?.riggedReady && poseTargets) {
        applyRiggedSkeletonDriving(adapter, poseTargets)
        mirroredAdapters.forEach((mirroredAdapter) => {
          applyRiggedSkeletonDriving(mirroredAdapter, poseTargets)
        })
      } else if (deformation) {
        applyFallbackStaticDeformation(deformation, bodyRigFrame)
      }
    }

    const runtime = summarizeGarmentRuntime({
      adapter,
      bodyRigFrame,
      poseTargets,
      hasAsset,
      mockRig: allowMockRig && Boolean(poseTargets),
    })
    const nextRuntimeKey = runtimeStateKey(runtime)

    if (onAssetState && adapter && nextRuntimeKey !== lastRuntimeKey.current) {
      lastRuntimeKey.current = nextRuntimeKey
      onAssetState({ ...adapter, modelUrl, runtime })
    }

    if (!debug || !bodyRigFrame) return

    logCounter.current += 1
    if (logCounter.current % 60 !== 0) return

    console.log('[BODY_RIG_FRAME]', {
      version: bodyRigFrame.contractVersion,
      widths: bodyRigFrame.widths,
      lengths: bodyRigFrame.lengths,
      rotation: bodyRigFrame.rotation,
      forward: bodyRigFrame.axes.forward,
      scale: bodyRigFrame.garmentScale,
      riggedFit: adapter?.riggedReady ? resolvedRiggedFit : null,
      crossedShoulders: bodyRigFrame.crossedShoulders,
      runtime,
    })
  })
}

function DebugLine({ start, end, color }) {
  const geometry = useMemo(() => {
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [start.x, start.y, start.z, end.x, end.y, end.z],
        3
      )
    )
    return lineGeometry
  }, [start.x, start.y, start.z, end.x, end.y, end.z])

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} />
    </line>
  )
}

function DebugMarker({ point, color = '#ffffff', radius = 0.035 }) {
  return (
    <mesh position={[point.x, point.y, point.z]}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshBasicMaterial color={color} />
    </mesh>
  )
}

function DebugArrow({ start, end, color }) {
  const direction = useMemo(
    () => new THREE.Vector3(end.x - start.x, end.y - start.y, end.z - start.z),
    [end.x, end.y, end.z, start.x, start.y, start.z]
  )
  const length = direction.length()
  const midpoint = useMemo(
    () => [
      start.x + direction.x * 0.5,
      start.y + direction.y * 0.5,
      start.z + direction.z * 0.5,
    ],
    [direction.x, direction.y, direction.z, start.x, start.y, start.z]
  )
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize())
    return q
  }, [direction])

  if (length < 1e-4) return null

  return (
    <group>
      <DebugLine start={start} end={end} color={color} />
      <mesh position={midpoint} quaternion={quaternion}>
        <cylinderGeometry args={[0.01, 0.01, Math.max(length - 0.1, 0.02), 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[end.x, end.y, end.z]} quaternion={quaternion}>
        <coneGeometry args={[0.04, 0.12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function DebugRig({ landmarks, posOffset, rotOffset, scaleMult, fitProfile }) {
  const frame = useMemo(
    () =>
      computeBodyRigFrame(landmarks, {
        posOffset,
        rotOffset,
        scaleMult,
        fitProfile,
      }),
    [fitProfile, landmarks, posOffset, rotOffset, scaleMult]
  )

  if (!frame) return null

  const forwardLength = Math.max(frame.lengths.torso * 0.8, 0.45)
  const forwardTip = {
    x: frame.points.torsoCenter.x + frame.axes.forward.x * forwardLength,
    y: frame.points.torsoCenter.y + frame.axes.forward.y * forwardLength,
    z: frame.points.torsoCenter.z + frame.axes.forward.z * forwardLength,
  }

  return (
    <group>
      <DebugLine start={frame.points.leftShoulder} end={frame.points.rightShoulder} color="#00ff88" />
      <DebugLine start={frame.points.leftHip} end={frame.points.rightHip} color="#ffaa00" />
      <DebugLine start={frame.points.shoulderMid} end={frame.points.hipMid} color="#00d4ff" />
      <DebugArrow start={frame.points.torsoCenter} end={forwardTip} color="#ff4fd8" />

      <DebugMarker point={frame.points.leftShoulder} color="#00ff88" />
      <DebugMarker point={frame.points.rightShoulder} color="#00ff88" />
      <DebugMarker point={frame.points.leftHip} color="#ffaa00" />
      <DebugMarker point={frame.points.rightHip} color="#ffaa00" />
      <DebugMarker point={frame.anchor} color="#ffffff" radius={0.045} />
    </group>
  )
}

function PlaceholderGarment({
  landmarks,
  posOffset,
  rotOffset,
  scaleMult,
  fitProfile,
  riggedFit,
  debug,
  onAssetState,
}) {
  const group = useRef()
  const pendingAdapter = useMemo(() => createPendingGarmentAdapter(), [])

  useGarmentRuntime({
    adapter: pendingAdapter,
    hasAsset: false,
    allowMockRig: true,
    modelUrl: null,
    landmarks,
    group,
    posOffset,
    rotOffset,
    scaleMult,
    fitProfile,
    riggedFit,
    debug,
    onAssetState,
  })

  return (
    <group ref={group}>
      <mesh>
        <boxGeometry args={[1, 1.2, 0.25]} />
        <meshStandardMaterial color="#3b82f6" transparent opacity={0.75} />
      </mesh>
      <mesh position={[-0.7, 0.35, 0]}>
        <boxGeometry args={[0.4, 0.35, 0.22]} />
        <meshStandardMaterial color="#3b82f6" transparent opacity={0.75} />
      </mesh>
      <mesh position={[0.7, 0.35, 0]}>
        <boxGeometry args={[0.4, 0.35, 0.22]} />
        <meshStandardMaterial color="#3b82f6" transparent opacity={0.75} />
      </mesh>
      <mesh position={[0, 0.65, 0]}>
        <torusGeometry args={[0.18, 0.06, 8, 16]} />
        <meshStandardMaterial color="#2563eb" />
      </mesh>
    </group>
  )
}

function GarmentModel({
  modelUrl,
  landmarks,
  posOffset,
  rotOffset,
  scaleMult,
  fitProfile,
  riggedFit,
  debug,
  onAssetState,
}) {
  const gltf = useLoader(GLTFLoader, modelUrl)
  const group = useRef()

  const { sceneFront, center, invSize, deformation, adapter } = useMemo(() => {
    const prepareClone = (rotationY) => {
      const clone = cloneSkinnedScene(gltf.scene)
      clone.rotation.y = rotationY
      clone.traverse((node) => {
        if (!node.isMesh && !node.isSkinnedMesh) return
        node.castShadow = true
        node.receiveShadow = true

        if (!node.material) return

        if (Array.isArray(node.material)) {
          node.material = node.material.map((material) => {
            const nextMaterial = material.clone()
            nextMaterial.side = THREE.DoubleSide
            return nextMaterial
          })
          return
        }

        node.material = node.material.clone()
        node.material.side = THREE.DoubleSide
      })
      return clone
    }

    const front = prepareClone(Math.PI)

    front.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(front)
    const size = new THREE.Vector3()
    const measuredCenter = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(measuredCenter)

    const nextAdapter = buildGarmentAdapter(front)
    const nextDeformation = nextAdapter.mode === 'fallback-static'
      ? (() => {
          const meshData = []
          let yMin = Infinity
          let yMax = -Infinity

          const capture = (root) => {
            root.traverse((node) => {
              if ((!node.isMesh && !node.isSkinnedMesh) || !node.geometry?.attributes?.position) return
              const position = node.geometry.attributes.position
              const original = new Float32Array(position.array.length)
              original.set(position.array)
              meshData.push({ mesh: node, original })

              for (let index = 0; index < position.count; index += 1) {
                const y = position.getY(index)
                if (y < yMin) yMin = y
                if (y > yMax) yMax = y
              }
            })
          }

          capture(front)

          return {
            meshData,
            yMin,
            yRange: (yMax - yMin) || 1,
          }
        })()
      : null

    return {
      sceneFront: front,
      center: measuredCenter,
      invSize: [1 / (size.x || 1), 1 / (size.y || 1), 1 / (size.z || 1)],
      deformation: nextDeformation,
      adapter: nextAdapter,
    }
  }, [gltf])

  useGarmentRuntime({
    adapter,
    mirroredAdapters: [],
    deformation,
    hasAsset: true,
    allowMockRig: false,
    modelUrl,
    landmarks,
    group,
    posOffset,
    rotOffset,
    scaleMult,
    fitProfile,
    riggedFit,
    debug,
    onAssetState,
  })

  useEffect(() => {
    if (!debug) return
    console.log('[GARMENT_ADAPTER]', adapter)
  }, [adapter, debug])

  return (
    <group ref={group}>
      <group scale={invSize}>
        <group position={[-center.x, -center.y, -center.z]}>
          <primitive object={sceneFront} />
        </group>
      </group>
    </group>
  )
}

/** Keeps bodyRig.js WORLD_WIDTH in sync with the actual Three.js camera aspect. */
function CameraAspectSync() {
  const { camera } = useThree()
  useEffect(() => {
    updateBodyRigCameraAspect(camera.aspect)
  }, [camera.aspect])
  return null
}

class GarmentErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('[GarmentRenderer] Canvas error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', color: '#f87171',
          fontSize: 13, fontFamily: 'monospace', textAlign: 'center', padding: 16,
        }}>
          Garment failed to load
          <br />
          <span style={{ color: '#888', fontSize: 11 }}>{String(this.state.error?.message || this.state.error)}</span>
        </div>
      )
    }
    return this.props.children
  }
}

function GarmentRenderer({
  modelUrl,
  landmarks,
  posOffset,
  rotOffset,
  scaleMult,
  fitProfile,
  riggedFit,
  debug = false,
  onAssetState,
}) {
  return (
    <GarmentErrorBoundary>
    <Canvas
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
      }}
      camera={{ position: [0, 0, 3], fov: 55 }}
      gl={{ alpha: true, antialias: true }}
    >
      <CameraAspectSync />
      <ambientLight intensity={0.55} />
      <directionalLight position={[2, 4, 2]} intensity={1.15} castShadow />
      <directionalLight position={[-2, 2, -2]} intensity={0.35} />
      <hemisphereLight args={[0xf0f0ff, 0x303030, 0.35]} />

      <Suspense fallback={null}>
        {modelUrl ? (
          <GarmentModel
            modelUrl={modelUrl}
            landmarks={landmarks}
            posOffset={posOffset}
            rotOffset={rotOffset}
            scaleMult={scaleMult}
            fitProfile={fitProfile}
            riggedFit={riggedFit}
            debug={debug}
            onAssetState={onAssetState}
          />
        ) : (
          <PlaceholderGarment
            landmarks={landmarks}
            posOffset={posOffset}
            rotOffset={rotOffset}
            scaleMult={scaleMult}
            fitProfile={fitProfile}
            debug={debug}
            onAssetState={onAssetState}
          />
        )}

        {debug && (
          <DebugRig
            landmarks={landmarks}
            posOffset={posOffset}
            rotOffset={rotOffset}
            scaleMult={scaleMult}
            fitProfile={fitProfile}
          />
        )}
      </Suspense>
    </Canvas>
    </GarmentErrorBoundary>
  )
}

export default GarmentRenderer

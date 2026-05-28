import * as THREE from 'three'

// ─── Camera projection constants ────────────────────────────────────────────
// The AR viewport is forced to 4:3 in CSS; the Three.js camera sits at z=3
// with a 55° vertical FOV.  Landmarks must map to exactly the same world
// positions as the corresponding pixels in the camera feed.
//
// visibleHeight = 2 * camZ * tan(vFov/2) = 2 * 3 * tan(27.5°) ≈ 3.124
// visibleWidth  = visibleHeight * aspect  = 3.124 * (4/3)       ≈ 4.165
//
// These are exported so GarmentRenderer can override them when the Three.js
// canvas reports a different aspect via useThree().camera.aspect.
export const CAMERA_Z = 3
export const CAMERA_VFOV_DEG = 55
export let WORLD_HEIGHT = 2 * CAMERA_Z * Math.tan((CAMERA_VFOV_DEG * Math.PI) / 360) // ≈ 3.124
export let WORLD_WIDTH = WORLD_HEIGHT * (4 / 3) // ≈ 4.165

/** Call this from GarmentRenderer once the R3F camera reports its actual aspect. */
export function updateBodyRigCameraAspect(aspect) {
  WORLD_WIDTH = WORLD_HEIGHT * aspect
}

export const BODY_RIG_LANDMARKS = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
}

export const BODY_RIG_MIN_LANDMARKS = 29
export const BODY_RIG_MIN_VISIBILITY = 0.65

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function hasSufficientVisibility(landmark, minVisibility) {
  return Boolean(landmark) && (landmark.visibility ?? 0) >= minVisibility
}

function midpointLandmark(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility ?? 0, b.visibility ?? 0),
  }
}

function normalizeOrFallback(vector, fallback) {
  if (vector.lengthSq() < 1e-6) return fallback.clone()
  return vector.normalize()
}

function toPlainVector(vector) {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  }
}

export function landmarkToWorldVector(landmark) {
  return new THREE.Vector3(
    (landmark.x - 0.5) * WORLD_WIDTH,
    -(landmark.y - 0.5) * WORLD_HEIGHT,
    landmark.z * -1.5
  )
}

export function fitProfileAxisMultipliers(profile) {
  if (!profile || profile.skipped) return { width: 1, height: 1 }

  const referenceChest = 96
  const referenceHeight = 170

  return {
    width: clamp((profile.chest || referenceChest) / referenceChest, 0.85, 1.25),
    height: clamp((profile.height || referenceHeight) / referenceHeight, 0.85, 1.25),
  }
}

export function computeBodyRigFrame(landmarks, options = {}) {
  const {
    posOffset = { x: 0, y: 0, z: 0 },
    rotOffset = { x: 0, y: 0, z: 0 },
    scaleMult = 1,
    fitProfile = null,
    minVisibility = BODY_RIG_MIN_VISIBILITY,
  } = options

  if (!Array.isArray(landmarks) || landmarks.length < BODY_RIG_MIN_LANDMARKS) {
    return null
  }

  const lm = BODY_RIG_LANDMARKS
  const leftShoulder = landmarks[lm.LEFT_SHOULDER]
  const rightShoulder = landmarks[lm.RIGHT_SHOULDER]
  const leftElbow = landmarks[lm.LEFT_ELBOW]
  const rightElbow = landmarks[lm.RIGHT_ELBOW]
  const leftWrist = landmarks[lm.LEFT_WRIST]
  const rightWrist = landmarks[lm.RIGHT_WRIST]
  const leftHip = landmarks[lm.LEFT_HIP]
  const rightHip = landmarks[lm.RIGHT_HIP]

  if (!leftShoulder || !rightShoulder) {
    return null
  }

  if (
    !hasSufficientVisibility(leftShoulder, minVisibility) ||
    !hasSufficientVisibility(rightShoulder, minVisibility)
  ) {
    return null
  }

  const hipsVisible =
    hasSufficientVisibility(leftHip, minVisibility) &&
    hasSufficientVisibility(rightHip, minVisibility)

  const shoulderMidLandmark = midpointLandmark(leftShoulder, rightShoulder)
  const leftShoulderVector = landmarkToWorldVector(leftShoulder)
  const rightShoulderVector = landmarkToWorldVector(rightShoulder)
  const shoulderMidVector = landmarkToWorldVector(shoulderMidLandmark)
  const shoulderWidth = leftShoulderVector.distanceTo(rightShoulderVector)

  if (shoulderWidth < 1e-4) {
    return null
  }

  const rightAxis = normalizeOrFallback(
    rightShoulderVector.clone().sub(leftShoulderVector),
    new THREE.Vector3(1, 0, 0)
  )

  let leftHipVector
  let rightHipVector
  let hipMidVector
  let torsoCenterVector
  let anchorVector
  let hipWidth
  let torsoHeight

  if (hipsVisible) {
    const hipMidLandmark = midpointLandmark(leftHip, rightHip)
    const torsoCenterLandmark = midpointLandmark(shoulderMidLandmark, hipMidLandmark)
    const anchorLandmark = {
      x: torsoCenterLandmark.x * 0.75 + shoulderMidLandmark.x * 0.25,
      y: torsoCenterLandmark.y * 0.75 + shoulderMidLandmark.y * 0.25,
      z: torsoCenterLandmark.z * 0.75 + shoulderMidLandmark.z * 0.25,
    }

    leftHipVector = landmarkToWorldVector(leftHip)
    rightHipVector = landmarkToWorldVector(rightHip)
    hipMidVector = landmarkToWorldVector(hipMidLandmark)
    torsoCenterVector = landmarkToWorldVector(torsoCenterLandmark)
    anchorVector = landmarkToWorldVector(anchorLandmark).add(
      new THREE.Vector3(posOffset.x, posOffset.y, posOffset.z)
    )
    hipWidth = leftHipVector.distanceTo(rightHipVector)
    torsoHeight = shoulderMidVector.distanceTo(hipMidVector)
  } else {
    const estimatedTorsoHeight = shoulderWidth * 1.35
    const estimatedHipHalfWidth = shoulderWidth * 0.32

    hipMidVector = shoulderMidVector.clone().add(new THREE.Vector3(0, -estimatedTorsoHeight, 0))
    leftHipVector = hipMidVector.clone().addScaledVector(rightAxis, -estimatedHipHalfWidth)
    rightHipVector = hipMidVector.clone().addScaledVector(rightAxis, estimatedHipHalfWidth)
    torsoCenterVector = shoulderMidVector.clone().lerp(hipMidVector, 0.5)
    anchorVector = torsoCenterVector
      .clone()
      .lerp(shoulderMidVector, 0.25)
      .add(new THREE.Vector3(posOffset.x, posOffset.y, posOffset.z))
    hipWidth = leftHipVector.distanceTo(rightHipVector)
    torsoHeight = shoulderMidVector.distanceTo(hipMidVector)
  }

  if (torsoHeight < 1e-4) {
    return null
  }
  const upAxis = normalizeOrFallback(
    shoulderMidVector.clone().sub(hipMidVector),
    new THREE.Vector3(0, 1, 0)
  )
  const forwardAxis = normalizeOrFallback(
    new THREE.Vector3().crossVectors(rightAxis, upAxis),
    new THREE.Vector3(0, 0, 1)
  )

  if (forwardAxis.z < 0) {
    forwardAxis.negate()
  }

  const shouldersCrossed = rightShoulderVector.x < leftShoulderVector.x
  const rawRoll = shouldersCrossed
    ? 0
    : clamp(
        Math.atan2(
          rightShoulderVector.y - leftShoulderVector.y,
          rightShoulderVector.x - leftShoulderVector.x
        ),
        -0.6,
        0.6
      )

  const shoulderYaw = (rightShoulder.z - leftShoulder.z) * 1.8
  const hipYaw = (rightHip.z - leftHip.z) * 1.2
  const rawYaw = shoulderYaw * 0.7 + hipYaw * 0.3
  const rawPitch = clamp(
    Math.atan2(shoulderMidVector.z - hipMidVector.z, torsoHeight),
    -0.45,
    0.45
  )

  const fitScale = fitProfileAxisMultipliers(fitProfile)
  const leftUpperArmLength = leftElbow
    ? leftShoulderVector.distanceTo(landmarkToWorldVector(leftElbow))
    : 0
  const rightUpperArmLength = rightElbow
    ? rightShoulderVector.distanceTo(landmarkToWorldVector(rightElbow))
    : 0
  const leftForearmLength = leftWrist && leftElbow
    ? landmarkToWorldVector(leftElbow).distanceTo(landmarkToWorldVector(leftWrist))
    : 0
  const rightForearmLength = rightWrist && rightElbow
    ? landmarkToWorldVector(rightElbow).distanceTo(landmarkToWorldVector(rightWrist))
    : 0

  const confidence = hipsVisible
    ? ((leftShoulder.visibility ?? 0) +
        (rightShoulder.visibility ?? 0) +
        (leftHip.visibility ?? 0) +
        (rightHip.visibility ?? 0)) /
      4
    : (((leftShoulder.visibility ?? 0) + (rightShoulder.visibility ?? 0)) / 2) * 0.78

  // Width: shirt shoulders sit just beyond the shoulder joints → 1.22×
  // Height: shirt hem ~ hip level, collar ~ shoulder level → 1.08× torso
  // Depth: proportional to shoulder width for a plausible 3-D volume
  const widthScaleFactor = hipsVisible ? 1.22 : 1.45
  const heightScaleFactor = hipsVisible ? 1.08 : 1.18
  const depthScaleFactor = hipsVisible ? 0.58 : 0.72

  return {
    contractVersion: 'body-rig-frame/v1',
    confidence,
    crossedShoulders: shouldersCrossed,
    estimatedLowerBody: !hipsVisible,
    anchor: toPlainVector(anchorVector),
    points: {
      leftShoulder: toPlainVector(leftShoulderVector),
      rightShoulder: toPlainVector(rightShoulderVector),
      leftHip: toPlainVector(leftHipVector),
      rightHip: toPlainVector(rightHipVector),
      shoulderMid: toPlainVector(shoulderMidVector),
      hipMid: toPlainVector(hipMidVector),
      torsoCenter: toPlainVector(torsoCenterVector),
      leftElbow: leftElbow ? toPlainVector(landmarkToWorldVector(leftElbow)) : null,
      rightElbow: rightElbow ? toPlainVector(landmarkToWorldVector(rightElbow)) : null,
      leftWrist: leftWrist ? toPlainVector(landmarkToWorldVector(leftWrist)) : null,
      rightWrist: rightWrist ? toPlainVector(landmarkToWorldVector(rightWrist)) : null,
    },
    axes: {
      right: toPlainVector(rightAxis),
      up: toPlainVector(upAxis),
      forward: toPlainVector(forwardAxis),
    },
    widths: {
      shoulder: shoulderWidth,
      hip: hipWidth,
    },
    lengths: {
      torso: torsoHeight,
      leftUpperArm: leftUpperArmLength,
      rightUpperArm: rightUpperArmLength,
      leftForearm: leftForearmLength,
      rightForearm: rightForearmLength,
    },
    fitScale,
    garmentScale: {
      x: shoulderWidth * widthScaleFactor * scaleMult * fitScale.width,
      y: torsoHeight * heightScaleFactor * scaleMult * fitScale.height,
      z: shoulderWidth * depthScaleFactor * scaleMult * fitScale.width,
    },
    rotation: {
      yaw: rawYaw,
      pitch: rawPitch,
      roll: rawRoll,
      yawWithOffset: rawYaw + rotOffset.y,
      pitchWithOffset: rawPitch + rotOffset.x,
      rollWithOffset: rawRoll + rotOffset.z,
    },
  }
}
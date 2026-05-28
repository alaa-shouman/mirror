import asyncio
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from modules.camera import CameraManager
from modules.pose import PoseDetector
from modules.garment import extract_measurements, recommend_size

router = APIRouter()

# Dedicated thread pool for blocking camera/CV operations
_executor = ThreadPoolExecutor(max_workers=2)

# Shared camera singleton — avoids multiple clients fighting over /dev/video0.
# Reference-counted so the device is released only when the last client disconnects.
_camera_instance: CameraManager | None = None
_camera_refcount = 0


def _acquire_camera() -> CameraManager:
    global _camera_instance, _camera_refcount
    if _camera_instance is None:
        _camera_instance = CameraManager()
    _camera_refcount += 1
    return _camera_instance


def _release_camera() -> None:
    global _camera_instance, _camera_refcount
    _camera_refcount = max(0, _camera_refcount - 1)
    if _camera_refcount == 0 and _camera_instance is not None:
        _camera_instance.stop()
        _camera_instance = None


def _capture_and_detect(camera: CameraManager, detector: PoseDetector):
    """Runs in a thread: capture frame + run MediaPipe pose detection.
    Both operations are CPU-blocking and must NOT run on the asyncio event loop."""
    frame, frame_b64 = camera.get_frame()
    if frame is None:
        return None
    landmarks, mask_b64 = detector.detect(frame)

    measurements = extract_measurements(landmarks) if len(landmarks) >= 33 else {}
    size = recommend_size(measurements) if measurements else None

    return {
        "frame": frame_b64,
        "mask": mask_b64,
        "landmarks": landmarks,
        "measurements": measurements,
        "recommended_size": size,
    }


@router.websocket("/ws/vision")
async def vision_websocket(websocket: WebSocket):
    await websocket.accept()
    camera = _acquire_camera()
    pose_detector = PoseDetector()
    streaming = False
    loop = asyncio.get_running_loop()

    try:
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.01)
                data = json.loads(msg)
                if data.get("action") == "start" and not streaming:
                    try:
                        await loop.run_in_executor(_executor, camera.start)
                        streaming = True
                    except RuntimeError as exc:
                        print(f"[vision] Camera start failed: {exc}", file=sys.stderr)
                        await websocket.send_text(json.dumps({"error": str(exc)}))
                        # Keep streaming=False so the loop stays alive and the
                        # client can receive the error and display it.
                elif data.get("action") == "stop":
                    streaming = False
                    await loop.run_in_executor(_executor, camera.stop)
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                raise
            except Exception as exc:
                print(f"[vision] Control message error: {exc}", file=sys.stderr)

            if not streaming:
                await asyncio.sleep(0.05)
                continue

            try:
                payload = await loop.run_in_executor(
                    _executor, _capture_and_detect, camera, pose_detector
                )
            except Exception as exc:
                print(f"[vision] Capture/detect error: {exc}", file=sys.stderr)
                await asyncio.sleep(0.1)
                continue

            if payload is None:
                await asyncio.sleep(0.03)
                continue

            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(0.033)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[vision] Unexpected error: {exc}", file=sys.stderr)
    finally:
        _release_camera()
        pose_detector.close()

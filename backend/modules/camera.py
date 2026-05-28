import base64
import os
import platform
import sys
import cv2

# Set MIRROR_CAMERA=1 in backend/.env for kiosk magic-mirror mode (horizontal flip).
_MIRROR = os.environ.get("MIRROR_CAMERA", "0") == "1"

# Camera indices to probe in order before giving up.
_PROBE_INDICES = [0, 1, 2, 3]


def _platform_backends():
    """Return a prioritised list of OpenCV backends for the current OS."""
    system = platform.system()
    if system == "Darwin":
        return [cv2.CAP_AVFOUNDATION]
    if system == "Windows":
        return [cv2.CAP_DSHOW, cv2.CAP_ANY]
    # Linux / RPi (fallback handled separately via Picamera2)
    return [cv2.CAP_V4L2, cv2.CAP_ANY]


class CameraManager:
    """Camera abstraction: uses Picamera2 on RPi, probes OpenCV indices on everything else."""

    def __init__(self):
        self._cap = None
        self._picam = None
        self._use_picam = False

    def start(self):
        if self._cap is not None or self._picam is not None:
            return  # Already open

        # --- Raspberry Pi: Picamera2 ---
        try:
            from picamera2 import Picamera2
            self._picam = Picamera2()
            self._picam.configure(
                self._picam.create_preview_configuration(
                    main={"size": (640, 480), "format": "RGB888"}
                )
            )
            self._picam.start()
            self._use_picam = True
            print("[camera] Picamera2 opened successfully", file=sys.stderr)
            return
        except ImportError:
            pass  # Not on RPi
        except Exception as exc:
            print(f"[camera] Picamera2 unavailable: {exc}", file=sys.stderr)

        # --- Desktop / dev machine: probe OpenCV backends ---
        backends = _platform_backends()
        errors = []

        for index in _PROBE_INDICES:
            for backend in backends:
                try:
                    cap = cv2.VideoCapture(index, backend)
                    if not cap.isOpened():
                        cap.release()
                        continue

                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                    cap.set(cv2.CAP_PROP_FPS, 30)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                    # Verify we can actually read a frame
                    ret, _ = cap.read()
                    if ret:
                        self._cap = cap
                        print(
                            f"[camera] Opened index={index} backend={backend} "
                            f"({platform.system()})",
                            file=sys.stderr,
                        )
                        return

                    cap.release()
                    errors.append(f"index={index} backend={backend}: opened but no frame")
                except Exception as exc:
                    errors.append(f"index={index} backend={backend}: {exc}")

        detail = "; ".join(errors) if errors else "no cameras probed"
        hint = (
            "On macOS grant Terminal camera access in "
            "System Preferences → Privacy & Security → Camera."
            if platform.system() == "Darwin"
            else "Check that no other app is holding the camera."
        )
        raise RuntimeError(
            f"No camera found (checked indices 0-{_PROBE_INDICES[-1]}). {hint} Details: {detail}"
        )

    def get_frame(self):
        """Returns (frame_bgr, frame_base64_jpeg) or (None, None)."""
        frame = None

        if self._use_picam and self._picam:
            try:
                frame_rgb = self._picam.capture_array()
                frame = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
            except Exception as exc:
                print(f"[camera] Picamera2 capture error: {exc}", file=sys.stderr)
                return None, None
        elif self._cap and self._cap.isOpened():
            ret, frame = self._cap.read()
            if not ret:
                return None, None

        if frame is None:
            return None, None

        if _MIRROR:
            frame = cv2.flip(frame, 1)

        _, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 72])
        frame_b64 = base64.b64encode(buffer).decode("utf-8")
        return frame, frame_b64

    def stop(self):
        if self._picam:
            try:
                self._picam.stop()
            except Exception:
                pass
            self._picam = None
            self._use_picam = False

        if self._cap:
            self._cap.release()
            self._cap = None

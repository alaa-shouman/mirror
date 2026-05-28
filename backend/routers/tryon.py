"""Virtual try-on endpoint backed by HuggingFace WeShopAI Space.

Takes a user snapshot + a product id, runs the WeShopAI Gradio Space
(IDM-VTON family) in a thread pool, and returns the photorealistic
result as a base64 data URL. Typical latency: 40-90 seconds.
"""

from __future__ import annotations

import asyncio
import base64
from io import BytesIO
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
from urllib.request import urlopen

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from gradio_client import Client, handle_file
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

from db.database import SessionLocal
from db.models import Product


load_dotenv()  # reads backend/.env next to main.py
router = APIRouter()

_executor = ThreadPoolExecutor(max_workers=2)
_client: Optional[Client] = None
SPACE_ID = "WeShopAI/WeShopAI-Virtual-Try-On"


def _hf_token() -> Optional[str]:
    """HF_TOKEN from environment. Set it in backend/.env."""
    return os.environ.get("HF_TOKEN") or None


def _get_client() -> Client:
    global _client
    if _client is None:
        token = _hf_token()
        if not token:
            raise RuntimeError("HF_TOKEN not configured")
        _client = Client(SPACE_ID, hf_token=token, verbose=False)
    return _client


def _open_user_image(person_data_url: str) -> Image.Image:
    b64 = person_data_url.split(",", 1)[1] if "," in person_data_url else person_data_url
    return Image.open(BytesIO(base64.b64decode(b64))).convert("RGBA")


def _draw_rounded_rectangle(draw: ImageDraw.ImageDraw, box, radius: int, fill):
    left, top, right, bottom = box
    draw.rounded_rectangle((left, top, right, bottom), radius=radius, fill=fill)


def _build_demo_tryon(person_data_url: str, product_name: str, size: Optional[str] = None) -> bytes:
    """Build a clearly labeled local preview when live AI try-on is unavailable."""
    image = _open_user_image(person_data_url)
    width, height = image.size
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    torso_width = int(width * 0.34)
    torso_height = int(height * 0.38)
    torso_left = int((width - torso_width) / 2)
    torso_top = int(height * 0.27)
    torso_right = torso_left + torso_width
    torso_bottom = torso_top + torso_height
    sleeve_width = int(width * 0.12)
    sleeve_height = int(height * 0.15)

    garment_color = (43, 103, 210, 185)
    garment_shadow = (18, 35, 72, 115)
    _draw_rounded_rectangle(draw, (torso_left, torso_top, torso_right, torso_bottom), 26, garment_color)
    _draw_rounded_rectangle(
        draw,
        (torso_left - sleeve_width, torso_top + 26, torso_left + 20, torso_top + sleeve_height),
        22,
        garment_color,
    )
    _draw_rounded_rectangle(
        draw,
        (torso_right - 20, torso_top + 26, torso_right + sleeve_width, torso_top + sleeve_height),
        22,
        garment_color,
    )
    _draw_rounded_rectangle(draw, (torso_left + 20, torso_top + 18, torso_right - 20, torso_top + 58), 18, garment_shadow)

    badge_height = max(54, int(height * 0.10))
    draw.rectangle((0, height - badge_height, width, height), fill=(0, 0, 0, 168))
    font = ImageFont.load_default()
    label = "Demo preview - live AI try-on unavailable"
    product_label = product_name if not size else f"{product_name} / {size}"
    draw.text((18, height - badge_height + 12), label, fill=(255, 255, 255, 235), font=font)
    draw.text((18, height - badge_height + 32), product_label[:64], fill=(224, 201, 127, 245), font=font)

    composed = Image.alpha_composite(image, overlay).convert("RGB")
    buffer = BytesIO()
    composed.save(buffer, format="PNG")
    return buffer.getvalue()


def _run_tryon_blocking(person_data_url: str, garment_url: str) -> bytes:
    """Calls the Gradio Space. Blocking — runs on the thread pool."""
    # Unpack data URL → raw JPEG bytes → temp file
    b64 = person_data_url.split(",", 1)[1] if "," in person_data_url else person_data_url
    person_bytes = base64.b64decode(b64)
    fd, person_path = tempfile.mkstemp(suffix=".jpg", prefix="sfai_tryon_")
    os.close(fd)
    Path(person_path).write_bytes(person_bytes)

    try:
        client = _get_client()
        # WeShopAI arg naming is counter-intuitive:
        #   main_image       → the GARMENT (the item you want applied)
        #   background_image → the PERSON (the scene/subject onto whom the item lands)
        # Verified empirically — swapping produces the wrong result.
        result = client.predict(
            main_image=handle_file(garment_url),
            background_image=handle_file(person_path),
            api_name="/generate_image",
        )
        # gradio_client may return a filepath, dict, list, or data URL depending on Space config.
        result_path = None
        if isinstance(result, (bytes, bytearray)):
            return bytes(result)
        if isinstance(result, dict):
            result_path = result.get("path") or result.get("url") or result.get("data")
        elif isinstance(result, (list, tuple)):
            for item in result:
                if isinstance(item, (bytes, bytearray)):
                    return bytes(item)
                if isinstance(item, dict):
                    result_path = item.get("path") or item.get("url") or item.get("data")
                    if result_path:
                        break
                if isinstance(item, str):
                    result_path = item
                    break
        elif isinstance(result, str):
            result_path = result

        if not result_path:
            raise RuntimeError(f"Unexpected try-on result type: {type(result).__name__}")

        if result_path.startswith("data:"):
            _, b64_data = result_path.split(",", 1)
            return base64.b64decode(b64_data)

        if result_path.startswith("http://") or result_path.startswith("https://"):
            with urlopen(result_path) as response:
                return response.read()

        return Path(result_path).read_bytes()
    finally:
        try:
            os.unlink(person_path)
        except OSError:
            pass


class TryonRequest(BaseModel):
    user_image: str  # data URL (data:image/jpeg;base64,...)
    product_id: int
    size: Optional[str] = None


@router.post("/virtual-tryon")
async def virtual_tryon(req: TryonRequest):
    db = SessionLocal()
    try:
        product = db.query(Product).filter(Product.id == req.product_id).first()
        if not product:
            raise HTTPException(404, "product not found")
        # Prefer a dedicated flat-lay/garment-only image; fall back to the product photo
        garment_url = product.garment_image or product.image
        if not garment_url:
            raise HTTPException(400, "product has no reference image")
        product_name = product.name
    finally:
        db.close()

    def demo_response(reason: str):
        result_bytes = _build_demo_tryon(req.user_image, product_name, req.size)
        result_b64 = base64.b64encode(result_bytes).decode("ascii")
        return {
            "image": f"data:image/png;base64,{result_b64}",
            "duration_ms": 0,
            "product_id": req.product_id,
            "mode": "demo",
            "message": reason,
        }

    if os.environ.get("DEMO_TRYON_FALLBACK", "1") != "0" and not _hf_token():
        return demo_response("HF_TOKEN is not configured, so a local demo preview was generated.")

    t0 = time.time()
    loop = asyncio.get_running_loop()
    try:
        result_bytes = await loop.run_in_executor(
            _executor, _run_tryon_blocking, req.user_image, garment_url
        )
    except RuntimeError as error:
        if os.environ.get("DEMO_TRYON_FALLBACK", "1") != "0":
            return demo_response(str(error))
        raise HTTPException(500, str(error))
    except Exception as error:
        if os.environ.get("DEMO_TRYON_FALLBACK", "1") != "0":
            message = f"Live try-on failed: {type(error).__name__}"
            details = str(error).strip()
            if details:
                message = f"{message}: {details[:200]}"
            return demo_response(message + ".")
        raise HTTPException(502, f"try-on upstream failed: {type(error).__name__}: {str(error)[:200]}")

    duration_ms = int((time.time() - t0) * 1000)
    result_b64 = base64.b64encode(result_bytes).decode("ascii")
    return {
        "image": f"data:image/png;base64,{result_b64}",
        "duration_ms": duration_ms,
        "product_id": req.product_id,
        "mode": "live",
    }

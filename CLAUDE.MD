# Smart Fit AI Mirror — Project Specification & Technical Reference

Version: 1.2 (updated after codebase audit May 2026)

---

## 1. Project Overview

The Smart Fit AI Mirror is a kiosk application designed to run on a Raspberry Pi 5 with a two-way mirror. It presents a digital retail storefront and provides real-time AR garment overlay using a camera + MediaPipe body detection, plus a diffusion-based AI virtual try-on via HuggingFace.

**Stack:**
- **Frontend:** React 18 + Vite (port 3000), Three.js / React Three Fiber for 3D garment rendering
- **Backend:** FastAPI + Uvicorn (port 8000), SQLite via SQLAlchemy, MediaPipe, OpenCV
- **Shell:** Electron 33 (kiosk wrapper, loads frontend)
- **AI Try-on:** HuggingFace Gradio — WeShopAI/WeShopAI-Virtual-Try-On (IDM-VTON family)

---

## 2. Repo Structure

```
mirror/
├── backend/
│   ├── main.py               # FastAPI app, CORS, router registration, DB seed
│   ├── requirements.txt
│   ├── db/
│   │   ├── database.py       # SQLAlchemy engine + SessionLocal
│   │   ├── models.py         # Product, CartItem ORM models
│   │   ├── seed.py           # SAMPLE_PRODUCTS list + seed() function
│   │   └── set_model.py      # CLI helper: assign a GLB to a product by ID
│   ├── modules/
│   │   ├── camera.py         # CameraManager (Picamera2 / OpenCV fallback)
│   │   ├── pose.py           # PoseDetector (MediaPipe Pose + segmentation)
│   │   └── garment.py        # extract_measurements, recommend_size
│   └── routers/
│       ├── products.py       # GET /api/products, GET /api/products/{id}
│       ├── cart.py           # GET/POST /api/cart, DELETE /api/cart/{id}
│       ├── vision.py         # WS /ws/vision — camera + pose streaming
│       └── tryon.py          # POST /api/virtual-tryon — HF AI try-on
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Root: routes, cart state (local only)
│   │   ├── pages/
│   │   │   ├── Landing.jsx   # Product grid with category filters
│   │   │   └── ProductDetail.jsx  # Product info + AR trigger
│   │   ├── components/
│   │   │   ├── ARPopup.jsx   # AR popup: canvas layers + WebSocket + debug panel
│   │   │   ├── GarmentRenderer.jsx # R3F Canvas: GLB loader, rig driving, fallback
│   │   │   ├── FitProfileModal.jsx # Fit profile input (height/chest/waist/EU size)
│   │   │   ├── Cart.jsx      # Cart drawer (local state only — see known issues)
│   │   │   ├── Navbar.jsx
│   │   │   ├── ProductCard.jsx
│   │   │   └── ProductImage.jsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.js  # WS connection, demo fallback, frame throttle
│   │   │   └── useProducts.js   # Fetch products with demo fallback
│   │   ├── lib/ar/
│   │   │   ├── bodyRig.js       # Landmark → 3D body frame computation
│   │   │   ├── garmentAdapter.js # GLB bone/mesh inspection + role mapping
│   │   │   └── garmentRuntime.js # Garment transform, rig driving, deformation
│   │   └── data/
│   │       └── demoProducts.js  # Offline product list (mirrors seed.py)
│   ├── public/garments/         # Static .glb files served by Vite
│   ├── vite.config.js           # Dev server port 3000, proxy /api + /ws → :8000
│   └── index.html
└── electron/
    ├── main.js    # BrowserWindow: dev=localhost:3000, prod=dist/index.html
    └── preload.js # Exposes process.platform only
```

---

## 3. Starting the Dev Environment

**Backend (must be started first):**
```bash
cd backend
source venv/bin/activate   # or: python -m venv venv && pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
> **Critical:** uvicorn must be run from inside the `backend/` directory. Running from the project root as `uvicorn backend.main:app` will fail with `ModuleNotFoundError` because `routers/` and `db/` are bare (non-package) imports relative to `backend/`.

**Frontend:**
```bash
cd frontend
yarn dev      # or: npm run dev
# Runs on http://localhost:3000
# /api/* proxied to :8000, /ws/* proxied to ws://:8000
```

**Electron (dev):**
```bash
cd electron
yarn start:dev    # loads from http://localhost:3000
```

**Electron (prod):**
```bash
cd frontend && yarn build
cd ../electron && yarn start   # loads from frontend/dist/index.html
```
> Note: In production, you must start the backend separately before launching Electron. There is no automated process management.

---

## 4. Environment Variables

**Backend (`backend/.env`):**
```
HF_TOKEN=hf_...       # HuggingFace token for live AI try-on
                      # Without this, try-on returns demo overlay
DEMO_TRYON_FALLBACK=1 # Default: 1. Set to 0 to hard-fail instead of demo
```

**Frontend (`.env.local` in `frontend/`):**
```
VITE_WS_URL=ws://127.0.0.1:8000/ws/vision     # Override WS endpoint
VITE_TRYON_TIMEOUT_MS=120000                   # IMPORTANT: default is 12000 (12s),
                                               # but AI try-on takes 45-90s. Must set.
VITE_DEMO_VISION=off                           # Disable demo vision fallback
VITE_ENABLE_TORSO_MASK=1                       # Enable torso darkening under garment
```

---

## 5. UI States (Spec)

### 5.1 Landing Page (Storefront)
- Full-screen product grid: image, name, price
- Category filters: All / Men / Women / Tops / Bottoms / Outerwear
- Welcome animation on idle: "Welcome – Explore Our Collection" (auto-hides after 4s)
- Demo badge shown when backend is unreachable (falls back to `demoProducts.js`)

### 5.2 Product Detail Page
- Large product image, name, price, description, sizes
- "Add to Cart" (adds to local React state)
- "Custom Fit" → opens AR popup

### 5.3 AR Popup / Custom Fit
- Layered canvas viewport (640×480):
  - Layer 1 (z=1): Live camera frame (JPEG, ~10fps throttled from ~30fps WS)
  - Layer 2 (z=2): Three.js garment overlay (WebGL canvas, full-frame)
  - Layer 3 (z=3): Arm/head occlusion mask (person composited over garment)
  - Layer 4 (z=10): Skeleton debug overlay (debug mode only)
- Size selector with auto-highlight of recommended/profile size
- "See Real Fit" → AI diffusion try-on (45–90s)
- "Add to Cart", "Switch Item" (close), "FIT PROFILE" (opens measurement modal)
- Debug sidebar (toggle): garment transform sliders, landmark values, body rig frame, asset info

### 5.4 Fit Profile Modal
- Sliders for height (140–210cm), chest (70–150cm), waist (55–130cm)
- EU size picker (XS–XXL)
- Persisted to localStorage under key `sfai_fit_profile_v1`
- Overrides camera-based size estimate when set

---

## 6. Key Architectural Concepts

### Body Rig Pipeline
1. MediaPipe on backend → 33 landmarks → sent over WebSocket as `{x,y,z,visibility}` objects
2. `bodyRig.js:computeBodyRigFrame()` converts normalized 0–1 coords to Three.js world space (±2 units wide, ±1.5 units tall), builds body axes (right/up/forward), shoulder and hip widths, torso height
3. `garmentRuntime.js:solveGarmentPoseTargets()` derives per-bone direction channels
4. `applyFallbackStaticTransform()` — used for unrigged GLBs: positions, scales, and rotates the whole mesh group based on body frame
5. `applyRiggedSkeletonDriving()` — used for rigged GLBs: drives individual bones via slerp toward target directions

### Garment Asset Modes
- **awaiting-asset**: no `model_url` set → PlaceholderGarment (blue box shape)
- **fallback-static**: GLB loaded but no skeleton or skin weights → whole-mesh transform + vertex deformation
- **rigged-ready**: GLB has SkinnedMesh + skin weights + all required bones mapped → full skeleton driving

### Required Bones (for rigged-ready mode)
`hips`, `spine`, `chest`, `neck`, `leftShoulder`, `rightShoulder`, `leftUpperArm`, `rightUpperArm`
Optional: `leftForearm`, `rightForearm`
Mixamo-style bone names are supported via alias table in `garmentAdapter.js`.

### WebSocket Vision Feed
- `vision.py` streams `{frame, mask, landmarks, measurements, recommended_size}` at ~30fps
- Frontend throttles canvas ops to every 3rd frame (~10fps) to avoid GPU overload
- Landmarks update on every frame for smooth tracking
- Falls back to synthetic demo vision if connection fails or no frames within 4.5s

---

## 7. Known Bugs & Issues (from audit)

### Critical
| # | File | Issue | Fix |
|---|------|-------|-----|
| C1 | `GarmentRenderer.jsx:312` | `GarmentModel` missing `riggedFit` in props + `useGarmentRuntime` call — debug rig sliders have no effect on real GLBs | Add `riggedFit` to `GarmentModel` signature and forward to `useGarmentRuntime` |
| C2 | `useWebSocket.js:6` | In Electron prod (`file://`), `window.location.hostname = ''` → WS URL becomes `ws://:8000/ws/vision` (invalid) | Check for empty hostname; default to `127.0.0.1`. Or set `VITE_WS_URL` in `.env.production` |
| C3 | `ARPopup.jsx:30` | Default `VITE_TRYON_TIMEOUT_MS=12000` (12s), but AI takes 45–90s — every live try-on times out | Set `VITE_TRYON_TIMEOUT_MS=120000` in `.env.local` or change the default |
| C4 | `vision.py:42`, `tryon.py:186` | `asyncio.get_event_loop()` deprecated in Python 3.10+, raises RuntimeError in future versions | Replace with `asyncio.get_running_loop()` |
| C5 | `main.py:3` | Bare imports only work if CWD is `backend/` — undocumented, breaks `uvicorn backend.main:app` | Always `cd backend` first; or add `PYTHONPATH=backend` |
| C6 | `database.py:4` | `sqlite:///./db/products.db` is CWD-relative — DB location changes with launch directory | Use `Path(__file__).parent / "products.db"` |

### High
| # | File | Issue |
|---|------|-------|
| H1 | `tryon.py:163` | `garment_url = product.image` is a person-wearing-clothes Unsplash photo. IDM-VTON needs a flat-lay/garment-only image → poor try-on results |
| H2 | `GarmentRenderer.jsx:463` | No ErrorBoundary — GLB 404 or load failure silently blanks the garment layer |
| H3 | `vision.py:58-60` | `except Exception: pass` swallows all WS loop errors — impossible to diagnose camera failures |
| H4 | `electron/main.js` | Electron does not spawn the Python backend — manual startup required in prod |
| H5 | `App.jsx:9` | Cart is local React state only — backend cart API (`cart.py`) is never called, cart lost on refresh |

### Medium
| # | File | Issue |
|---|------|-------|
| M1 | `main.jsx:7` | `BrowserRouter` in Electron prod may break on direct URL / crash-restart |
| M2 | `tryon.py:43` | Hardcoded personal machine path for HF token fallback — remove before sharing |
| M3 | `vision.py:39` | New `CameraManager` per WebSocket client — multiple connections fight for `/dev/video0` |
| M4 | `useWebSocket.js:210` | `noFrameTimer` only cleared on throttle-pass frames — could trigger demo mode spuriously |

---

## 8. Garment Assets

Static `.glb` files live in `frontend/public/garments/` and are served by Vite at `/garments/*.glb`.

| File | Status | Notes |
|------|--------|-------|
| `jacket.glb` | Static (no rig) | Fallback-static mode only |
| `top01.glb` | Static (no rig) | No skeleton/skin weights |
| `meshy-white-shirt-a-pose.glb` | Static (no rig) | Meshy preview API output, needs Blender rigging |
| `business-lady-blouse-fbx2gltf.glb` | Rigged | Converted from FBX2glTF — validates rigged-ready path |

To assign a GLB to a product:
```bash
cd backend
python db/set_model.py <product_id> <filename.glb>
# Example: python db/set_model.py 1 jacket.glb
```

---

## 9. Performance Targets

| Metric | Target |
|--------|--------|
| AR startup time | < 2 seconds |
| Pose tracking latency | < 1 second |
| Frame rendering | 20–30 FPS on Raspberry Pi 5 |
| AI try-on latency | 45–90 seconds (HuggingFace, network-dependent) |

MediaPipe Lite model (`model_complexity=0`) is used to hit 30fps on RPi5. Do not upgrade to Heavy model without benchmarking.

---

## 10. Future Enhancements

- Fabric physics simulation
- Multi-angle 3D avatar reconstruction
- AI styling recommendations
- Voice control
- Retail analytics dashboard
- Cloud rendering acceleration
- Real POS / checkout integration (current checkout is demo QR code only)
- Proper session-based cart (connect frontend to `/api/cart`)
- Garment-only image field on Product model (separate from `image`) for AI try-on
- Electron process manager (spawn + monitor Python backend from `main.js`)

import sqlite3
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import products, cart, vision, tryon
from db.database import engine, Base, SessionLocal, _DB_PATH
from db.models import Product
from db.seed import SAMPLE_PRODUCTS

# Create database tables
Base.metadata.create_all(bind=engine)


def _migrate_schema():
    """Add columns introduced after the initial schema without dropping existing data."""
    with sqlite3.connect(str(_DB_PATH)) as conn:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(products)")}
        if "garment_image" not in existing:
            conn.execute("ALTER TABLE products ADD COLUMN garment_image TEXT DEFAULT ''")
            conn.commit()


_migrate_schema()


def seed_products_if_empty():
    db = SessionLocal()
    try:
        if db.query(Product).count() > 0:
            return
        for item in SAMPLE_PRODUCTS:
            db.add(Product(**item))
        db.commit()
    finally:
        db.close()


seed_products_if_empty()

app = FastAPI(title="Smart Fit AI Mirror API")

allowed_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(products.router, prefix="/api")
app.include_router(cart.router, prefix="/api")
app.include_router(vision.router)
app.include_router(tryon.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}

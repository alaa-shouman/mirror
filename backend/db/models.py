from sqlalchemy import Column, Integer, String, Float, JSON
from db.database import Base


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    price = Column(Float, nullable=False)
    description = Column(String, default="")
    category = Column(String, default="")
    image = Column(String, default="")
    garment_image = Column(String, default="")  # Flat-lay / garment-only image for AI try-on
    model_url = Column(String, default="")  # Path to GLB/GLTF 3D model
    sizes = Column(JSON, default=list)  # ["S", "M", "L", "XL"]


class CartItem(Base):
    __tablename__ = "cart_items"

    id = Column(Integer, primary_key=True, index=True)
    product_id = Column(Integer, nullable=False)
    size = Column(String, nullable=False)
    quantity = Column(Integer, default=1)
    session_id = Column(String, default="default")

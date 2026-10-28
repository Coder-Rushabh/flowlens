import os

from sqlalchemy import Column, Float, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

engine = create_engine(os.environ.get("DATABASE_URL", "sqlite:////tmp/orders.db"))
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True)
    sku = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False)
    total = Column(Float, nullable=False)
    status = Column(String, default="placed")
    customer_email = Column(String)


Base.metadata.create_all(engine)

from sqlalchemy import Column, Integer, Numeric, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = {"schema": "sales"}

    id = Column(Integer, primary_key=True)
    sku = Column(String)
    quantity = Column(Integer)
    total = Column(Numeric)
    status = Column(String, default="new")


class AuditEntry(Base):
    __tablename__ = "audit_log"
    __table_args__ = ({"schema": "sales"},)

    id = Column(Integer, primary_key=True)
    message = Column(String)

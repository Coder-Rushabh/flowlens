import os

from sqlalchemy import create_engine, text

engine = create_engine(os.environ.get("DATABASE_URL", "sqlite:////data/inventory.db"))


def init_db() -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS stock_levels (sku TEXT PRIMARY KEY, on_hand INTEGER, reserved INTEGER)"))
        conn.execute(text("CREATE TABLE IF NOT EXISTS movements (id INTEGER PRIMARY KEY, sku TEXT, delta INTEGER, reason TEXT)"))
        conn.execute(text("INSERT OR IGNORE INTO stock_levels VALUES ('SHOE-1', 10, 0), ('SANDAL-2', 1, 0)"))

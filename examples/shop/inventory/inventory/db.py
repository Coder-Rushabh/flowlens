import os

import psycopg


def get_connection():
    return psycopg.connect(os.environ.get("DATABASE_URL", "postgresql://localhost/shop"))

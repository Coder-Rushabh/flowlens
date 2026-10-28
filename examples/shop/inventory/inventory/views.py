from flask import Blueprint, jsonify, request

from .db import get_connection

bp = Blueprint("stock", __name__, url_prefix="/stock")

RESERVE_SQL = """
    UPDATE warehouse.stock_levels
       SET reserved = reserved + %(qty)s
     WHERE sku = %(sku)s
"""


@bp.route("/<sku>/reserve", methods=["POST"])
def reserve(sku: str):
    qty = request.json["quantity"]
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT on_hand - reserved FROM warehouse.stock_levels WHERE sku = %(sku)s", {"sku": sku})
        (available,) = cur.fetchone()
        if available < qty:
            return jsonify({"ok": False}), 409
        cur.execute(RESERVE_SQL, {"sku": sku, "qty": qty})
    return jsonify({"ok": True})


@bp.get("/<sku>")
def level(sku: str):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            WITH recent AS (SELECT sku, sum(delta) AS moved FROM warehouse.movements GROUP BY sku)
            SELECT s.on_hand, r.moved FROM warehouse.stock_levels s LEFT JOIN recent r USING (sku)
            WHERE s.sku = %(sku)s
            """,
            {"sku": sku},
        )
        return jsonify(cur.fetchone())

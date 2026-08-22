from __future__ import annotations

from decimal import Decimal


def discount_rate(subtotal: Decimal, loyalty: str) -> Decimal:
    """Return the discount rate for one invoice."""

    if loyalty == "gold" and subtotal > Decimal("100.00"):
        return Decimal("0.10")
    if loyalty == "silver" and subtotal >= Decimal("50.00"):
        return Decimal("0.05")
    return Decimal("0.00")

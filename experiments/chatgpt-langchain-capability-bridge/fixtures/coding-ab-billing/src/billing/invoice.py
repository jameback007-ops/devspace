from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from .discounts import discount_rate

CENT = Decimal("0.01")


def invoice_total(subtotal: Decimal, tax_rate: Decimal, loyalty: str) -> Decimal:
    """Return the final invoice total rounded to cents."""

    discount = subtotal * discount_rate(subtotal, loyalty)
    tax = subtotal * tax_rate
    return (subtotal - discount + tax).quantize(CENT, rounding=ROUND_HALF_UP)

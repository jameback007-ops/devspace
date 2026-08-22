from __future__ import annotations

from decimal import Decimal


def invoice_total(subtotal: Decimal, tax_rate: Decimal, discount: Decimal) -> Decimal:
    """Return the final invoice total, rounded to cents.

    The fixture intentionally contains a defect for the WebChat coding test.
    """

    taxed = subtotal * tax_rate
    return (taxed - discount).quantize(Decimal("0.01"))

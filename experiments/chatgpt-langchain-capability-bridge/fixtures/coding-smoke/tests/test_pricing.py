from decimal import Decimal

from coding_smoke import invoice_total


def test_invoice_total_applies_tax_to_subtotal() -> None:
    assert invoice_total(
        subtotal=Decimal("100.00"),
        tax_rate=Decimal("0.07"),
        discount=Decimal("5.00"),
    ) == Decimal("102.00")


def test_invoice_total_rounds_to_cents() -> None:
    assert invoice_total(
        subtotal=Decimal("19.99"),
        tax_rate=Decimal("0.0825"),
        discount=Decimal("0.00"),
    ) == Decimal("21.64")

from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from billing.discounts import discount_rate  # noqa: E402
from billing.invoice import invoice_total  # noqa: E402


class BillingTests(unittest.TestCase):
    def test_gold_discount_starts_at_exact_threshold(self) -> None:
        self.assertEqual(discount_rate(Decimal("100.00"), "gold"), Decimal("0.10"))

    def test_tax_is_calculated_after_gold_discount(self) -> None:
        self.assertEqual(
            invoice_total(Decimal("200.00"), Decimal("0.05"), "gold"),
            Decimal("189.00"),
        )

    def test_silver_discount_starts_at_exact_threshold(self) -> None:
        self.assertEqual(discount_rate(Decimal("50.00"), "silver"), Decimal("0.05"))

    def test_invoice_without_discount(self) -> None:
        self.assertEqual(
            invoice_total(Decimal("50.00"), Decimal("0.05"), "standard"),
            Decimal("52.50"),
        )


if __name__ == "__main__":
    unittest.main()

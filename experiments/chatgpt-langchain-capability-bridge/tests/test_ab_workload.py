from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def load_script(name: str) -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply_expected_repair(path: Path) -> None:
    discounts = path / "src" / "billing" / "discounts.py"
    discounts.write_text(
        discounts.read_text(encoding="utf-8").replace(
            'subtotal > Decimal("100.00")',
            'subtotal >= Decimal("100.00")',
        ),
        encoding="utf-8",
    )
    invoice = path / "src" / "billing" / "invoice.py"
    invoice.write_text(
        invoice.read_text(encoding="utf-8").replace(
            "    tax = subtotal * tax_rate\n"
            "    return (subtotal - discount + tax).quantize(CENT, rounding=ROUND_HALF_UP)\n",
            "    taxable = subtotal - discount\n"
            "    tax = taxable * tax_rate\n"
            "    return (taxable + tax).quantize(CENT, rounding=ROUND_HALF_UP)\n",
        ),
        encoding="utf-8",
    )


def test_prepare_and_score_representative_ab_workload(tmp_path: Path) -> None:
    prepare = load_script("prepare_ab_workload")
    score = load_script("score_ab_workload")
    receipt = prepare.prepare(tmp_path / "ab")

    assert receipt["baseline"]["exit_code"] != 0
    assert set(receipt["lanes"]) == {"devspace", "native"}
    assert receipt["behavioral_claim_allowed"] is False

    devspace = Path(receipt["lanes"]["devspace"])
    native = Path(receipt["lanes"]["native"])
    apply_expected_repair(devspace)
    apply_expected_repair(native)

    devspace_score = score.score_lane(devspace)
    native_score = score.score_lane(native)
    assert devspace_score["passed"] is True
    assert native_score["passed"] is True
    assert devspace_score["diff_sha256"] == native_score["diff_sha256"]

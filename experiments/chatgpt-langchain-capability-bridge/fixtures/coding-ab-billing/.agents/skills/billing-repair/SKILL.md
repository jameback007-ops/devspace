---
name: billing-repair
description: Diagnose Decimal invoice failures involving discount thresholds and tax ordering, then validate a minimal multi-file repair.
allowed-tools: read_file grep edit_file execute checkpoint_record
---

# Billing repair

1. Read the failing tests before changing source.
2. Inspect both `src/billing/discounts.py` and `src/billing/invoice.py`.
3. Preserve `Decimal` arithmetic and public signatures.
4. Repair boundary semantics and calculation order at their owning modules.
5. Run `python3 -m unittest discover -s tests -v`, `git diff --check`, and
   inspect the final diff.

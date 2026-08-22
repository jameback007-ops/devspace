# Billing module invariants

- Money calculations use `Decimal`; do not introduce floats.
- Gold discount eligibility begins at exactly `100.00`.
- Tax is calculated from the discounted taxable subtotal.
- Round only the final invoice total to cents.
- Do not move policy into tests or duplicate discount rules in `invoice.py`.

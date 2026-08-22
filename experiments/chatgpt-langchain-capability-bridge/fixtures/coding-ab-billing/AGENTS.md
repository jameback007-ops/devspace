# Billing repair fixture

This repository is a bounded A/B qualification fixture.

- Read the failing tests and the nested `src/billing/AGENTS.md` before editing.
- Keep the public API and tests unchanged.
- Make the smallest coherent source repair.
- Validate with `python3 -m unittest discover -s tests -v` and
  `git diff --check`.
- Do not delegate the repair to another model or agent.

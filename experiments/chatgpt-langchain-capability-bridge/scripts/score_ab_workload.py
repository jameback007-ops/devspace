from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


EXPECTED_CHANGED_FILES = (
    "src/billing/discounts.py",
    "src/billing/invoice.py",
)


def run(
    command: list[str], *, cwd: Path, check: bool = False
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
    )


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def score_lane(path: Path) -> dict[str, Any]:
    tests = run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=path,
    )
    diff_check = run(["git", "diff", "--check"], cwd=path)
    diff = run(["git", "diff", "--no-ext-diff", "--binary"], cwd=path)
    names = tuple(
        item
        for item in run(["git", "diff", "--name-only"], cwd=path).stdout.splitlines()
        if item
    )
    status = run(["git", "status", "--porcelain"], cwd=path).stdout.splitlines()
    changed_source_only = names == EXPECTED_CHANGED_FILES
    passed = (
        tests.returncode == 0 and diff_check.returncode == 0 and changed_source_only
    )
    return {
        "path": str(path),
        "passed": passed,
        "test_exit_code": tests.returncode,
        "test_summary": (tests.stdout + tests.stderr).strip(),
        "git_diff_check_exit_code": diff_check.returncode,
        "changed_files": list(names),
        "changed_source_only": changed_source_only,
        "status": status,
        "diff_sha256": sha256_text(diff.stdout),
        "diff_line_count": len(diff.stdout.splitlines()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--devspace", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    args = parser.parse_args()

    devspace = score_lane(args.devspace.resolve())
    native = score_lane(args.native.resolve())
    result = {
        "schema_version": "chatgpt-langchain-ab-score.v1",
        "devspace": devspace,
        "native": native,
        "both_passed": devspace["passed"] and native["passed"],
        "patches_equivalent": devspace["diff_sha256"] == native["diff_sha256"],
        "behavioral_claim_allowed": False,
        "claim_ceiling": (
            "deterministic capability replay only; independent fresh WebChat "
            "sessions are required for model-behavior comparison"
        ),
    }
    print(json.dumps(result, indent=2))
    if not result["both_passed"] or not result["patches_equivalent"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

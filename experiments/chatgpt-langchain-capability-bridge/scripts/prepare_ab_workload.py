from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


FIXED_GIT_DATE = "2026-08-22T00:00:00+00:00"


def run(
    command: list[str],
    *,
    cwd: Path,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
        env=env,
    )


def prepare(output_root: Path) -> dict[str, Any]:
    project_root = Path(__file__).resolve().parents[1]
    fixture = project_root / "fixtures" / "coding-ab-billing"
    if output_root.exists() and any(output_root.iterdir()):
        raise ValueError(f"output root is not empty: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)

    template = output_root / "template"
    shutil.copytree(fixture, template)
    run(["git", "init", "-q"], cwd=template)
    run(["git", "add", "."], cwd=template)
    commit_env = {
        **os.environ,
        "GIT_AUTHOR_DATE": FIXED_GIT_DATE,
        "GIT_COMMITTER_DATE": FIXED_GIT_DATE,
    }
    run(
        [
            "git",
            "-c",
            "user.name=Bridge A/B Fixture",
            "-c",
            "user.email=bridge-ab@example.invalid",
            "commit",
            "-qm",
            "failing representative billing fixture",
        ],
        cwd=template,
        env=commit_env,
    )

    lanes: dict[str, str] = {}
    for name in ("devspace", "native"):
        destination = output_root / name
        run(
            [
                "git",
                "clone",
                "--quiet",
                "--no-hardlinks",
                str(template),
                str(destination),
            ],
            cwd=output_root,
        )
        lanes[name] = str(destination)

    head = run(["git", "rev-parse", "HEAD"], cwd=template).stdout.strip()
    baseline = run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=template,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if baseline.returncode == 0:
        raise AssertionError("representative fixture unexpectedly passed")

    return {
        "schema_version": "chatgpt-langchain-ab-workload.v1",
        "output_root": str(output_root),
        "template": str(template),
        "lanes": lanes,
        "head": head,
        "baseline": {
            "exit_code": baseline.returncode,
            "summary": (baseline.stdout + baseline.stderr).strip(),
        },
        "expected_changed_files": [
            "src/billing/discounts.py",
            "src/billing/invoice.py",
        ],
        "behavioral_claim_allowed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    output_root = args.output_root or Path(
        tempfile.mkdtemp(prefix="chatgpt-langchain-ab-")
    )
    print(json.dumps(prepare(output_root.resolve()), indent=2))


if __name__ == "__main__":
    main()

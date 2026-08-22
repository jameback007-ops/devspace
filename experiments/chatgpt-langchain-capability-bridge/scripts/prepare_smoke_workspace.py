from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    fixture = project_root / "fixtures" / "coding-smoke"
    destination = Path(
        tempfile.mkdtemp(prefix="chatgpt-langchain-coding-smoke-")
    ).resolve()
    shutil.copytree(
        fixture,
        destination,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".venv"),
    )
    subprocess.run(["git", "init", "-q", str(destination)], check=True)
    subprocess.run(["git", "-C", str(destination), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(destination),
            "-c",
            "user.name=Harness Smoke",
            "-c",
            "user.email=harness-smoke@example.invalid",
            "commit",
            "-qm",
            "failing coding fixture",
        ],
        check=True,
    )
    print(destination)
    return 0


if __name__ == "__main__":
    sys.exit(main())

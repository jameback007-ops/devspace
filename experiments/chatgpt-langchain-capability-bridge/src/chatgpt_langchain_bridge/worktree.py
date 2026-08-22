from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import urlparse

from langgraph_sdk import get_sync_client

from .registry import BridgeError
from .serialization import json_safe


WORKTREE_REFERENCE_SCHEME = "zes-worktree"
WORKTREE_BINDING_SCHEMA = "chatgpt-langchain-worktree-binding.v1"
_ALIAS_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_BRANCH_COMPONENT_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


def _run_git(
    *args: str,
    cwd: Path | None = None,
    safe_directory: Path | None = None,
) -> str:
    environment = os.environ.copy()
    if safe_directory is not None:
        environment.update(
            {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "safe.directory",
                "GIT_CONFIG_VALUE_0": str(safe_directory.resolve()),
            }
        )
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        raise BridgeError(
            f"native git worktree operation failed: {stderr[:500] or exc.returncode}"
        ) from exc
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BridgeError(
            f"native git worktree operation failed: {type(exc).__name__}"
        ) from exc
    return completed.stdout.strip()


@dataclass(frozen=True)
class WorktreeRepository:
    alias: str
    repository_root: Path
    worktree_root: Path
    base_ref: str = "HEAD"
    branch_prefix: str = "agent/webchat"

    def __post_init__(self) -> None:
        if not _ALIAS_PATTERN.fullmatch(self.alias):
            raise BridgeError(f"invalid worktree repository alias: {self.alias!r}")
        if (
            not self.repository_root.is_absolute()
            or not self.worktree_root.is_absolute()
        ):
            raise BridgeError("worktree repository paths must be absolute")
        if self.worktree_root == Path("/"):
            raise BridgeError("worktree_root cannot be filesystem root")
        if not self.base_ref:
            raise BridgeError("worktree base_ref cannot be empty")
        if not self.branch_prefix:
            raise BridgeError("worktree branch_prefix cannot be empty")


@dataclass(frozen=True)
class WorktreeBinding:
    schema_version: str
    repository_alias: str
    workstream_ref: str
    repository_root: str
    worktree_root: str
    worktree_path: str
    branch: str
    base_ref: str
    head_sha: str
    created_at: str
    binding_source: str

    def public_view(self) -> dict[str, Any]:
        return asdict(self)


class WorktreeBindingStore(Protocol):
    def get(
        self, repository_alias: str, workstream_ref: str
    ) -> dict[str, Any] | None: ...

    def put(
        self,
        repository_alias: str,
        workstream_ref: str,
        binding: dict[str, Any],
    ) -> None: ...


class AgentServerWorktreeBindingStore:
    """Use native Agent Server Store as the durable binding authority."""

    def __init__(
        self,
        *,
        url: str,
        namespace_prefix: tuple[str, ...],
        timeout_seconds: float = 60.0,
        client_factory: Callable[..., Any] = get_sync_client,
    ) -> None:
        self._url = url
        self._namespace_prefix = namespace_prefix
        self._timeout_seconds = timeout_seconds
        self._client_factory = client_factory
        self._client_instance: Any | None = None

    @classmethod
    def from_environment(cls) -> AgentServerWorktreeBindingStore:
        url = os.environ.get("BRIDGE_AGENT_SERVER_URL", "").strip()
        if not url and os.environ.get(
            "BRIDGE_AGENT_SERVER_SELF", ""
        ).strip().casefold() in {"1", "true", "yes", "on"}:
            url = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
        if not url:
            raise BridgeError(
                "managed worktree binding requires BRIDGE_AGENT_SERVER_URL"
            )
        prefix = tuple(
            item.strip()
            for item in os.environ.get(
                "BRIDGE_AGENT_SERVER_STORE_PREFIX", "chatgpt-langchain-bridge"
            ).split("/")
            if item.strip()
        )
        if not prefix:
            raise BridgeError("Agent Server Store namespace prefix cannot be empty")
        return cls(
            url=url,
            namespace_prefix=prefix,
            timeout_seconds=max(
                1.0,
                min(
                    float(
                        os.environ.get(
                            "BRIDGE_AGENT_SERVER_REQUEST_TIMEOUT_SECONDS", "60"
                        )
                    ),
                    120.0,
                ),
            ),
        )

    def get(self, repository_alias: str, workstream_ref: str) -> dict[str, Any] | None:
        item = self._client().store.get_item(
            self._namespace(repository_alias), workstream_ref
        )
        if item is None:
            return None
        value = (
            item.get("value")
            if isinstance(item, dict)
            else getattr(item, "value", None)
        )
        return json_safe(value) if isinstance(value, dict) else None

    def put(
        self,
        repository_alias: str,
        workstream_ref: str,
        binding: dict[str, Any],
    ) -> None:
        self._client().store.put_item(
            self._namespace(repository_alias), workstream_ref, binding
        )

    def _namespace(self, repository_alias: str) -> list[str]:
        return [*self._namespace_prefix, "worktree-bindings", repository_alias]

    def _client(self) -> Any:
        if self._client_instance is None:
            try:
                self._client_instance = self._client_factory(
                    url=self._url, timeout=self._timeout_seconds
                )
            except Exception as exc:
                raise BridgeError(
                    f"Agent Server worktree Store unavailable: {type(exc).__name__}"
                ) from exc
        return self._client_instance


@dataclass(frozen=True)
class WorktreeBindingConfig:
    repositories: tuple[WorktreeRepository, ...] = ()
    lock_root: Path = Path("/run/zes-worktree-bindings")

    @classmethod
    def from_environment(cls) -> WorktreeBindingConfig:
        raw_json = os.environ.get("BRIDGE_WORKTREE_CATALOG_JSON", "").strip()
        catalog_file = os.environ.get("BRIDGE_WORKTREE_CATALOG_FILE", "").strip()
        if raw_json and catalog_file:
            raise BridgeError(
                "set only one of BRIDGE_WORKTREE_CATALOG_JSON or BRIDGE_WORKTREE_CATALOG_FILE"
            )
        if catalog_file:
            try:
                raw_json = Path(catalog_file).read_text(encoding="utf-8")
            except OSError as exc:
                raise BridgeError(
                    f"cannot read worktree catalog: {type(exc).__name__}"
                ) from exc
        if not raw_json:
            return cls(
                lock_root=Path(
                    os.environ.get(
                        "BRIDGE_WORKTREE_LOCK_ROOT", "/run/zes-worktree-bindings"
                    )
                )
            )
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise BridgeError("worktree catalog must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise BridgeError("worktree catalog must be a JSON object")

        repositories: list[WorktreeRepository] = []
        for alias, raw in sorted(payload.items()):
            if not isinstance(raw, dict):
                raise BridgeError(f"worktree catalog entry {alias!r} must be an object")
            try:
                repository_root = (
                    Path(str(raw["repository_root"])).expanduser().resolve()
                )
                worktree_root = Path(str(raw["worktree_root"])).expanduser().resolve()
            except KeyError as exc:
                raise BridgeError(
                    f"worktree catalog entry {alias!r} is missing {exc.args[0]}"
                ) from exc
            repositories.append(
                WorktreeRepository(
                    alias=str(alias),
                    repository_root=repository_root,
                    worktree_root=worktree_root,
                    base_ref=str(raw.get("base_ref", "HEAD")),
                    branch_prefix=str(raw.get("branch_prefix", "agent/webchat")),
                )
            )
        return cls(
            repositories=tuple(repositories),
            lock_root=Path(
                os.environ.get(
                    "BRIDGE_WORKTREE_LOCK_ROOT", "/run/zes-worktree-bindings"
                )
            ),
        )


class WorktreeBindingManager:
    """Thin workstream → native Git worktree resolver.

    Git remains the worktree/branch authority. Agent Server Store owns only the
    durable association between one WebChat workstream and the exact Git
    worktree returned by Git. A small file lock serializes creation races; it is
    not persistent task or semantic state.
    """

    def __init__(
        self,
        config: WorktreeBindingConfig | None = None,
        store: WorktreeBindingStore | None = None,
    ) -> None:
        self._config = config or WorktreeBindingConfig.from_environment()
        self._repositories = {repo.alias: repo for repo in self._config.repositories}
        self._store = store

    @classmethod
    def from_environment(cls) -> WorktreeBindingManager:
        config = WorktreeBindingConfig.from_environment()
        store: WorktreeBindingStore | None = None
        if config.repositories:
            store = AgentServerWorktreeBindingStore.from_environment()
        return cls(config=config, store=store)

    def manifest(self) -> dict[str, Any]:
        return {
            "state": "available" if self._repositories and self._store else "disabled",
            "reference_scheme": f"{WORKTREE_REFERENCE_SCHEME}://<repository-alias>",
            "repository_aliases": sorted(self._repositories),
            "binding_authority": "langgraph_agent_server_store",
            "worktree_authority": "native_git_worktree",
            "creation_coordination": "bounded_fcntl_lock",
            "arbitrary_host_paths_accepted": False,
            "global_git_safe_directory_used": False,
            "shell_isolation_claim": "requires_per_lane_native_sandbox_for_untrusted_absolute_paths",
        }

    @staticmethod
    def is_reference(value: str) -> bool:
        return value.startswith(f"{WORKTREE_REFERENCE_SCHEME}://")

    def resolve(self, reference: str, workstream_ref: str) -> WorktreeBinding:
        if not workstream_ref:
            raise BridgeError(
                "managed worktree workspace_open requires an explicit thread_id/workstream_ref"
            )
        alias = self._parse_alias(reference)
        try:
            repository = self._repositories[alias]
        except KeyError as exc:
            raise BridgeError(f"unknown worktree repository alias: {alias}") from exc
        if self._store is None:
            raise BridgeError("managed worktree binding Store is not configured")

        expected = self._expected_binding(repository, workstream_ref)
        stored = self._store.get(alias, workstream_ref)
        if stored is not None:
            return self._validate_stored_binding(repository, expected, stored)

        self._config.lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = self._config.lock_root / (
            hashlib.sha256(f"{alias}\0{workstream_ref}".encode()).hexdigest() + ".lock"
        )
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            stored = self._store.get(alias, workstream_ref)
            if stored is not None:
                return self._validate_stored_binding(repository, expected, stored)

            binding = self._ensure_native_worktree(repository, expected)
            self._store.put(alias, workstream_ref, binding.public_view())
            return binding

    def _expected_binding(
        self, repository: WorktreeRepository, workstream_ref: str
    ) -> WorktreeBinding:
        digest = hashlib.sha256(
            f"{repository.alias}\0{workstream_ref}".encode()
        ).hexdigest()
        worktree_path = repository.worktree_root / f"{repository.alias}-{digest[:12]}"
        branch_alias = _BRANCH_COMPONENT_PATTERN.sub("-", repository.alias).strip("-")
        branch = f"{repository.branch_prefix.rstrip('/')}/{branch_alias}/{digest[:16]}"
        return WorktreeBinding(
            schema_version=WORKTREE_BINDING_SCHEMA,
            repository_alias=repository.alias,
            workstream_ref=workstream_ref,
            repository_root=str(repository.repository_root),
            worktree_root=str(repository.worktree_root),
            worktree_path=str(worktree_path),
            branch=branch,
            base_ref=repository.base_ref,
            head_sha="",
            created_at="",
            binding_source="deterministic_native_git",
        )

    def _ensure_native_worktree(
        self, repository: WorktreeRepository, expected: WorktreeBinding
    ) -> WorktreeBinding:
        self._validate_repository(repository)
        _run_git(
            "check-ref-format",
            "--branch",
            expected.branch,
            cwd=repository.repository_root,
            safe_directory=repository.repository_root,
        )
        _run_git(
            "rev-parse",
            "--verify",
            f"{repository.base_ref}^{{commit}}",
            cwd=repository.repository_root,
            safe_directory=repository.repository_root,
        )
        repository.worktree_root.mkdir(mode=0o755, parents=True, exist_ok=True)
        target = Path(expected.worktree_path)
        records = self._worktree_records(repository.repository_root)
        by_path = {record["path"]: record for record in records}
        by_branch = {
            record["branch"]: record
            for record in records
            if record.get("branch") is not None
        }

        existing_path_record = (
            by_path.get(str(target.resolve())) if target.exists() else None
        )
        existing_branch_record = by_branch.get(expected.branch)
        if existing_branch_record and existing_branch_record.get("path") != str(
            target.resolve()
        ):
            raise BridgeError(
                "worktree branch is already assigned to another native Git worktree"
            )

        if target.exists():
            if existing_path_record is None:
                raise BridgeError(
                    "deterministic worktree path exists but is not registered by native Git"
                )
            if existing_path_record.get("branch") != expected.branch:
                raise BridgeError(
                    "deterministic worktree path has a different Git branch"
                )
        else:
            try:
                branch_sha = _run_git(
                    "rev-parse",
                    "--verify",
                    f"refs/heads/{expected.branch}",
                    cwd=repository.repository_root,
                    safe_directory=repository.repository_root,
                )
            except BridgeError:
                branch_sha = ""
            if branch_sha:
                _run_git(
                    "worktree",
                    "add",
                    str(target),
                    expected.branch,
                    cwd=repository.repository_root,
                    safe_directory=repository.repository_root,
                )
            else:
                _run_git(
                    "worktree",
                    "add",
                    "-b",
                    expected.branch,
                    str(target),
                    repository.base_ref,
                    cwd=repository.repository_root,
                    safe_directory=repository.repository_root,
                )

        self._validate_access(target)
        head_sha = _run_git("rev-parse", "HEAD", cwd=target, safe_directory=target)
        branch = _run_git("branch", "--show-current", cwd=target, safe_directory=target)
        if branch != expected.branch:
            raise BridgeError("native Git worktree branch does not match binding")
        return WorktreeBinding(
            **{
                **expected.public_view(),
                "head_sha": head_sha,
                "created_at": datetime.now(UTC).isoformat(),
            }
        )

    def _validate_stored_binding(
        self,
        repository: WorktreeRepository,
        expected: WorktreeBinding,
        stored: dict[str, Any],
    ) -> WorktreeBinding:
        try:
            binding = WorktreeBinding(**stored)
        except (TypeError, ValueError) as exc:
            raise BridgeError("stored worktree binding has an invalid schema") from exc
        for field in (
            "schema_version",
            "repository_alias",
            "workstream_ref",
            "repository_root",
            "worktree_root",
            "worktree_path",
            "branch",
            "base_ref",
        ):
            if getattr(binding, field) != getattr(expected, field):
                raise BridgeError(f"stored worktree binding conflicts on {field}")
        target = Path(binding.worktree_path)
        self._validate_repository(repository)
        self._validate_access(target)
        records = self._worktree_records(repository.repository_root)
        match = next(
            (record for record in records if record["path"] == str(target.resolve())),
            None,
        )
        if match is None or match.get("branch") != binding.branch:
            raise BridgeError("stored worktree binding is stale relative to native Git")
        current_head = _run_git("rev-parse", "HEAD", cwd=target, safe_directory=target)
        return WorktreeBinding(
            **{
                **binding.public_view(),
                "head_sha": current_head,
                "binding_source": "agent_server_store_reconciled_with_git",
            }
        )

    @staticmethod
    def _parse_alias(reference: str) -> str:
        parsed = urlparse(reference)
        if parsed.scheme != WORKTREE_REFERENCE_SCHEME:
            raise BridgeError("workspace reference is not a ZES worktree reference")
        if parsed.query or parsed.fragment or parsed.params:
            raise BridgeError(
                "worktree references do not accept query or fragment data"
            )
        alias = parsed.netloc or parsed.path.lstrip("/")
        if not _ALIAS_PATTERN.fullmatch(alias):
            raise BridgeError("worktree reference contains an invalid repository alias")
        return alias

    @staticmethod
    def _validate_repository(repository: WorktreeRepository) -> None:
        if not repository.repository_root.exists():
            raise BridgeError("configured native Git repository does not exist")
        _run_git(
            "rev-parse",
            "--git-dir",
            cwd=repository.repository_root,
            safe_directory=repository.repository_root,
        )

    @staticmethod
    def _validate_access(path: Path) -> None:
        resolved = path.resolve()
        if not resolved.is_dir():
            raise BridgeError("native Git worktree path is not a directory")
        if not os.access(resolved, os.R_OK | os.W_OK | os.X_OK):
            raise BridgeError(
                "runtime UID/GID cannot read, write, and traverse the assigned worktree"
            )

    @staticmethod
    def _worktree_records(repository_root: Path) -> list[dict[str, str | None]]:
        output = _run_git(
            "worktree",
            "list",
            "--porcelain",
            cwd=repository_root,
            safe_directory=repository_root,
        )
        records: list[dict[str, str | None]] = []
        current: dict[str, str | None] = {}
        for line in [*output.splitlines(), ""]:
            if not line:
                if current:
                    branch = current.get("branch")
                    if isinstance(branch, str) and branch.startswith("refs/heads/"):
                        current["branch"] = branch.removeprefix("refs/heads/")
                    current["path"] = str(Path(str(current["path"])).resolve())
                    records.append(current)
                    current = {}
                continue
            key, _, value = line.partition(" ")
            if key == "worktree":
                current["path"] = value
            elif key == "HEAD":
                current["head"] = value
            elif key == "branch":
                current["branch"] = value
            elif key == "detached":
                current["branch"] = None
        return records

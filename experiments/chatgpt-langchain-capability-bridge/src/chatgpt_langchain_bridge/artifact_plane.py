from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Any

from .registry import BridgeError, WorkspaceRegistry


class ArtifactPlane:
    """Bounded binary transfer over native Deep Agents backend methods."""

    def __init__(self, registry: WorkspaceRegistry) -> None:
        self._registry = registry

    def manifest(self) -> dict[str, Any]:
        return {
            "state": "available",
            "native_component": "deepagents.backends.BackendProtocol.upload_files/download_files",
            "encoding": "base64",
            "max_transfer_bytes": self._registry.config.max_transfer_bytes,
        }

    def transfer(
        self,
        workspace_id: str,
        action: str,
        file_path: str,
        content_base64: str | None = None,
    ) -> dict[str, Any]:
        if action == "upload":
            if content_base64 is None:
                raise BridgeError("content_base64 is required for upload")
            try:
                content = base64.b64decode(content_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise BridgeError("content_base64 is not valid base64") from exc
            result = self._registry.upload_bytes(workspace_id, file_path, content)
            return {
                "action": "upload",
                "file_path": file_path,
                "byte_count": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "native_backend_result": result,
            }

        if action == "download":
            content, native_path = self._registry.download_bytes(
                workspace_id, file_path
            )
            return {
                "action": "download",
                "file_path": file_path,
                "native_path": self._registry.display_backend_path(
                    workspace_id, native_path
                ),
                "byte_count": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "content_base64": base64.b64encode(content).decode("ascii"),
            }

        raise BridgeError("artifact action must be 'upload' or 'download'")

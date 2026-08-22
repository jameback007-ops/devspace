from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, cast
from uuid import UUID


def json_safe(value: Any) -> Any:
    """Convert SDK/dataclass values into bounded JSON-compatible structures."""

    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (UUID, Path, Enum)):
        return str(value)
    if is_dataclass(value) and not isinstance(value, type):
        return json_safe(asdict(cast(Any, value)))
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item) for item in value]
    if hasattr(value, "model_dump"):
        return json_safe(value.model_dump())
    if hasattr(value, "dict"):
        return json_safe(value.dict())
    if hasattr(value, "__dict__"):
        return {
            key: json_safe(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return str(value)

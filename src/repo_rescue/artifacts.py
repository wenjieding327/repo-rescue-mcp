from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .security import SecurityError, safe_child


_RUN_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")
_ARTIFACT_FILES = {
    "patch": "repair.patch",
    "report": "report.md",
    "evidence": "evidence.json",
}


def read_artifact_chunk(
    artifacts_root: Path,
    *,
    run_id: str,
    artifact: str,
    offset: int = 0,
    limit: int = 60_000,
) -> dict[str, Any]:
    """Read a bounded text chunk from a generated repair artifact."""
    if not _RUN_ID.fullmatch(run_id):
        raise SecurityError("run_id must be a RepoRescue run identifier returned by a repair tool.")
    filename = _ARTIFACT_FILES.get(artifact)
    if filename is None:
        raise SecurityError("artifact must be one of: patch, report, evidence.")
    if offset < 0:
        raise ValueError("offset must be zero or greater.")
    if not 4 <= limit <= 60_000:
        raise ValueError("limit must be between 4 and 60000 bytes.")

    run_root = safe_child(artifacts_root.resolve(), run_id)
    path = safe_child(run_root, filename)
    if not path.is_file() or path.is_symlink():
        raise FileNotFoundError("The requested repair artifact does not exist or has expired.")
    payload = path.read_bytes()
    if offset > len(payload):
        raise ValueError("offset is beyond the end of the artifact.")
    if offset < len(payload) and payload[offset] & 0xC0 == 0x80:
        raise ValueError("offset must be a UTF-8 character boundary returned by next_offset.")
    end = min(offset + limit, len(payload))
    while end < len(payload) and payload[end] & 0xC0 == 0x80:
        end -= 1
    chunk = payload[offset:end]
    content = chunk.decode("utf-8")
    next_offset = end
    return {
        "run_id": run_id,
        "artifact": artifact,
        "mime_type": "application/json" if artifact == "evidence" else "text/plain",
        "content": content,
        "offset": offset,
        "next_offset": None if next_offset >= len(payload) else next_offset,
        "complete": next_offset >= len(payload),
        "total_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }

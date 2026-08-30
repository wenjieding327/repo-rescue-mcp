from pathlib import Path

import pytest

from repo_rescue.artifacts import read_artifact_chunk
from repo_rescue.security import SecurityError


RUN_ID = "20260830T120000Z-deadbeef"


def test_reads_artifact_in_bounded_chunks(tmp_path: Path) -> None:
    run = tmp_path / RUN_ID
    run.mkdir()
    (run / "repair.patch").write_text("abcdefghij", encoding="utf-8")

    first = read_artifact_chunk(tmp_path, run_id=RUN_ID, artifact="patch", limit=4)
    second = read_artifact_chunk(
        tmp_path,
        run_id=RUN_ID,
        artifact="patch",
        offset=first["next_offset"],
        limit=60_000,
    )

    assert first["content"] == "abcd"
    assert first["complete"] is False
    assert second["content"] == "efghij"
    assert second["complete"] is True
    assert first["sha256"] == second["sha256"]


def test_artifact_reader_rejects_paths_and_unknown_names(tmp_path: Path) -> None:
    with pytest.raises(SecurityError):
        read_artifact_chunk(tmp_path, run_id="../escape", artifact="patch")
    with pytest.raises(SecurityError):
        read_artifact_chunk(tmp_path, run_id=RUN_ID, artifact="../../secret")


def test_utf8_chunks_never_split_multibyte_characters(tmp_path: Path) -> None:
    run = tmp_path / RUN_ID
    run.mkdir()
    (run / "report.md").write_text("AB中C", encoding="utf-8")

    first = read_artifact_chunk(tmp_path, run_id=RUN_ID, artifact="report", limit=4)
    second = read_artifact_chunk(
        tmp_path,
        run_id=RUN_ID,
        artifact="report",
        offset=first["next_offset"],
        limit=4,
    )

    assert first["content"] == "AB"
    assert second["content"] == "中C"
    assert first["content"] + second["content"] == "AB中C"
    with pytest.raises(ValueError, match="UTF-8 character boundary"):
        read_artifact_chunk(tmp_path, run_id=RUN_ID, artifact="report", offset=3, limit=4)

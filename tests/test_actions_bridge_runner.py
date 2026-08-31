from __future__ import annotations

import base64
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from repo_rescue.security import SecurityError
from scripts import actions_bridge_runner as runner


JOB_ID = "A" * 43
RUN_ID = "99117"
HEAD_SHA = "a" * 40


def _encode(value: dict[str, object]) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(gzip.compress(raw)).decode("ascii")


def _payload(mode: str = "prepare", arguments: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "version": 1,
        "mode": mode,
        "arguments": arguments or {"repo_url": "https://github.com/example/project"},
    }


def test_decode_payload_rejects_non_base64_and_non_gzip() -> None:
    with pytest.raises(ValueError, match="strict base64"):
        runner._decode_payload("***")
    with pytest.raises(ValueError, match="gzip"):
        runner._decode_payload(base64.b64encode(b"not gzip").decode("ascii"))
    with pytest.raises(ValueError, match="only version"):
        runner._decode_payload(_encode({**_payload(), "unexpected": True}))


def test_decode_payload_enforces_exact_55kb_expanded_boundary() -> None:
    template = _payload(arguments={"padding": ""})
    empty_raw = json.dumps(template, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    exact = _payload(arguments={"padding": "x" * (runner.MAX_DECODED_BYTES - len(empty_raw))})
    exact_encoded = _encode(exact)
    assert len(gzip.decompress(base64.b64decode(exact_encoded))) == runner.MAX_DECODED_BYTES
    assert runner._decode_payload(exact_encoded)["arguments"]["padding"].startswith("x")

    oversized = _payload(arguments={"padding": "x" * (runner.MAX_DECODED_BYTES - len(empty_raw) + 1)})
    with pytest.raises(ValueError, match="decoded payload"):
        runner._decode_payload(_encode(oversized))
    with pytest.raises(ValueError, match="encoded characters"):
        runner._decode_payload("A" * (runner.MAX_ENCODED_CHARS + 1))


def test_execute_sets_only_the_reviewed_target_as_runtime_allowlist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_ALLOWED_REPOS", "example/project,other/repo")
    monkeypatch.setenv("GITHUB_TOKEN", "test-host-token")
    monkeypatch.setenv("GH_TOKEN", "test-cli-token")
    observed: dict[str, object] = {}

    def fake_prepare(repo_url: str, *, maximum_context_bytes: int) -> dict[str, object]:
        observed.update(
            repo_url=repo_url,
            maximum_context_bytes=maximum_context_bytes,
            runtime_allowlist=runner.os.environ["REPO_RESCUE_ALLOWED_REPOS"],
            backend=runner.os.environ["REPO_RESCUE_EXECUTION_BACKEND"],
            github_token=runner.os.environ.get("GITHUB_TOKEN"),
            gh_token=runner.os.environ.get("GH_TOKEN"),
        )
        return {"status": "repair_ready"}

    monkeypatch.setattr(runner, "prepare_repair", fake_prepare)
    result = runner.execute(_payload(), JOB_ID, "prepare", tmp_path)
    assert result == {"ok": True, "preparation": {"status": "repair_ready"}}
    assert observed == {
        "repo_url": "https://github.com/example/project",
        "maximum_context_bytes": 50_000,
        "runtime_allowlist": "example/project",
        "backend": "docker",
        "github_token": None,
        "gh_token": None,
    }


def test_execute_rejects_unreviewed_repo_mode_and_request_mismatch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_ALLOWED_REPOS", "other/repo")
    called = False

    def forbidden_prepare(*_args: object, **_kwargs: object) -> dict[str, object]:
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(runner, "prepare_repair", forbidden_prepare)
    with pytest.raises(SecurityError, match="reviewed"):
        runner.execute(_payload(), JOB_ID, "prepare", tmp_path)
    assert called is False
    with pytest.raises(ValueError, match="request_id"):
        runner.execute(_payload(), "short", "prepare", tmp_path)
    with pytest.raises(ValueError, match="mode"):
        runner.execute(_payload("verify"), JOB_ID, "prepare", tmp_path)


def test_verify_contract_limits_files_and_replacement_size() -> None:
    base = {
        "repo_url": "https://github.com/example/project",
        "expected_commit": "b" * 40,
        "expected_baseline_sha256": "c" * 64,
    }
    with pytest.raises(ValueError, match="between 1 and 3"):
        runner._verify_arguments({**base, "changes": [{"path": f"src/{index}.py", "content": "x"} for index in range(4)]})
    with pytest.raises(ValueError, match="12000"):
        runner._verify_arguments({**base, "changes": [{"path": "src/app.py", "content": "x" * 12_001}]})


def test_execute_verify_returns_public_wire_shape_and_requires_three_artifacts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_ALLOWED_REPOS", "example/project")
    run_id = "20260831T120000Z-1234abcd"

    def fake_verify(_repo_url: str, **kwargs: object) -> dict[str, object]:
        artifact_root = Path(kwargs["artifacts_root"]) / run_id
        artifact_root.mkdir(parents=True)
        (artifact_root / "repair.patch").write_text("patch", encoding="utf-8")
        (artifact_root / "evidence.json").write_text("{}", encoding="utf-8")
        (artifact_root / "report.md").write_text("report", encoding="utf-8")
        return {"run_id": run_id, "status": "verified_repair", "verified_repair": True}

    monkeypatch.setattr(runner, "verify_submitted_github_patch", fake_verify)
    arguments = {
        "repo_url": "https://github.com/example/project",
        "expected_commit": "b" * 40,
        "expected_baseline_sha256": "c" * 64,
        "analysis": "cause",
        "issue": "broken",
        "changes": [{"path": "src/app.py", "content": "fixed"}],
    }
    result = runner.execute(_payload("verify", arguments), JOB_ID, "verify", tmp_path)
    assert result["ok"] is True
    assert result["repair"]["verified_repair"] is True
    assert result["repair"]["artifacts"]["github_actions_artifact"] == f"repo-rescue-{JOB_ID}"
    assert set(result["repair"]["artifacts"]["available"]) == {"patch", "evidence", "report"}


def test_execute_verify_removes_oversized_artifact_bundle(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_ALLOWED_REPOS", "example/project")
    run_id = "20260831T120000Z-1234abcd"

    def oversized_verify(_repo_url: str, **kwargs: object) -> dict[str, object]:
        artifact_root = Path(kwargs["artifacts_root"]) / run_id
        artifact_root.mkdir(parents=True)
        (artifact_root / "repair.patch").write_bytes(b"x" * (runner.MAX_ARTIFACT_FILE_BYTES + 1))
        (artifact_root / "evidence.json").write_text("{}", encoding="utf-8")
        (artifact_root / "report.md").write_text("report", encoding="utf-8")
        return {"run_id": run_id, "status": "repair_failed", "verified_repair": False}

    monkeypatch.setattr(runner, "verify_submitted_github_patch", oversized_verify)
    arguments = {
        "repo_url": "https://github.com/example/project",
        "expected_commit": "b" * 40,
        "expected_baseline_sha256": "c" * 64,
        "changes": [{"path": "src/app.py", "content": "fixed"}],
    }
    with pytest.raises(RuntimeError, match="storage boundary"):
        runner.execute(_payload("verify", arguments), JOB_ID, "verify", tmp_path)
    assert not (tmp_path / run_id).exists()


def test_controlled_error_redacts_credentials() -> None:
    payload = runner._controlled_error(SecurityError("token=THIS_IS_A_TEST_VALUE"))
    serialized = json.dumps(payload)
    assert payload["ok"] is False
    assert "THIS_IS_A_TEST_VALUE" not in serialized


def test_main_binds_result_to_payload_run_and_sha(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    encoded = _encode(_payload())
    github_output = tmp_path / "github-output.txt"
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_PAYLOAD", encoded)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_REQUEST_ID", JOB_ID)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_MODE", "prepare")
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_OUTPUT", str(tmp_path / "output"))
    monkeypatch.setenv("GITHUB_RUN_ID", RUN_ID)
    monkeypatch.setenv("GITHUB_SHA", HEAD_SHA)
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    monkeypatch.setattr(runner, "execute", lambda *_args, **_kwargs: {"ok": True, "preparation": {"status": "ready"}})

    assert runner.main() == 0
    envelope = json.loads((tmp_path / "output" / "result.json").read_text(encoding="utf-8"))
    assert envelope["request_id"] == JOB_ID
    assert envelope["mode"] == "prepare"
    assert envelope["payload_sha256"] == hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    assert envelope["github_run_id"] == RUN_ID
    assert envelope["github_sha"] == HEAD_SHA
    assert envelope["result"]["ok"] is True
    assert github_output.read_text(encoding="utf-8") == f"artifact_name=repo-rescue-{JOB_ID}\n"


def test_main_writes_bound_failure_artifact_for_always_upload(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    encoded = _encode(_payload())
    github_output = tmp_path / "github-output.txt"
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_PAYLOAD", encoded)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_REQUEST_ID", JOB_ID)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_MODE", "prepare")
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_OUTPUT", str(tmp_path / "output"))
    monkeypatch.setenv("GITHUB_RUN_ID", RUN_ID)
    monkeypatch.setenv("GITHUB_SHA", HEAD_SHA)
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    monkeypatch.setattr(runner, "execute", lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("rejected")))

    assert runner.main() == 1
    envelope = json.loads((tmp_path / "output" / "result.json").read_text(encoding="utf-8"))
    assert envelope["result"]["ok"] is False
    assert envelope["result"]["status"] == "invalid_request"
    assert github_output.read_text(encoding="utf-8") == f"artifact_name=repo-rescue-{JOB_ID}\n"


@pytest.mark.parametrize(
    ("github_run_id", "github_sha"),
    [("not-a-run", HEAD_SHA), (RUN_ID, "short-sha")],
)
def test_main_rejects_invalid_github_run_binding_but_still_writes_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    github_run_id: str,
    github_sha: str,
) -> None:
    encoded = _encode(_payload())
    output = tmp_path / f"output-{github_run_id}"
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_PAYLOAD", encoded)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_REQUEST_ID", JOB_ID)
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_MODE", "prepare")
    monkeypatch.setenv("REPO_RESCUE_BRIDGE_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_RUN_ID", github_run_id)
    monkeypatch.setenv("GITHUB_SHA", github_sha)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    assert runner.main() == 1
    envelope = json.loads((output / "result.json").read_text(encoding="utf-8"))
    assert envelope["result"]["ok"] is False
    assert envelope["result"]["status"] == "invalid_request"

from repo_rescue.cli import _print_result, _report_exit_code, build_parser


def test_cli_exposes_read_only_inspection() -> None:
    args = build_parser().parse_args(["inspect", "https://github.com/example/project", "--json"])

    assert args.command == "inspect"
    assert args.repo_url == "https://github.com/example/project"
    assert args.as_json is True


def test_cli_treats_already_passing_as_success_without_calling_it_a_repair() -> None:
    assert _report_exit_code({"status": "already_passing", "verified_repair": False}) == 0
    assert _report_exit_code({"status": "verified_repair", "verified_repair": True}) == 0
    assert _report_exit_code({"status": "repair_failed", "verified_repair": False}) == 1


def test_print_result_handles_dependency_install_failure(capsys) -> None:  # type: ignore[no-untyped-def]
    _print_result(
        {
            "status": "repair_failed",
            "repository": {"slug": "demo/app", "commit": "abc"},
            "baseline": {"command": "python -m pytest -q", "install": {"exit_code": 1}, "execution": None},
            "final_verification": {"install": {"exit_code": 1}, "execution": None},
            "changed_files": [],
            "artifacts": {},
        },
        as_json=False,
    )

    output = capsys.readouterr().out
    assert "before: exit 1" in output
    assert "after:  exit 1" in output

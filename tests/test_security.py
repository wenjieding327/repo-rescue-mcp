import pytest

from repo_rescue.security import SecurityError, normalize_github_url, redact


def test_normalizes_public_github_url() -> None:
    clone_url, slug = normalize_github_url("https://github.com/Pallets/click")
    assert clone_url == "https://github.com/Pallets/click.git"
    assert slug == "pallets/click"


@pytest.mark.parametrize(
    "value",
    [
        "http://github.com/pallets/click",
        "https://gitlab.com/pallets/click",
        "https://github.com/pallets/click/issues",
        "https://token@github.com/pallets/click",
    ],
)
def test_rejects_unsafe_repository_urls(value: str) -> None:
    with pytest.raises(SecurityError):
        normalize_github_url(value)


def test_redacts_common_secret_assignments() -> None:
    assert "super-secret" not in redact("api_key=super-secret")


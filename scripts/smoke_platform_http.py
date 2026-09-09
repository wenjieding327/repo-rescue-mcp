"""Verify HTTP plugin adapter without printing credentials or SDK exceptions."""
import json
import os
import sys
import urllib.request
import urllib.error


def main():
    base = sys.argv[1].rstrip("/")
    token = os.environ.get("REPO_RESCUE_HTTP_ACCESS_TOKEN", "")
    if not token:
        raise ValueError("Missing gateway credential")

    def call(name, args, authorized=True):
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(base + "/api/tools/" + name,
            data=json.dumps(args).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    assert call("get_repair_job", {}, False)[0] == 401
    assert call("windows_environment_probe", {})[0] == 404
    print(json.dumps({"authentication_enforced": True, "hidden_tool_rejected": True}), flush=True)
    for label, original, candidate, expected in [
        ("snippet_repair", "print(1 / 0)", "print(0)", True),
        ("unsafe_import", "import os\nprint(os.getcwd())", "import os\nprint(os.getcwd())", False),
    ]:
        status, envelope = call("rescue_python_snippet", {
            "original_code": original, "candidate_code": candidate,
            "test_cases": [{"name": "output", "expected_stdout": "0"}],
        })
        assert status == 200 and not envelope["is_error"]
        result = json.loads(json.loads(envelope["result_json"])["content"][0]["text"])
        assert result["fix_verified"] is expected
        if not expected:
            assert "PermissionError" in json.dumps(result)
        print(json.dumps({"case": label, "fix_verified": result["fix_verified"],
            "status": result["status"], "test_results": result["test_results"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error_type": type(error).__name__}), flush=True)
        sys.exit(1)

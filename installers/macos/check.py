"""Verify installation against disposable homes; never use the real catalog."""
import json
import pathlib
import subprocess
import tempfile
import sys
import os
import urllib.parse
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAYLOAD = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "dist/goodfinds-marketplace"
TARGET = json.loads((PAYLOAD / "server/build.json").read_text())["target"]
CPU = "universal" if TARGET == "universal-apple-darwin" else "arm64" if TARGET.startswith("aarch64") else "x86_64"
OUTPUT = pathlib.Path(os.environ.get("GOODFINDS_INSTALLER_OUTPUT", ROOT / "dist"))
INSTALLER = pathlib.Path(os.environ.get("GOODFINDS_INSTALLER_EXECUTABLE", OUTPUT / f"installers/macos-{CPU}/Goodfinds Setup.app/Contents/MacOS/GoodfindsInstaller"))
ARCH = os.environ.get("GOODFINDS_TEST_ARCH")


def command(executable, *args):
    prefix = ["arch", f"-{ARCH}"] if ARCH else []
    return prefix + [str(executable), *map(str, args)]


def run(home, success=True):
    result = subprocess.run(command(INSTALLER, "--test-home", home, "--payload", PAYLOAD), capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stderr
    return pathlib.Path(result.stdout.strip()) if success else None


with tempfile.TemporaryDirectory(prefix="goodfinds-installer-test-") as temporary:
    home = pathlib.Path(temporary)
    catalog = home / ".agents/plugins/marketplace.json"
    data = home / ".local/share/goodfinds/workspace.sqlite"
    data.parent.mkdir(parents=True)
    data.write_bytes(b"existing buyer data")
    first = run(home)
    assert first.is_dir() and (first / "server/goodfinds").is_file()
    server = first / "server/goodfinds"
    if CPU == "universal":
        for executable in [INSTALLER, server]:
            assert set(subprocess.check_output(["lipo", str(executable), "-archs"], text=True).split()) == {"arm64", "x86_64"}
    version = subprocess.check_output(command(server, "--version"), text=True).strip()
    assert version == json.loads((PAYLOAD / ".codex-plugin/plugin.json").read_text())["version"]
    subprocess.run(command(server, "doctor"), env={**os.environ, "GOODFINDS_WORKSPACE_DIR": str(home / "runtime-check")}, check=True, capture_output=True, timeout=30)
    result = json.loads(catalog.read_text())
    assert result["plugins"][0]["source"]["path"] == "./" + str(first.relative_to(home))
    other = {"name": "another-plugin", "source": {"source": "local", "path": "./another"}}
    result["name"] = "existing-personal"
    result["extra"] = "keep me"
    result["plugins"].insert(0, other)
    catalog.write_text(json.dumps(result))
    second = run(home)
    assert first == second
    result = json.loads(catalog.read_text())
    assert result["name"] == "existing-personal" and result["extra"] == "keep me"
    assert result["plugins"][0] == other and len(result["plugins"]) == 2
    assert data.read_bytes() == b"existing buyer data"
    unusual_home = home / "A name with & # + ü"
    link = subprocess.check_output(command(INSTALLER, "--link-home", unusual_home), text=True).strip()
    parsed = urllib.parse.urlsplit(link)
    assert (parsed.scheme, parsed.netloc, parsed.path) == ("codex", "plugins", "/goodfinds-marketplace")
    query = urllib.parse.parse_qs(parsed.query)
    assert set(query) == {"marketplacePath"} and len(query["marketplacePath"]) == 1
    assert unicodedata.normalize("NFC", query["marketplacePath"][0]) == str(unusual_home / ".agents/plugins/marketplace.json")
    catalog.write_text("broken json")
    run(home, success=False)
    assert catalog.read_text() == "broken json"
    assert data.read_bytes() == b"existing buyer data"
print("PASS: fresh/repeat install, catalog/data preservation, malformed catalog rejection, plugin link encoding")

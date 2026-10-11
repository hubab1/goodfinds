"""Check the shipping package and run its real postinstall in disposable homes."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

PACKAGE = pathlib.Path(sys.argv[1]).resolve()
CHECK = pathlib.Path(__file__).with_name("check.py")

with tempfile.TemporaryDirectory(prefix="goodfinds-package-check-") as temporary:
    root = pathlib.Path(temporary)
    expanded = root / "expanded"
    subprocess.run(["pkgutil", "--expand-full", str(PACKAGE), str(expanded)], check=True)
    distribution = ET.parse(expanded / "Distribution").getroot()
    domains = distribution.find("domains")
    assert domains is not None
    assert domains.attrib == {
        "enable_anywhere": "false",
        "enable_currentUserHome": "true",
        "enable_localSystem": "false",
    }
    reference = distribution.find("pkg-ref")
    assert reference is not None and reference.get("auth") == "none"
    assert distribution.find("options").get("hostArchitectures") == "arm64,x86_64"
    assert distribution.find("volume-check/allowed-os-versions/os-version").get("min") == "13.0"
    available = subprocess.check_output(["installer", "-dominfo", "-pkg", str(PACKAGE)], text=True)
    assert "CurrentUserHomeDirectory" in available and "LocalSystem" not in available

    scripts = expanded / "Goodfinds-component.pkg/Scripts"
    app = scripts / "Goodfinds Setup.app"
    executable = app / "Contents/MacOS/GoodfindsInstaller"
    payload = app / "Contents/Resources/plugin"
    subprocess.run(
        [sys.executable, str(CHECK), str(payload)],
        env={**os.environ, "GOODFINDS_INSTALLER_EXECUTABLE": str(executable)},
        check=True,
    )

    # This is the exact postinstall extracted from the product archive, including
    # its bundled executable and payload. Installer's $2 is the user's home.
    home = root / "Buyer with spaces & + ü"
    home.mkdir()
    catalog = home / ".agents/plugins/marketplace.json"
    command = [str(scripts / "postinstall"), str(PACKAGE), str(home), "/"]
    environment = {**os.environ, "COMMAND_LINE_INSTALL": "1"}
    subprocess.run(command, env=environment, check=True, capture_output=True, text=True)
    first = json.loads(catalog.read_text())
    installed = home / first["plugins"][0]["source"]["path"]
    assert (installed / "server/goodfinds").is_file()
    other = {"name": "another-plugin", "source": {"source": "local", "path": "./another"}}
    first["plugins"].append(other)
    catalog.write_text(json.dumps(first))
    subprocess.run(command, env=environment, check=True, capture_output=True, text=True)
    repeated = json.loads(catalog.read_text())
    assert len(repeated["plugins"]) == 2 and other in repeated["plugins"]
    catalog.write_text("broken catalog")
    failed = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert failed.returncode != 0 and catalog.read_text() == "broken catalog"
    invalid = subprocess.run([str(scripts / "postinstall"), str(PACKAGE), "/", "/"], env=environment, capture_output=True)
    assert invalid.returncode != 0

print("PASS: direct package, user-only domain, bundled installation, repeat install, failure propagation")

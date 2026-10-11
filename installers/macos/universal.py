"""Merge matching Mac plugin packages into a single universal payload."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def inventory(root):
    files = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Unexpected symbolic link: {path}")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if relative not in ("server/goodfinds", "server/build.json"):
                files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def merge(arm, intel, output):
    inputs = [(arm, "aarch64-apple-darwin", "arm64"), (intel, "x86_64-apple-darwin", "x86_64")]
    for root, target, arch in inputs:
        build = json.loads((root / "server/build.json").read_text())
        if build != {"target": target, "runtime": "native-rust", "executable": "goodfinds"}:
            raise ValueError(f"Expected a native {target} package")
        subprocess.run(["lipo", str(root / "server/goodfinds"), "-verify_arch", arch], check=True)
    if inventory(arm) != inventory(intel):
        raise ValueError("The two packages must contain identical plugin files from the same source revision")
    if output.exists():
        raise ValueError("The output already exists; use a fresh output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".universal-", dir=output.parent) as temporary:
        staged = Path(temporary) / "plugin"
        shutil.copytree(arm, staged)
        binary = staged / "server/goodfinds"
        binary.unlink()
        subprocess.run(["lipo", "-create", str(arm / "server/goodfinds"), str(intel / "server/goodfinds"), "-output", str(binary)], check=True)
        binary.chmod(0o755)
        assert set(subprocess.check_output(["lipo", str(binary), "-archs"], text=True).split()) == {"arm64", "x86_64"}
        (staged / "server/build.json").write_text(json.dumps({
            "target": "universal-apple-darwin",
            "targets": [target for _, target, _ in inputs],
            "runtime": "native-rust",
            "executable": "goodfinds",
        }) + "\n")
        staged.rename(output)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arm", type=Path)
    parser.add_argument("intel", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    merge(args.arm.resolve(), args.intel.resolve(), args.output.resolve())

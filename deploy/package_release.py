#!/usr/bin/env python3
"""Package only committed source and binaries from the verified CI images."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_snapshot(root, destination, revision):
    with tempfile.TemporaryFile() as stream:
        subprocess.run(["git", "-C", str(root), "archive", revision], stdout=stream, check=True)
        stream.seek(0)
        with tarfile.open(fileobj=stream) as archive:
            archive.extractall(destination, filter="data")


def image_info(image, revision=None):
    data = json.loads(command("docker", "image", "inspect", image))[0]
    if data["Os"] != "linux" or data["Architecture"] != "amd64":
        raise ValueError("this release supports Linux amd64 images only")
    if revision and data["Config"]["Labels"].get("org.opencontainers.image.revision") != revision:
        raise ValueError("image source revision does not match the release")
    return {"name": image, "id": data["Id"], "repo_digests": data.get("RepoDigests", [])}


def copy_from_image(image, items):
    container = command("docker", "create", image)
    try:
        for source, target in items:
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["docker", "cp", f"{container}:{source}", str(target)], check=True)
    finally:
        subprocess.run(["docker", "rm", container], check=True, stdout=subprocess.DEVNULL)


def native_dependencies(binary):
    versions = command("readelf", "--version-info", str(binary))
    glibc = {tuple(map(int, item.split("."))) for item in re.findall(r"GLIBC_(\d+(?:\.\d+)+)", versions)}
    if not glibc:
        raise ValueError("cannot determine the binary's glibc requirement")
    dependencies = command("ldd", str(binary))
    if "not found" in dependencies:
        raise ValueError("native binary has missing libraries on the CI runner")
    return {"minimum_glibc": ".".join(map(str, max(glibc))), "ldd_on_ci": dependencies,
            "sha256": digest(binary)}


def package(root, output):
    revision = command("git", "-C", str(root), "rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or revision != os.environ["GITHUB_SHA"]:
        raise ValueError("package must match the exact CI source commit")
    if command("git", "-C", str(root), "status", "--porcelain"):
        raise ValueError("package from a clean committed checkout")
    version = tomllib.loads((root / "Cargo.toml").read_text())["package"]["version"]
    agent = json.loads((root / "deploy/docker/agent.lock.json").read_text())["revision"]
    widget = json.loads((root / "frontend/widget.lock.json").read_text())["sha"]
    images = [f"saudade-blog/backend:{revision}", f"saudade-blog/frontend:{revision}",
              f"saudade-blog/agent:{agent}", "postgres:16-bookworm"]
    provenance = [image_info(image, sha) for image, sha in zip(images, [revision, revision, agent, None])]
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary) / f"saudade-blog-{version}"
        stage.mkdir()
        source_snapshot(root, stage, revision)
        binaries = stage / "target/release"
        copy_from_image(images[0], [("/usr/local/bin/saudade_blog_bin", binaries / "saudade_blog_bin"),
                                    ("/usr/local/bin/saudade-bootstrap-admin", binaries / "saudade-bootstrap-admin")])
        copy_from_image(images[1], [("/srv/frontend/dist", stage / "frontend/dist"),
                                    ("/usr/share/doc/saudade", stage / "licenses")])
        build_info = json.loads((stage / "frontend/dist/build-info.json").read_text())
        if build_info["sha"] != revision:
            raise ValueError("frontend build-info does not match source")
        metadata = {"schema_version": 1, "version": version, "source_revision": revision,
                    "source_url": f"https://github.com/BigLeopardCat/Saudade-Blog/tree/{revision}",
                    "agent_revision": agent, "widget_revision": widget, "platform": "linux-x86_64",
                    "backend_os": command("docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", images[0], "/etc/os-release"),
                    "rustc": command("docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", images[0], "/usr/share/doc/saudade/rustc-version.txt"),
                    "native_binaries": {p.name: native_dependencies(p) for p in sorted(binaries.iterdir())},
                    "images": provenance, "frontend_mode": "portable origin, neutral build-time metadata",
                    "scope": "No private configuration, database, upload volume, model or GPU runtime is included."}
        (stage / "release-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
        native = output / f"saudade-blog-{version}-linux-x86_64.tar.gz"
        with tarfile.open(native, "w:gz") as archive:
            archive.add(stage, arcname=stage.name)
    image_archive = output / f"saudade-blog-{version}-images-linux-amd64.tar.gz"
    with image_archive.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=1) as stream:
        process = subprocess.Popen(["docker", "image", "save", *images], stdout=subprocess.PIPE)
        try:
            shutil.copyfileobj(process.stdout, stream)
        finally:
            process.stdout.close()
        if process.wait() != 0:
            raise RuntimeError("docker image save failed")
    for path in output.iterdir():
        if path.stat().st_size >= 1_900_000_000:
            raise ValueError("release asset exceeds the supported size")
    metadata["artifacts"] = {p.name: {"sha256": digest(p), "bytes": p.stat().st_size} for p in sorted(output.iterdir())}
    (output / "release-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output / "SHA256SUMS").write_text("".join(f"{digest(p)}  {p.name}\n" for p in sorted(output.iterdir()) if p.name != "SHA256SUMS"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    package(Path(__file__).resolve().parents[1], args.output.resolve())

"""Exercise the publisher without credentials, network access or real build artifacts."""
import importlib.util
import io
import json
import os
import runpy
import sys
import tarfile
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_index_contract", ROOT / "scripts/deploy/database_indexes.py")
indexes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(indexes)
SHA = "a" * 40


class ReleaseContract(unittest.TestCase):
    def publish(self, source_commit):
        uploads, pointers = [], []
        client = types.SimpleNamespace(
            upload_fileobj=lambda buf, bucket, key: uploads.append((bucket, key, buf.read())),
            put_object=lambda **kwargs: pointers.append(kwargs),
        )
        boto = types.ModuleType("boto3")
        boto.client = lambda *args, **kwargs: client
        botocore = types.ModuleType("botocore")
        config = types.ModuleType("botocore.config")
        config.Config = lambda **kwargs: None
        credentials = types.ModuleType("deployment_config")
        credentials.read_deployment_config = lambda: dict(R2_ENDPOINT="https://synthetic.invalid",
            R2_ACCESS_KEY="fixture", R2_SECRET_KEY="fixture", R2_BUCKET="fixture")
        modules = {"boto3": boto, "botocore": botocore, "botocore.config": config,
                   "deployment_config": credentials, "database_indexes": indexes}
        catalog = {"postgres_major": 16, "tables": ["note"], "indexes": [{
            "name": "note_pkey", "table_name": "note", "is_unique": True, "is_primary": True,
            "valid": True, "ready": True, "live": True,
            "definition": "CREATE UNIQUE INDEX note_pkey ON public.note USING btree (id)",
        }], "unvalidated_constraints": []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frontend = root / "frontend/dist"
            frontend.mkdir(parents=True)
            (frontend / "index.html").write_text("candidate")
            contract = root / "ci-contract.json"
            contract.write_text(json.dumps(indexes.make_contract(catalog, source_commit)))
            previous = Path.cwd()
            try:
                os.chdir(root)
                with patch.dict(sys.modules, modules), patch.dict(os.environ, {
                    "DEPLOY_SHA": SHA, "DATABASE_INDEX_CONTRACT": str(contract)}, clear=True), redirect_stdout(io.StringIO()):
                    try:
                        runpy.run_path(str(ROOT / "scripts/deploy/upload_to_r2.py"), run_name="__main__")
                    except ValueError as error:
                        return uploads, pointers, error
            finally:
                os.chdir(previous)
        return uploads, pointers, None

    def test_ci_contract_and_application_share_the_same_release_archive(self):
        uploads, pointers, error = self.publish(SHA)
        self.assertIsNone(error)
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0][:2], ("fixture", f"deploy/{SHA}/deploy.tar.gz"))
        with tarfile.open(fileobj=io.BytesIO(uploads[0][2]), mode="r:gz") as archive:
            contract = indexes.load_contract(archive.extractfile("database-indexes.json").read(), SHA)
            self.assertEqual(contract["source_commit"], SHA)
            self.assertEqual(archive.extractfile("frontend/dist/index.html").read(), b"candidate")
        self.assertEqual(pointers[0]["Body"], SHA.encode())

    def test_wrong_release_contract_cannot_upload_or_change_latest_pointer(self):
        uploads, pointers, error = self.publish("b" * 40)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(uploads, [])
        self.assertEqual(pointers, [])

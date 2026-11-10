"""Synthetic graph generation and publication; no Agent, HTTP or database required."""

import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location(
    "graph_builder", Path(__file__).with_name("build.py")
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class GraphBuildTests(unittest.TestCase):
    def fixture(self):
        rows = [
            dict(
                id=1,
                title="Rust Tokio 并发",
                content="Rust 并发运行时",
                description="",
                category="Programming",
            ),
            dict(
                id=2,
                title="Python asyncio 协程",
                content="Python 协程编程",
                description="",
                category="Programming",
            ),
            dict(
                id=3,
                title="Database PostgreSQL 索引",
                content="数据库索引查询",
                description="",
                category="Database",
            ),
        ]
        for row in rows:
            row["revision"] = "2026-11-10T00:00:00.000000"
        return (
            dict(fingerprint="a" * 64, dimension=3),
            rows,
            {
                1: np.array([1.0, 0.0, 0.0]),
                2: np.array([0.0, 1.0, 0.0]),
                3: np.array([0.0, 0.0, 1.0]),
            },
        )

    def test_source_vectors_drive_geometry_and_public_article_mapping(self):
        snapshot, rows, vectors = self.fixture()
        graph, source = builder.build(snapshot, rows, vectors, "blog-public", 40)
        self.assertGreaterEqual(len(graph["nodes"]), 4)
        self.assertEqual(source["fingerprint"], snapshot["fingerprint"])
        self.assertEqual(source["article_ids"], [1, 2, 3])
        self.assertTrue(
            all(np.isfinite([n["x"], n["y"], n["z"]]).all() for n in graph["nodes"])
        )
        self.assertTrue(
            all(set(row["articles"]) <= {1, 2, 3} for row in source["words"])
        )
        for field in ("embedding", "api_key", "base_url"):
            self.assertNotIn(field, source)
        self.assertIn("rust", {row["word"] for row in source["words"]})
        self.assertTrue(any("协程" in row["word"] for row in source["words"]))

    def test_manifest_is_published_only_after_matching_content_and_private_source(self):
        graph, source = builder.build(*self.fixture(), "blog-public", 40)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = builder.publish(root, graph, source, "https://example.test")
            self.assertEqual(json.loads((root / "manifest.json").read_text()), manifest)
            private = root / f"source-{manifest['v']}.json"
            self.assertEqual(json.loads(private.read_text())["version"], manifest["v"])
            self.assertEqual(private.stat().st_mode & 0o777, 0o640)
            old = (root / "manifest.json").read_bytes()
            with patch.object(
                builder, "atomic_file", side_effect=OSError("disk fixture")
            ):
                with self.assertRaises(OSError):
                    builder.publish(root, graph, source, "https://other.test")
            self.assertEqual((root / "manifest.json").read_bytes(), old)

    def test_missing_public_membership_does_not_generate_an_artifact(self):
        snapshot, _, vectors = self.fixture()
        with self.assertRaisesRegex(ValueError, "currently public"):
            builder.build(snapshot, [], vectors, "blog-public", 40)

    def test_custom_profile_requires_its_exact_exported_contract_and_tokenizer(self):
        snapshot, rows, vectors = self.fixture()
        raw = b"fixture tokenizer"
        digest = hashlib.sha256(raw).hexdigest()
        identity = dict(
            schema_version=1,
            tokenizer_sha256=digest,
            max_tokens=512,
            query_prefix="Q: ",
            add_special_tokens=True,
            model_revision="fixture;llama-test;",
        )
        payload = json.dumps(identity, sort_keys=True)
        snapshot["space"] = {"profile": hashlib.sha256(payload.encode()).hexdigest()}
        contract = dict(
            schema_version=1,
            signature_payload=payload,
            tokenization_protocol="llama.cpp-tokenize-v1",
        )
        with self.assertRaisesRegex(ValueError, "verified query contract"):
            builder.build(snapshot, rows, vectors, "blog-public", 40)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "query-contract.json"
            path.write_text(json.dumps(contract))
            tokenizer = root / f"tokenizer-{digest}.json"
            tokenizer.write_bytes(raw)
            self.assertEqual(builder.query_contract(path, snapshot), (contract, raw))
            graph, source = builder.build(
                snapshot, rows, vectors, "blog-public", 40, contract
            )
            with self.assertRaisesRegex(ValueError, "Matching query tokenizer"):
                builder.publish(
                    root / "published", graph, source, "https://example.test"
                )
            manifest = builder.publish(
                root / "published", graph, source, "https://example.test", raw
            )
            self.assertEqual(source["embedding_profile"], contract)
            self.assertEqual((root / "published" / tokenizer.name).read_bytes(), raw)
            self.assertEqual(manifest["v"], source["version"])
            path.write_text(
                json.dumps({**contract, "signature_payload": payload + " "})
            )
            with self.assertRaisesRegex(ValueError, "does not match"):
                builder.query_contract(path, snapshot)
            path.write_text(json.dumps(contract))
            tokenizer.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                builder.query_contract(path, snapshot)

    def test_no_agent_configuration_is_needed_for_build_logic(self):
        with patch.dict("os.environ", {}, clear=True):
            graph, _ = builder.build(*self.fixture(), "blog-public", 40)
        self.assertEqual(graph["dim"], 3)


if __name__ == "__main__":
    unittest.main()

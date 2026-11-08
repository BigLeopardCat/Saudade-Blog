import copy
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("database_indexes", ROOT / "scripts/deploy/database_indexes.py")
db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(db)
SHA = "a" * 40


def catalog():
    return {"postgres_major": 16, "tables": ["note"], "indexes": [{
        "name": "note_pkey", "table_name": "note",
        "definition": "CREATE UNIQUE INDEX note_pkey ON public.note USING btree (id)",
        "is_unique": True, "is_primary": True, "valid": True, "ready": True, "live": True,
    }], "unvalidated_constraints": []}


def archive(raw, *, name=db.CONTRACT_MEMBER, kind=tarfile.REGTYPE, duplicate=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        item = tarfile.TarInfo(name)
        item.type = kind
        item.size = len(raw) if kind == tarfile.REGTYPE else 0
        tar.addfile(item, io.BytesIO(raw) if item.size else None)
        if duplicate:
            tar.addfile(item, io.BytesIO(raw))
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r")


class IndexContract(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"PSQL_BIN": "psql"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.expected = db.make_contract(catalog(), SHA)

    def test_private_connection_configuration_and_explicit_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "database-check.json"
            file.write_text(json.dumps({"database":"fixture", "psql":["sudo","-n","-u","postgres","psql"]}))
            file.chmod(0o600)
            with patch.dict(os.environ, {"SAUDADE_DATABASE_CHECK_CONFIG": str(file)}):
                database, command = db.connection_options()
                self.assertEqual(command, ["psql"], "process environment overrides file")
                self.assertEqual(database, "fixture")
                with patch.dict(os.environ, {}, clear=True):
                    with patch.dict(os.environ, {"SAUDADE_DATABASE_CHECK_CONFIG":str(file)}):
                        self.assertEqual(db.connection_options()[1][:2], ["sudo","-n"])
                file.chmod(0o644)
                with self.assertRaises(ValueError):
                    db.connection_options()

    def test_ci_never_reads_machine_configuration(self):
        with patch.object(Path, "exists", side_effect=AssertionError("local config read")):
            self.assertEqual(db.connection_options("fixture", "psql"), ("fixture", ["psql"]))

    def test_missing_index_and_changed_sort_include_predicate_are_rejected(self):
        for definition in [
            "CREATE UNIQUE INDEX note_pkey ON public.note USING btree (id DESC)",
            "CREATE UNIQUE INDEX note_pkey ON public.note USING btree (id) INCLUDE (title)",
            "CREATE UNIQUE INDEX note_pkey ON public.note USING btree (id) WHERE id > 0",
        ]:
            actual = catalog()
            actual["indexes"][0]["definition"] = definition
            self.assertEqual(db.compare(self.expected, actual), ["index definition differs: note_pkey"])
        actual = catalog()
        actual["indexes"][0]["name"] = "another_index"
        self.assertEqual(db.compare(self.expected, actual), ["missing index: note_pkey"])

    def test_invalid_extra_indexes_and_unvalidated_constraints_fail(self):
        for flag in ["valid", "ready", "live"]:
            actual = catalog()
            extra = dict(actual["indexes"][0], name="unfinished", **{flag: False})
            actual["indexes"].append(extra)
            self.assertIn("unusable index: unfinished", db.compare(self.expected, actual))
        actual = catalog()
        actual["unvalidated_constraints"] = ["note_owner_fkey"]
        self.assertIn("unvalidated constraint: note_owner_fkey", db.compare(self.expected, actual))

    def test_healthy_optional_tables_and_indexes_are_allowed(self):
        actual = catalog()
        actual["tables"].append("optional_cache")
        actual["indexes"].append(dict(actual["indexes"][0], name="optional_pkey", table_name="optional_cache"))
        self.assertEqual(db.compare(self.expected, actual), [])

    def test_missing_table_primary_identity_and_major_version_fail(self):
        actual = catalog()
        actual["tables"] = ["renamed"]
        actual["indexes"][0]["table_name"] = "renamed"
        self.assertIn("missing table: note", db.compare(self.expected, actual))
        actual = catalog()
        actual["indexes"][0]["is_primary"] = False
        self.assertIn("index definition differs: note_pkey", db.compare(self.expected, actual))
        actual = catalog()
        actual["postgres_major"] = 17
        self.assertTrue(db.compare(self.expected, actual))

    def test_unhealthy_export_and_wrong_release_fail(self):
        actual = catalog()
        actual["indexes"][0]["valid"] = False
        with self.assertRaises(ValueError):
            db.make_contract(actual, SHA)
        with self.assertRaisesRegex(ValueError, "another release"):
            db.load_contract(json.dumps(self.expected).encode(), "b" * 40)
        for raw in [b"{}", b"null", b"[]", b"x" * (db.MAX_CONTRACT_BYTES + 1)]:
            with self.assertRaises(ValueError):
                db.load_contract(raw)

    def test_archive_requires_one_regular_bounded_contract(self):
        raw = json.dumps(self.expected).encode()
        for kwargs in [{"name": "other.json"}, {"kind": tarfile.SYMTYPE}, {"duplicate": True}]:
            with archive(raw, **kwargs) as tar, self.assertRaises(ValueError), patch.object(db, "read_catalog") as read:
                db.check_archive(tar, SHA)
            read.assert_not_called()
        with archive(raw) as tar, patch.object(db, "read_catalog", return_value=catalog()):
            db.check_archive(tar, SHA)

    def test_read_is_transactionally_read_only_even_through_command_wrappers(self):
        result = subprocess.CompletedProcess([], 0, json.dumps(catalog()), "")
        with patch.object(db.subprocess, "run", return_value=result) as run:
            db.read_catalog("fixture", "docker exec -i ci-db psql -U postgres")
        args, kwargs = run.call_args
        self.assertEqual(args[0][:6], ["docker", "exec", "-i", "ci-db", "psql", "-U"])
        self.assertIn("BEGIN READ ONLY", args[0][-1])
        self.assertIn("SET LOCAL statement_timeout=5000", args[0][-1])
        self.assertIn("SET LOCAL lock_timeout=1000", args[0][-1])
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs["timeout"], 15)

    def test_connection_errors_do_not_echo_secrets(self):
        secret = "private-dsn-must-not-appear"
        result = subprocess.CompletedProcess([], 2, "", secret)
        with patch.object(db.subprocess, "run", return_value=result):
            with self.assertRaises(ValueError) as caught:
                db.read_catalog("fixture")
        self.assertNotIn(secret, str(caught.exception))

    def test_bad_catalog_does_not_become_a_successful_check(self):
        for output in ["not json", "null", "{}"]:
            result = subprocess.CompletedProcess([], 0, output, "")
            with patch.object(db.subprocess, "run", return_value=result), self.assertRaises(ValueError):
                db.read_catalog()

    def test_failed_gate_preserves_current_files_and_success_extracts_candidate(self):
        raw = json.dumps(self.expected).encode()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as tar:
            for name, data in [(db.CONTRACT_MEMBER, raw), ("served/index.html", b"candidate")]:
                item = tarfile.TarInfo(name)
                item.size = len(data)
                tar.addfile(item, io.BytesIO(data))
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / "served/index.html"
            page.parent.mkdir()
            page.write_text("current")
            bad = catalog()
            bad["indexes"][0]["name"] = "wrong"
            buffer.seek(0)
            with tarfile.open(fileobj=buffer) as tar, patch.object(db, "read_catalog", return_value=bad):
                with self.assertRaisesRegex(ValueError, "missing index"):
                    db.extract_checked_archive(tar, SHA, destination=directory)
            self.assertEqual(page.read_text(), "current")
            self.assertFalse((Path(directory) / db.CONTRACT_MEMBER).exists())
            buffer.seek(0)
            with tarfile.open(fileobj=buffer) as tar, patch.object(db, "read_catalog", return_value=catalog()):
                db.extract_checked_archive(tar, SHA, destination=directory)
            self.assertEqual(page.read_text(), "candidate")

    def test_database_credentials_cannot_become_process_arguments(self):
        with patch.object(db.subprocess, "run") as run, self.assertRaises(ValueError):
            db.read_catalog("postgres://user:private@host/db")
        run.assert_not_called()


@unittest.skipUnless(os.environ.get("DATABASE_INDEX_TEST_PG") == "1", "isolated PostgreSQL required")
class PostgreSQLContract(unittest.TestCase):
    def setUp(self):
        import shlex
        import uuid
        self.command = shlex.split(os.environ.get("PSQL_BIN", "psql"))
        self.name = "ci_index_contract_" + uuid.uuid4().hex
        self.sql("postgres", 'CREATE DATABASE "' + self.name + '"')
        self.addCleanup(self.sql, "postgres", 'DROP DATABASE IF EXISTS "' + self.name + '" WITH (FORCE)')
        self.sql(self.name, "CREATE TABLE note(id integer PRIMARY KEY, title text); CREATE INDEX note_title ON note(title);")
        self.expected = db.make_contract(db.read_catalog(self.name), SHA)

    def sql(self, database, sql, *, check=True):
        result = subprocess.run(self.command + ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
            "-d", database, "-c", sql], capture_output=True, text=True, timeout=15)
        if check and result.returncode:
            self.fail("isolated PostgreSQL fixture command failed: " + result.stderr)
        return result

    def test_real_missing_and_wrong_definition_are_rejected(self):
        self.assertEqual(db.compare(self.expected, db.read_catalog(self.name)), [])
        self.sql(self.name, "DROP INDEX note_title")
        self.assertIn("missing index: note_title", db.compare(self.expected, db.read_catalog(self.name)))
        self.sql(self.name, "CREATE INDEX note_title ON note(title DESC)")
        self.assertIn("index definition differs: note_title", db.compare(self.expected, db.read_catalog(self.name)))

    def test_failed_concurrent_build_is_not_accepted(self):
        self.sql(self.name, "INSERT INTO note VALUES(1,'same'),(2,'same')")
        failed = self.sql(self.name, "CREATE UNIQUE INDEX CONCURRENTLY unfinished ON note(title)", check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("unusable index: unfinished", db.compare(self.expected, db.read_catalog(self.name)))

    def test_nullable_fk_lookup_and_statistics_refresh(self):
        self.sql(self.name, "CREATE TABLE chat_history(id integer PRIMARY KEY, user_id integer, conversation_id integer);"
            "CREATE TABLE chat_task_input(message_id integer);"
            "CREATE TABLE image_generation(image_id integer, retry_of uuid);")
        for migration in ["0010_chat_latest_index.sql", "0031_deletion_reference_indexes.sql"]:
            self.sql(self.name, (ROOT / "scripts/migration/pg" / migration).read_text())
        got = db.read_catalog(self.name)
        names = {i["name"] for i in got["indexes"]}
        self.assertTrue({"idx_chat_history_user_latest", "chat_task_input_message", "image_generation_image", "image_generation_retry"} <= names)
        plan = json.loads(self.sql(self.name, "SET enable_seqscan=off;EXPLAIN (FORMAT JSON) SELECT 1 FROM chat_task_input WHERE message_id=1").stdout)
        self.assertIn("chat_task_input_message", json.dumps(plan))
        self.sql(self.name, "INSERT INTO chat_task_input VALUES(1),(NULL);ANALYZE chat_task_input")
        count = self.sql(self.name, "SELECT reltuples FROM pg_class WHERE oid='chat_task_input'::regclass").stdout.strip()
        self.assertEqual(float(count), 2)

    def test_sampling_is_limited_to_one_login_and_omits_parameters(self):
        import uuid
        role = "ci_sampling_" + uuid.uuid4().hex
        self.sql("postgres", 'CREATE ROLE "' + role + '" LOGIN')
        self.addCleanup(self.sql, "postgres", 'DROP ROLE IF EXISTS "' + role + '"')
        source = (ROOT / "scripts/migration/pg/maintenance/slow_query_sampling.sql").read_text()
        result = subprocess.run(self.command + ["-X", "-q", "-v", "ON_ERROR_STOP=1",
            "-v", "app_role=" + role, "-v", "app_database=" + self.name,
            "-d", self.name], input=source, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(self.command + ["-X", "-q", "-A", "-t", "-U", role, "-d", self.name,
            "-c", "SELECT json_build_object('minimum',current_setting('log_min_duration_sample'),"
            "'rate',current_setting('log_statement_sample_rate'),'parameters',current_setting('log_parameter_max_length'),"
            "'error_parameters',current_setting('log_parameter_max_length_on_error'))"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        settings = json.loads(result.stdout)
        self.assertEqual(settings, {"minimum":"250ms", "rate":"0.1", "parameters":"0", "error_parameters":"0"})

"""Disposable PostgreSQL storage contracts; Rust route behavior is tested separately."""

import concurrent.futures
import os
from pathlib import Path
import shlex
import subprocess
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("ANNOUNCEMENT_OPERATION_TEST_PG") == "1",
                     "requires explicitly enabled disposable PostgreSQL")
class AnnouncementOperationStorage(unittest.TestCase):
    def sql(self, body, *, check=True):
        prefix = shlex.split(os.environ.get("PSQL_BIN", "psql"))
        result = subprocess.run([*prefix, "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
                                 "-d", "saudade_blog"], input=body, text=True,
                                capture_output=True, timeout=30)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def setUp(self):
        self.schema = "announcement_operation_test_" + uuid.uuid4().hex
        self.sql(f'CREATE SCHEMA "{self.schema}"')
        self.addCleanup(lambda: self.sql(f'DROP SCHEMA "{self.schema}" CASCADE'))
        migration = (ROOT / "scripts/migration/pg/0038_announcement_operations.sql").read_text()
        self.sql(f'SET search_path="{self.schema}"; CREATE TABLE "user"(id integer PRIMARY KEY);'
                 'INSERT INTO "user" VALUES(7); CREATE TABLE effect(id text);' + migration)
        self.sql(f'SET search_path="{self.schema}";' + migration)

    def write(self, *, fail=False):
        identifier, digest = "a" * 64, "b" * 64
        return self.sql(f'''
            BEGIN ISOLATION LEVEL SERIALIZABLE;
            SET LOCAL search_path="{self.schema}";
            WITH claimed AS (
                INSERT INTO announcement_operation(owner_id,operation_id,request_hash)
                VALUES(7,'{identifier}','{digest}') ON CONFLICT DO NOTHING
                RETURNING operation_id
            ) INSERT INTO effect SELECT operation_id FROM claimed;
            SELECT pg_sleep(0.05);
            {"SELECT 1/0;" if fail else ""}
            UPDATE announcement_operation SET outcome='{{"changed":true}}'::jsonb
                WHERE owner_id=7 AND operation_id='{identifier}';
            COMMIT;
        ''', check=False)

    def count(self, table):
        return int(self.sql(f'SET search_path="{self.schema}"; SELECT count(*) FROM {table}').stdout)

    def test_concurrent_delivery_and_lost_response_do_not_repeat_business_effect(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            attempts = list(pool.map(lambda _: self.write(), range(4)))
        self.assertTrue(any(row.returncode == 0 for row in attempts))
        self.assertEqual(self.count("effect"), 1)
        self.assertEqual(self.count("announcement_operation"), 1)
        # Retry after losing the response, then read the receipt from a fresh connection.
        self.assertEqual(self.write().returncode, 0)
        self.assertEqual(self.count("effect"), 1)
        stored = self.sql(f'SET search_path="{self.schema}"; '
                          "SELECT outcome->>'changed' FROM announcement_operation").stdout.strip()
        self.assertEqual(stored, "true")

    def test_business_failure_rolls_back_intent_and_allows_same_operation_to_retry(self):
        self.assertNotEqual(self.write(fail=True).returncode, 0)
        self.assertEqual(self.count("effect"), 0)
        self.assertEqual(self.count("announcement_operation"), 0)
        self.assertEqual(self.write().returncode, 0)
        self.assertEqual(self.count("effect"), 1)


if __name__ == "__main__":
    unittest.main()

"""Run with the installed SDK and PostgreSQL driver in the worker environment."""

import json
import tempfile
import unittest
from pathlib import Path

from lunima import Context, Runtime, Tool

from worker import TOOL, decide, select_topic, suggest


class SupportRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_private_evidence_and_recovery(self):
        topics = [
            {"id": "archive", "question": "怎样检索文章？", "keywords": ["归档", "文章"]},
            {"id": "ticket", "question": "工单在哪？", "keywords": ["工单", "回复"]},
        ]
        private = "private-user-detail-837"
        matched = (10, 42, "怎样检索文章？", private)
        ambiguous = (11, 42, "归档文章", "工单回复")
        unknown = (12, 73, "其他", private)
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "support.db"

            def open_runtime():
                return Runtime(sqlite=db, model=decide, tools={TOOL: Tool(select_topic)})

            ctx = Context("saudade-blog", "42", "case-10", "support")
            async with open_runtime() as runtime:
                self.assertEqual(await suggest(runtime, matched, topics), "archive")
                self.assertIsNone(await suggest(runtime, ambiguous, topics))
                self.assertIsNone(await suggest(runtime, unknown, topics))
                turns = (await runtime.history(ctx))["turns"]
                self.assertEqual(len(turns), 1)
                self.assertNotIn(private, json.dumps(turns, ensure_ascii=False))
            async with open_runtime() as runtime:
                self.assertEqual(await suggest(runtime, matched, topics), "archive")
                self.assertEqual((await runtime.history(ctx))["turns"], turns)
                other = Context("saudade-blog", "73", "case-10", "support")
                self.assertEqual((await runtime.history(other))["turns"], [])


if __name__ == "__main__":
    unittest.main()

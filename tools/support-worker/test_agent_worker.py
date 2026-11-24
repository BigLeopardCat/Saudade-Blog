import json
import unittest
from types import SimpleNamespace

from agent_worker import Support


class ArticleSupportTest(unittest.IsolatedAsyncioTestCase):
    async def test_paraphrased_help_and_article_are_handled_before_handoff(self):
        support = Support.__new__(Support)
        requests = []

        def lookup(path, *, data=None):
            requests.append((path, data))
            if path.endswith("/topics"):
                return [{
                    "id": "find-article",
                    "question": "怎样找到以前读过的文章？",
                    "answer": "在归档按时间浏览。",
                }]
            if path.endswith("/search"):
                return {"notes": [{"key": 28, "title": "设备存储指南"}],
                        "terms": ["休眠", "状态", "怎么", "断电"]}
            self.assertEqual(path, "/api/public/notes/28")
            return {"content": "设备休眠时保持原有状态，断电会清除缓存，恢复供电后需要重新初始化。"}

        support.lookup = lookup

        async def run(text):
            async def current_turn(_):
                return 0, [{"sender": "customer", "body": text}]

            support.current_turn = current_turn
            call = SimpleNamespace()
            return json.loads(await support.help(call))

        self.assertEqual((await run("我应该在哪里搜索文章？"))["text"], "喵，在归档按时间浏览。")
        result = await run("设备休眠的状态断电后怎么处理？")
        self.assertEqual(result["kind"], "search")
        answer = json.loads(await support.search(SimpleNamespace()))
        self.assertEqual(answer["kind"], "answer")
        self.assertIn("设备存储指南", answer["text"])
        self.assertIn("断电会清除缓存", answer["text"])
        self.assertEqual(requests[-2][1]["keyword"], "设备休眠的状态断电后怎么处理？")
        before = len(requests)
        self.assertEqual((await run("请帮我重置密码"))["kind"], "handoff")
        self.assertEqual(len(requests), before)

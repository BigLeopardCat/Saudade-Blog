"""Durable Lunima runtime for the blog's support conversations."""

import argparse
import asyncio
import json
import logging
import os
import re
import unicodedata
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

import psycopg
from lunima import Context, Decision, Grant, Reconciliation, Runtime, Tool

READ_FAQ = "support.read_public_help"
FIND_ARTICLE = "support.find_public_article"
HANDOFF = "喵，我已把这段对话转成工单。站点客服会在这里回复，你也可以继续补充。"
SENSITIVE = re.compile(
    r"密码|验证码|账号找回|找回账号|解封|权限|私钥|密钥|令牌|管理员|删除|封禁|退款|付款|支付|举报|"
    r"\b(?:password|verification code|api[ _-]?key|private key|token|admin|permission|delete|refund|payment|moderation)\b",
    re.I,
)
QUOTED = re.compile(r'[《「“"]([^》」”"\r\n]{2,60})[》」”"]')
GENERAL = {
    "find-article": "找文章或归档",
    "guestbook": "公开留言与私下反馈",
    "follow-ticket": "查看工单进度",
}
TOOL_TIMEOUT = 2.5


def normalized(raw):
    return "".join(c for c in unicodedata.normalize("NFKC", raw).casefold() if c.isalnum())


def reply(text, kind="answer"):
    return json.dumps({"text": text, "kind": kind}, ensure_ascii=False)


def human():
    return reply(HANDOFF, "handoff")


def reconcile_read(_call):
    return Reconciliation.safe_to_retry()


def decide(task):
    history = task["observations"]
    if history:
        result = json.loads(history[-1]["output"])
        if result["kind"] == "search":
            return Decision.act(FIND_ARTICLE, task["context"]["conversation"], task["goal"])
        return Decision.complete(history[-1]["output"])
    return Decision.act(READ_FAQ, task["context"]["conversation"], task["goal"])


class Support:
    def __init__(self):
        self.dsn = os.environ["SUPPORT_WORKER_DATABASE_URL"]
        self.site = os.environ.get("SUPPORT_BLOG_URL", "http://127.0.0.1:3000").rstrip("/")
        self.workers = int(os.environ.get("SUPPORT_WORKERS", "4"))
        if not 1 <= self.workers <= 16:
            raise ValueError("SUPPORT_WORKERS must be between 1 and 16")

    async def connect(self):
        return await psycopg.AsyncConnection.connect(self.dsn, autocommit=True, connect_timeout=4)

    def lookup(self, path, *, data=None):
        req = Request(self.site + path, data=json.dumps(data).encode() if data else None,
                      headers={"Accept": "application/json", "Content-Type": "application/json"})
        with build_opener(ProxyHandler({})).open(req, timeout=TOOL_TIMEOUT) as response:
            envelope = json.loads(response.read(128 * 1024))
        if envelope["code"] != 200:
            raise ValueError("blog lookup unavailable")
        return envelope["data"]

    async def current_turn(self, call):
        async with await self.connect() as db:
            result = await db.execute(
                "SELECT prior_answers,history FROM public.support_pending_turn "
                "WHERE case_id=%s AND event_id=%s AND owner_id=%s",
                (int(call.context.conversation), int(call.input), int(call.context.subject)),
            )
            return await result.fetchone()

    async def help(self, call):
        turn = await self.current_turn(call)
        if not turn:
            return human()
        previous, history = turn
        if previous >= 3 or any(
            SENSITIVE.search(message["body"]) for message in history if message["sender"] == "customer"
        ):
            return human()
        text = history[-1]["body"]
        if QUOTED.search(text) and ("文章" in text or re.search(r"\barticle\b", text, re.I)):
            return reply("", "search")
        try:
            topics = await asyncio.to_thread(self.lookup, "/api/public/support/topics")
            words = normalized(text)
            exact = [t for t in topics if normalized(t["question"]) == words]
            named = [t for t in topics if normalized(GENERAL.get(t["id"], "")) == words]
            matching = [t for t in topics if sum(normalized(w) in words for w in t["keywords"]) >= 2]
            hits = exact or named or matching
            if len(hits) == 1:
                return reply("喵，" + hits[0]["answer"])
            if previous == 0 and (len(hits) > 1 or len(words) < 9):
                options = [GENERAL[t["id"]] for t in (hits or topics) if t["id"] in GENERAL]
                return reply("喵，想确认一下，你问的是" + "、".join(options) + "，还是别的问题？", "clarify")
        except (OSError, ValueError, IndexError, KeyError, TypeError):
            logging.warning("public help unavailable")
        return human()

    async def search(self, call):
        turn = await self.current_turn(call)
        if not turn:
            return human()
        text = turn[1][-1]["body"]
        found = QUOTED.search(text)
        if not found or SENSITIVE.search(text):
            return human()
        try:
            data = await asyncio.to_thread(self.lookup, "/api/public/search",
                data={"keyword": found[1], "type": "note", "page": 1, "pageSize": 5})
            exact = [hit for hit in data["notes"] if normalized(hit["title"]) == normalized(found[1])]
            if len(exact) == 1:
                return reply("喵，找到公开文章《" + exact[0]["title"] + "》。可在博客顶部搜索这个标题查看。")
        except (OSError, ValueError, IndexError, KeyError, TypeError):
            logging.warning("public article search unavailable")
        return human()

    async def publish(self, db, runtime, row):
        case, owner, version, event = row
        ctx = Context("saudade-blog", str(owner), str(case), "lingyue-support")
        task = await runtime.submit(
            ctx, str(event), grants=[Grant(tool, str(case)) for tool in (READ_FAQ, FIND_ARTICLE)],
            command_id=f"turn-{event}",
        )
        final = await task.wait(timeout=45)
        answer = json.loads(final["artifact"] if final["state"] == "completed" else human())
        result = await db.execute(
            "SELECT public.support_publish_assistant(%s,%s,%s,%s,%s)",
            (case, event, version, answer["text"], answer["kind"] == "handoff"),
        )
        if (await result.fetchone())[0]:
            logging.info("case %s completed (%s)", case, answer["kind"])

    async def handle(self, db, runtime, row):
        try:
            await self.publish(db, runtime, row)
        except Exception as exc:
            logging.warning("case %s deferred (%s)", row[0], type(exc).__name__)
            return exc

    async def run(self, *, once=False):
        os.umask(0o077)
        state = Path(os.environ["SUPPORT_RUNTIME_DB"])
        state.parent.mkdir(exist_ok=True, parents=True)
        async with Runtime(sqlite=state, model=decide, workers=self.workers, tools={
            READ_FAQ: Tool(self.help, overlap_revisions=True, reconcile=reconcile_read),
            FIND_ARTICLE: Tool(self.search, overlap_revisions=True, reconcile=reconcile_read),
        }) as runtime:
            after = 0
            while True:
                try:
                    async with await self.connect() as db:
                        rows = await (await db.execute(
                            "SELECT case_id,owner_id,version,event_id FROM public.support_pending_turn "
                            "WHERE case_id>%s ORDER BY case_id LIMIT %s", (after, self.workers),
                        )).fetchall()
                        errors = await asyncio.gather(*(self.handle(db, runtime, row) for row in rows))
                    after = rows[-1][0] if len(rows) == self.workers else 0
                    if once:
                        for error in errors:
                            if error:
                                raise error
                        return
                except psycopg.Error as exc:
                    if once:
                        raise
                    logging.warning("support queue unavailable (%s)", type(exc).__name__)
                    after = 0
                if not after:
                    await asyncio.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process one batch and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(Support().run(once=args.once))

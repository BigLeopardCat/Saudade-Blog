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
HANDOFF = "喵，我已把这段对话交给站点客服。客服会在这里回复，你也可以继续补充。"
SENSITIVE = re.compile(
    r"(?:找回|重置|修改|忘记).{0,6}(?:密码|账号)|账号找回|密码忘了|验证码|"
    r"(?:发送|提供|透露|泄露).{0,6}(?:密码|密钥|私钥|令牌)|"
    r"(?:帮我|请你|替我).{0,6}(?:删除|修改|解封|封禁|退款|付款|举报)|"
    r"(?:授予|开通|提升|撤销).{0,6}(?:权限|管理员)|"
    r"\b(?:(?:reset|forgot|change)(?: my)? password|verification code|"
    r"(?:send|reveal|leak)(?: my| the)? (?:api[ _-]?key|private key|token)|"
    r"(?:grant|revoke|escalate)(?: my| the)? (?:permissions?|admin)|refund my)\b",
    re.I,
)
QUOTED = re.compile(r'[《「“"]([^》」”"\r\n]{2,60})[》」”"]')
MARKDOWN_LINK = re.compile(r"!?\[([^\]\n]*)\]\([^\n)]*\)")
COMMON_TERMS = frozenset(
    "文章 博客 请问 帮忙 解释 介绍 有没有 是否 如何 为什么 怎么 什么 哪些 哪里 "
    "可以 能够 需要 使用 通过 这个 那个 里面 其中 具体 作用 问题 内容 方法 一下 "
    "article blog please which what where how why about from with this that".split()
)
GENERAL = {
    "find-article": "找文章或归档",
    "guestbook": "公开留言与私下反馈",
    "follow-ticket": "查看工单进度",
}
HELP_INTENTS = {
    "find-article": re.compile(r"(?:怎么|怎样|如何|在哪).{0,6}(?:找文章|查文章|搜索文章|看归档)|归档在哪"),
    "guestbook": re.compile(r"留言.{0,8}(?:公开|私密|所有人|别人.{0,3}看到)"),
    "follow-ticket": re.compile(r"(?:哪里|在哪|怎么|怎样|如何).{0,6}(?:看工单|查工单|看回复)|工单.{0,2}(?:进度|在哪看)"),
}
ASK_FOR_STAFF = re.compile(r"转(?:接)?人工|(?:找|联系|需要|请)[一下]?人[工员]客服|\b(?:human agent|talk to staff)\b", re.I)
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
        text = history[-1]["body"]
        if SENSITIVE.search(text) or ASK_FOR_STAFF.search(text):
            return human()
        words = normalized(text)
        try:
            topics = await asyncio.to_thread(self.lookup, "/api/public/support/topics")
            hits = [t for t in topics if words and (
                words in {normalized(t["question"]), normalized(GENERAL.get(t["id"], ""))}
                or (not QUOTED.search(text) and t["id"] in HELP_INTENTS and HELP_INTENTS[t["id"]].search(text))
            )]
            if len(hits) == 1:
                return reply("喵，" + hits[0]["answer"])
        except (OSError, ValueError, IndexError, KeyError, TypeError):
            logging.warning("public help unavailable")
        if len(words) < 4 and previous == 0:
            return reply("喵，可以补充一下你想找的文章、遇到问题的页面或具体表现吗？", "clarify")
        return reply("", "search") if words else human()

    async def search(self, call):
        turn = await self.current_turn(call)
        if not turn:
            return human()
        text = turn[1][-1]["body"]
        found = QUOTED.search(text)
        if SENSITIVE.search(text):
            return human()
        try:
            data = await asyncio.to_thread(self.lookup, "/api/public/search",
                data={"keyword": found[1] if found else text.strip()[:128],
                      "type": "note", "page": 1, "pageSize": 4})
            exact = [hit for hit in data["notes"]
                     if normalized(hit["title"]) == normalized(found[1] if found else text)]
            if len(exact) == 1:
                return reply("喵，找到公开文章《" + exact[0]["title"] + "》。可在博客顶部搜索这个标题查看。")
            terms = {word for term in data["terms"] if len(word := normalized(term)) > 1
                     and word not in COMMON_TERMS}
            if len(terms) >= 2:
                evidence = []
                for hit in data["notes"][:4]:
                    article = await asyncio.to_thread(self.lookup, f"/api/public/notes/{int(hit['key'])}")
                    for paragraph in article["content"].splitlines():
                        passage = MARKDOWN_LINK.sub(r"\1", paragraph).strip(" #>*-")
                        if not 28 <= len(passage) <= 500 or passage.startswith(("|", "```", "<")):
                            continue
                        folded = normalized(passage)
                        matches = {term for term in terms if term in folded}
                        evidence.append((len(matches), max(map(len, matches), default=0), hit["title"], passage))
                if evidence:
                    score, _, title, passage = max(evidence, key=lambda item: item[:2])
                    if score >= max(2, (len(terms) + 1) // 2):
                        return reply(f"喵，公开文章《{title}》里有一段相关说明：\n\n{passage}\n\n可在博客顶部搜索文章标题查看原文。")
        except (OSError, ValueError, IndexError, KeyError, TypeError):
            logging.warning("public article search unavailable")
        if turn[0] == 0 and len(normalized(text)) < 12:
            return reply("喵，能再说说你想确认的具体问题吗？有文章标题或页面名称也可以一起发来。", "clarify")
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

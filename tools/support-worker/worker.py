"""Match a blog's new private consultations to its public help topics using Lunima."""

import argparse
import asyncio
import json
import logging
import os
import re
import unicodedata
from pathlib import Path
from urllib.request import urlopen

import psycopg
from lunima import Context, Decision, Grant, Runtime, Tool

TOOL = "support.select_topic"
RESOURCE = "public-faq"
HANDOFF = "human"
BATCH = 12


def normalized(value):
    text = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in text if char.isalnum())


def public_evidence(subject, body, topics):
    # Only catalog IDs and match counts may enter durable agent history.
    text = [normalized(subject), normalized(body)]
    evidence = []
    for topic in topics:
        exact = normalized(topic["question"]) in text
        hits = sum(any(normalized(word) in part for part in text) for word in topic["keywords"])
        if exact or hits:
            evidence.append([topic["id"], exact, hits])
    return json.dumps(evidence, separators=(",", ":"))


def select_topic(call):
    rows = json.loads(call.input)
    exact = [slug for slug, matched, _ in rows if matched]
    candidates = exact or [slug for slug, _, hits in rows if hits >= 2]
    return candidates[0] if len(candidates) == 1 else HANDOFF


def decide(task):
    if task["observations"]:
        return Decision.complete(task["observations"][-1]["output"])
    return Decision.act(TOOL, RESOURCE, task["goal"])


def read_topics(base):
    with urlopen(base.rstrip("/") + "/api/public/support/topics", timeout=5) as response:
        envelope = json.load(response)
    topics = envelope["data"]
    if envelope.get("code") != 200 or not isinstance(topics, list) or not topics:
        raise ValueError("invalid help catalog")
    for item in topics:
        if (not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", item["id"]) or item["id"] == HANDOFF
                or not normalized(item["question"]) or not item["keywords"]
                or not all(normalized(word) for word in item["keywords"])):
            raise ValueError("invalid help topic")
    return topics


async def suggest(runtime, row, topics):
    case_id, owner, subject, body = row
    ctx = Context("saudade-blog", str(owner), f"case-{case_id}", "support")
    history = await runtime.history(ctx, limit=1)
    if history["turns"]:
        task = runtime.task(ctx, history["turns"][0]["id"])
    else:
        task = await runtime.submit(
            ctx, public_evidence(subject, body, topics),
            grants=[Grant(TOOL, RESOURCE)], command_id=f"first-question-{case_id}",
        )
    result = await task.wait(timeout=15)
    if result["state"] != "completed":
        raise RuntimeError("support selection did not complete")
    answer = result["artifact"]
    if answer == HANDOFF or answer not in {t["id"] for t in topics}:
        return None
    return answer


async def process_batch(runtime, dsn, base, after, *, strict=False):
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True, connect_timeout=5) as db:
        result = await db.execute(
            "SELECT case_id,owner_id,subject,body FROM public.support_assistant_queue "
            "WHERE case_id > %s ORDER BY case_id LIMIT %s", (after, BATCH),
        )
        rows = await result.fetchall()
        if not rows:
            return 0
        topics = await asyncio.to_thread(read_topics, base)

        async def process(row):
            topic = await suggest(runtime, row, topics)
            # Idempotent projection after the durable SDK receipt. PostgreSQL rechecks
            # eligibility under the same lock as human replies before recording it.
            await db.execute("SELECT public.support_record_guidance(%s,%s)", (row[0], topic))

        results = await asyncio.gather(*(process(row) for row in rows), return_exceptions=True)
        for row, outcome in zip(rows, results):
            if isinstance(outcome, BaseException):
                logging.error("case %s deferred (%s)", row[0], type(outcome).__name__)
        if any(isinstance(outcome, BaseException) for outcome in results):
            if strict:
                raise RuntimeError("one or more consultations could not be processed")
            # Advance the scan even when one case needs attention. It remains in the queue.
            return rows[-1][0]
        return rows[-1][0] if len(rows) == BATCH else 0


async def serve(once):
    os.umask(0o077)
    database = Path(os.environ["SUPPORT_RUNTIME_DB"])
    database.parent.mkdir(parents=True, exist_ok=True)
    dsn = os.environ["SUPPORT_WORKER_DATABASE_URL"]
    base = os.environ.get("SUPPORT_BLOG_URL", "http://127.0.0.1:3000")
    async with Runtime(sqlite=database, model=decide, workers=4,
                       tools={TOOL: Tool(select_topic, overlap_revisions=True)}) as runtime:
        after = 0
        while True:
            try:
                after = await process_batch(runtime, dsn, base, after, strict=once)
            except (OSError, ValueError, KeyError, psycopg.Error) as exc:
                if once:
                    raise
                logging.warning("support queue deferred (%s)", type(exc).__name__)
                after = 0
            if once:
                return
            if not after:
                await asyncio.sleep(5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process one batch and exit")
    asyncio.run(serve(parser.parse_args().once))

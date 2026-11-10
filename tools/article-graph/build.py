"""Build blog visualization artifacts from a read-only published pgvector corpus."""

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import jieba
import numpy as np
import psycopg
from psycopg.rows import dict_row
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer
from threadpoolctl import threadpool_limits


def read_vectors(dsn, collection):
    with psycopg.connect(
        dsn, row_factory=dict_row, options="-c default_transaction_read_only=on"
    ) as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        snapshot = db.execute(
            "SELECT fingerprint,space,dimension,count FROM rag.snapshots "
            "WHERE collection=%s",
            (collection,),
        ).fetchone()
        if not snapshot or not 0 < snapshot["count"] <= 50000:
            raise ValueError("A nonempty bounded published vector snapshot is required")
        if snapshot["count"] * snapshot["dimension"] > 5_000_000:
            raise ValueError("Source vectors exceed the optional builder memory budget")
        rows = db.execute(
            "SELECT m.document_type,m.document_id,e.embedding::text AS embedding "
            "FROM rag.members m JOIN rag.embeddings e USING(collection,key,dimension) "
            "WHERE m.collection=%s AND m.dimension=%s ORDER BY m.ordinal",
            (collection, snapshot["dimension"]),
        ).fetchall()
        if len(rows) != snapshot["count"]:
            raise ValueError("Published vector membership is incomplete")
    grouped = defaultdict(list)
    for row in rows:
        if row["document_type"] != "note":
            continue
        vector = np.asarray(json.loads(row["embedding"]), dtype=np.float64)
        if vector.shape != (snapshot["dimension"],) or not np.isfinite(vector).all():
            raise ValueError("Invalid source vector")
        grouped[int(row["document_id"])].append(vector)
    return snapshot, {
        ident: np.mean(values, axis=0) for ident, values in grouped.items()
    }


def read_articles(dsn, ids):
    if not ids or len(ids) > 2000:
        raise ValueError("The visualization requires 1..2000 source articles")
    with psycopg.connect(
        dsn, row_factory=dict_row, options="-c default_transaction_read_only=on"
    ) as db:
        return db.execute(
            "SELECT n.id,n.title,left(n.content,20000) AS content,n.description,"
            "c.name AS category, "
            """to_char(n.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS revision, """
            "(SELECT coalesce(sum(cnt),0) FROM note_view WHERE note_id=n.id) AS views, "
            "(SELECT count(*) FROM note_like WHERE note_id=n.id) AS likes, "
            "(SELECT count(*) FROM user_favorite WHERE note_id=n.id) AS favorites, "
            "(SELECT count(*) FROM note_comment WHERE note_id=n.id "
            "AND approved=1 AND is_deleted=0) AS comments "
            "FROM note n LEFT JOIN category c ON c.id=n.category_id "
            "WHERE n.id=ANY(%s) AND n.is_public=true "
            "AND n.status IN ('public','published') "
            "AND n.draft_of IS NULL ORDER BY n.id",
            (sorted(ids),),
        ).fetchall()


def terms(text):
    tokens = Counter()
    for value in jieba.cut_for_search(text):
        value = value.strip().casefold()
        if (
            2 <= len(value) <= 50
            and re.fullmatch(r"[\w.+#-]+", value)
            and not value.isdecimal()
            and value not in ENGLISH_STOP_WORDS
        ):
            tokens[value] += 1
    return tokens


def derive(articles, vectors, maximum):
    texts = [
        f"{row['title']} {row.get('description') or ''} {row['content']}"
        for row in articles
    ]
    tokenizer = TfidfVectorizer(
        tokenizer=lambda text: list(terms(text).elements()),
        token_pattern=None,
        lowercase=False,
    )
    weights = tokenizer.fit_transform(texts)
    vocabulary = tokenizer.get_feature_names_out()
    candidates = defaultdict(list)
    for row, features in zip(articles, weights, strict=True):
        ranked = sorted(
            zip(features.indices, features.data, strict=True),
            key=lambda item: (-item[1], vocabulary[item[0]]),
        )
        for index, weight in ranked[: max(8, maximum // max(1, len(articles)))]:
            candidates[str(vocabulary[index])].append((row["id"], float(weight)))
    selected = sorted(
        candidates, key=lambda word: (-sum(v for _, v in candidates[word]), word)
    )[:maximum]
    if len(selected) < 4:
        raise ValueError(
            "At least four terms are required for a three-dimensional graph"
        )
    associations = [
        sorted(candidates[word], key=lambda item: (-item[1], item[0]))
        for word in selected
    ]
    matrix = np.asarray(
        [
            np.mean([vectors[ident] for ident, _ in rows], axis=0)
            for rows in associations
        ]
    )
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix /= np.maximum(norms, 1e-12)
    pca = PCA(n_components=3, svd_solver="full")
    positions = pca.fit_transform(matrix)
    if (
        not np.isfinite(positions).all()
        or not np.isfinite(pca.explained_variance_ratio_).all()
    ):
        raise ValueError("Source vectors have no usable geometric variation")
    jitter = np.asarray(
        [
            [
                int(hashlib.sha256(word.encode()).hexdigest()[i : i + 4], 16) / 65535
                - 0.5
                for i in (0, 4, 8)
            ]
            for word in selected
        ]
    )
    positions += jitter * max(float(np.std(positions)), 1e-3) * 0.08
    scale = max(float(np.max(np.abs(positions))), 1e-12)
    positions *= 1.5 / scale
    similarities = np.clip(matrix @ matrix.T, -1, 1)
    edges = {}
    for i in range(len(selected)):
        order = np.argsort(-similarities[i], kind="stable")
        for j in order:
            if i != j and similarities[i, j] > 0:
                edges[tuple(sorted((i, int(j))))] = float(similarities[i, j])
                break
    indices = {row["id"]: i for i, row in enumerate(articles)}
    weights = [sum(weight for _, weight in rows) for rows in associations]
    top = max(weights)
    nodes, private = [], []
    for i, (word, rows) in enumerate(zip(selected, associations, strict=True)):
        ids = [ident for ident, _ in rows[:2]]
        nodes.append(
            dict(
                i=i,
                w=word,
                x=float(positions[i, 0]),
                y=float(positions[i, 1]),
                z=float(positions[i, 2]),
                n=weights[i] / top,
                a=indices[ids[0]],
                a2=indices[ids[-1]],
            )
        )
        private.append({"word": word, "articles": ids})
    return (
        nodes,
        [[a, b, score] for (a, b), score in sorted(edges.items())],
        private,
        pca.explained_variance_ratio_,
    )


def query_contract(path, snapshot):
    """Verify an exported model contract against the active publication."""
    if not path or not path.is_file() or path.stat().st_size > 16384:
        raise ValueError("A verified embedding query contract is required")
    contract = json.loads(path.read_text())
    payload = contract.get("signature_payload", "")
    if (
        contract.get("schema_version") != 1
        or contract.get("tokenization_protocol") != "llama.cpp-tokenize-v1"
        or hashlib.sha256(payload.encode()).hexdigest() != snapshot["space"]["profile"]
    ):
        raise ValueError(
            "Embedding query contract does not match the vector publication"
        )
    identity = json.loads(payload)
    digest = identity.get("tokenizer_sha256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid tokenizer identity")
    tokenizer = path.parent / f"tokenizer-{digest}.json"
    if not tokenizer.is_file() or tokenizer.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Missing bounded query tokenizer")
    data = tokenizer.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Query tokenizer SHA-256 mismatch")
    return contract, data


def build(snapshot, articles, vectors, collection, maximum, contract=None):
    if not articles:
        raise ValueError(
            "No currently public article intersects the published vector snapshot"
        )
    profile = snapshot.get("space", {}).get("profile", "")
    if profile and (
        not contract
        or hashlib.sha256(contract.get("signature_payload", "").encode()).hexdigest()
        != profile
    ):
        raise ValueError("The vector publication requires its verified query contract")
    nodes, edges, words, variance = derive(articles, vectors, maximum)
    metrics = (("views", 1), ("likes", 3), ("favorites", 3), ("comments", 4))
    heat = {
        row["id"]: sum(
            weight * math.log1p(max(int(row.get(name, 0)), 0))
            for name, weight in metrics
        )
        for row in articles
    }
    maximum_heat = max(heat.values(), default=0)
    heat = {
        ident: (value / maximum_heat if maximum_heat else 0.0)
        for ident, value in heat.items()
    }
    for node, word in zip(nodes, words, strict=True):
        node["h"] = max(heat[ident] for ident in word["articles"])
    graph = {
        "model": "document-centroids",
        "dim": snapshot["dimension"],
        "built": datetime.now(timezone.utc).isoformat(),
        "articles": [
            {
                "id": row["id"],
                "t": row["title"],
                "c": row.get("category") or "",
                "g": [],
                "hv": heat[row["id"]],
            }
            for row in articles
        ],
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "layout": "pca",
            "n_nodes": len(nodes),
            "var3_sum": float(np.sum(variance)),
            "source": "published_document_vectors",
        },
    }
    source = {
        "collection": collection,
        "fingerprint": snapshot["fingerprint"],
        "dimension": snapshot["dimension"],
        "article_ids": [row["id"] for row in articles],
        "article_versions": {str(row["id"]): row["revision"] for row in articles},
        "words": words,
        "embedding_profile": contract,
    }
    identity = json.dumps(
        {"graph": graph, "source": source}, sort_keys=True, ensure_ascii=False
    ).encode()
    version = hashlib.sha256(identity).hexdigest()[:24]
    graph["v"], source["version"] = version, version
    return graph, source


def atomic_file(path, content, *, private=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
            os.chmod(temp, 0o640 if private else 0o644)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def publish(root, graph, source, site, query_tokenizer=None):
    root.mkdir(parents=True, exist_ok=True)
    if source.get("embedding_profile"):
        identity = json.loads(source["embedding_profile"]["signature_payload"])
        digest = identity["tokenizer_sha256"]
        if (
            query_tokenizer is None
            or hashlib.sha256(query_tokenizer).hexdigest() != digest
        ):
            raise ValueError("Matching query tokenizer is required for publication")
        atomic_file(root / f"tokenizer-{digest}.json", query_tokenizer, private=True)
    name = f"graph-{graph['v']}.js"
    body = (
        "export default "
        + json.dumps(graph, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    ).encode()
    atomic_file(root / name, body)
    atomic_file(
        root / f"source-{graph['v']}.json",
        json.dumps(source, ensure_ascii=False).encode(),
        private=True,
    )
    manifest = {"v": graph["v"], "file": name, "bytes": len(body), "site": site}
    atomic_file(root / "manifest.json", json.dumps(manifest).encode())
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(os.getenv("GRAPH_ARTIFACT_DIR", "data/article-graph")),
    )
    parser.add_argument("--site", default=os.getenv("SITE_URL", ""))
    parser.add_argument(
        "--collection", default=os.getenv("GRAPH_VECTOR_COLLECTION", "blog-public")
    )
    parser.add_argument("--max-nodes", type=int, default=400)
    parser.add_argument(
        "--embedding-contract", type=Path, default=os.getenv("GRAPH_EMBEDDING_CONTRACT")
    )
    args = parser.parse_args(argv)
    if not 4 <= args.max_nodes <= 600 or not args.site.startswith(
        ("https://", "http://")
    ):
        parser.error("Use 4..600 nodes and an explicit HTTP(S) site origin")
    dsn, blog = os.getenv("GRAPH_VECTOR_DSN", ""), os.getenv("DATABASE_URL", "")
    if not dsn or not blog:
        parser.error("GRAPH_VECTOR_DSN and DATABASE_URL are required for this command")
    snapshot, vectors = read_vectors(dsn, args.collection)
    articles = read_articles(blog, vectors)
    contract, tokenizer = (
        query_contract(args.embedding_contract, snapshot)
        if snapshot.get("space", {}).get("profile")
        else (None, None)
    )
    with threadpool_limits(limits=1):
        graph, source = build(
            snapshot, articles, vectors, args.collection, args.max_nodes, contract
        )
    print(
        json.dumps(
            publish(args.out, graph, source, args.site, tokenizer), ensure_ascii=False
        )
    )


if __name__ == "__main__":
    main()

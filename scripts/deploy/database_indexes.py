#!/usr/bin/env python3
"""Export a fresh CI database's index contract; check it without production writes."""
import argparse
import json
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path

MAX_CONTRACT_BYTES = 256 * 1024
CONTRACT_MEMBER = "database-indexes.json"
CATALOG_SQL = """
SELECT json_build_object(
 'postgres_major', current_setting('server_version_num')::integer / 10000,
 'tables', (SELECT coalesce(json_agg(relname ORDER BY relname), '[]'::json)
            FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'),
 'indexes', (SELECT coalesce(json_agg(x ORDER BY x.name), '[]'::json) FROM (
   SELECT ci.relname name, t.relname table_name, pg_get_indexdef(i.indexrelid) definition,
          i.indisunique is_unique, i.indisprimary is_primary,
          i.indisvalid valid, i.indisready ready, i.indislive live
   FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid
   JOIN pg_class t ON t.oid=i.indrelid WHERE t.relnamespace='public'::regnamespace
 ) x),
 'unvalidated_constraints', (SELECT coalesce(json_agg(conname ORDER BY conname), '[]'::json)
   FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated)
);
"""


def connection_options(database=None, psql=None):
    command = psql or os.environ.get("PSQL_BIN")
    database = database or os.environ.get("PGDATABASE")
    explicit = os.environ.get("SAUDADE_DATABASE_CHECK_CONFIG")
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    path = Path(explicit) if explicit else base / "saudade/database-check.json"
    config = {}
    if explicit or (command is None and path.exists()):
        if not path.is_absolute() or path.is_symlink():
            raise ValueError("database check configuration must be a private regular file")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid() or info.st_size > 4096:
            raise ValueError("database check configuration must be owner-only and owned by the current user")
        try:
            config = json.loads(path.read_bytes())
        except (ValueError, UnicodeError) as error:
            raise ValueError("invalid database check configuration") from error
        if not isinstance(config, dict) or set(config) - {"database", "psql"}:
            raise ValueError("database check configuration supports only database and psql")
    database = database or config.get("database", "saudade_blog")
    if not identifier(database):
        raise ValueError("database must be a database name; use libpq environment/service for credentials")
    command = command or config.get("psql", "psql")
    if isinstance(command, str):
        command = shlex.split(command)
    if not isinstance(command, list) or not command or not all(isinstance(s, str) and s for s in command):
        raise ValueError("PSQL_BIN must name a command")
    return database, command


def read_catalog(database=None, psql=None):
    database, command = connection_options(database, psql)
    env = dict(os.environ)
    env["PGOPTIONS"] = (env.get("PGOPTIONS", "") +
        " -c default_transaction_read_only=on -c statement_timeout=5000"
        " -c lock_timeout=1000 -c application_name=saudade-index-check").strip()
    try:
        result = subprocess.run(command + ["-X", "-q", "-A", "-t", "--no-password", "-v", "ON_ERROR_STOP=1",
            "-d", database, "-c", "BEGIN READ ONLY; SET LOCAL statement_timeout=5000; "
            "SET LOCAL lock_timeout=1000; " + CATALOG_SQL + "COMMIT;"], env=env, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("database catalog unavailable") from error
    if result.returncode:
        # libpq/psql errors must not echo a supplied connection string into deployment logs.
        raise ValueError("database catalog unavailable (psql failed)")
    try:
        return validate_catalog(json.loads(result.stdout))
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError("invalid database catalog response") from error


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", value) is not None


def validate_catalog(value):
    if not isinstance(value, dict) or type(value.get("postgres_major")) is not int or not 10 <= value["postgres_major"] < 100:
        raise ValueError("invalid PostgreSQL version")
    tables, indexes = value.get("tables"), value.get("indexes")
    if not isinstance(tables, list) or not tables or not all(identifier(t) for t in tables):
        raise ValueError("invalid table catalog")
    if len(tables) != len(set(tables)) or not isinstance(indexes, list) or not indexes:
        raise ValueError("invalid index catalog")
    names = set()
    for item in indexes:
        if not isinstance(item, dict) or not identifier(item.get("name")) or item["name"] in names:
            raise ValueError("invalid or duplicate index name")
        names.add(item["name"])
        if item.get("table_name") not in tables or not isinstance(item.get("definition"), str):
            raise ValueError("invalid index definition")
        if not item["definition"].startswith("CREATE ") or len(item["definition"]) > 16000:
            raise ValueError("invalid index definition")
        if any(type(item.get(k)) is not bool for k in ("is_unique", "is_primary", "valid", "ready", "live")):
            raise ValueError("invalid index flags")
    invalid = value.get("unvalidated_constraints")
    if not isinstance(invalid, list) or not all(identifier(n) for n in invalid):
        raise ValueError("invalid constraint catalog")
    return value


def healthy(catalog):
    errors = ["unusable index: " + i["name"] for i in catalog["indexes"]
              if not (i["valid"] and i["ready"] and i["live"])]
    errors += ["unvalidated constraint: " + name for name in catalog["unvalidated_constraints"]]
    return errors


def make_contract(catalog, source_commit):
    validate_catalog(catalog)
    if not isinstance(source_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("contract requires a full source commit")
    errors = healthy(catalog)
    if errors:
        raise ValueError("cannot export an unhealthy schema: " + "; ".join(errors))
    return {"format": 1, "source_commit": source_commit, "postgres_major": catalog["postgres_major"],
            "tables": sorted(catalog["tables"]),
            "indexes": sorted(catalog["indexes"], key=lambda i: i["name"]),
            "unvalidated_constraints": []}


def load_contract(raw, expected_commit=None):
    if len(raw) > MAX_CONTRACT_BYTES:
        raise ValueError("database index contract exceeds size limit")
    try:
        value = json.loads(raw)
        validate_catalog(value)
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError("invalid database index contract") from error
    if (type(value.get("format")) is not int or value["format"] != 1
        or not isinstance(value.get("source_commit"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", value["source_commit"])):
        raise ValueError("invalid database index contract version or commit")
    if expected_commit is not None and value["source_commit"] != expected_commit:
        raise ValueError("database index contract belongs to another release")
    if healthy(value):
        raise ValueError("database index contract contains an unhealthy schema")
    return value


def compare(contract, actual):
    validate_catalog(actual)
    errors = healthy(actual)
    if contract["postgres_major"] != actual["postgres_major"]:
        errors.append("PostgreSQL major version differs from CI contract")
    errors += ["missing table: " + t for t in contract["tables"] if t not in actual["tables"]]
    found = {i["name"]: i for i in actual["indexes"]}
    for expected in contract["indexes"]:
        name = expected["name"]
        if name not in found:
            errors.append("missing index: " + name)
        elif any(found[name][key] != expected[key] for key in
                 ("table_name", "definition", "is_unique", "is_primary")):
            errors.append("index definition differs: " + name)
    # Optional services and rollback-compatible extra indexes do not invalidate the contract.
    return errors


def check_contract(contract, database=None, psql=None):
    errors = compare(contract, read_catalog(database, psql))
    if errors:
        raise ValueError("database index check failed: " + "; ".join(errors))


def check_archive(archive, expected_commit, database=None, psql=None):
    members = [m for m in archive.getmembers() if m.name == CONTRACT_MEMBER]
    if len(members) != 1 or not members[0].isfile() or members[0].size > MAX_CONTRACT_BYTES:
        raise ValueError("release requires one regular database index contract")
    with archive.extractfile(members[0]) as stream:
        contract = load_contract(stream.read(MAX_CONTRACT_BYTES + 1), expected_commit)
    check_contract(contract, database, psql)


def extract_checked_archive(archive, expected_commit, destination=".", database=None, psql=None):
    check_archive(archive, expected_commit, database, psql)
    archive.extractall(destination, filter="data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["export", "check"])
    parser.add_argument("--database", default=None)
    parser.add_argument("--psql", default=None)
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--source-commit")
    args = parser.parse_args()
    try:
        if args.command == "export":
            if args.output is None or args.source_commit is None:
                raise ValueError("export requires --output and --source-commit")
            contract = make_contract(read_catalog(args.database, args.psql), args.source_commit)
            encoded = (json.dumps(contract, sort_keys=True, indent=2) + "\n").encode()
            load_contract(encoded, args.source_commit)
            args.output.write_bytes(encoded)
            print(f"Exported {len(contract['indexes'])} index definitions from the isolated CI schema")
        else:
            if args.contract is None:
                raise ValueError("check requires --contract")
            if args.contract.stat().st_size > MAX_CONTRACT_BYTES:
                raise ValueError("database index contract exceeds size limit")
            contract = load_contract(args.contract.read_bytes(), args.source_commit)
            check_contract(contract, args.database, args.psql)
            print(f"Database index contract passed: {len(contract['indexes'])} required indexes")
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()

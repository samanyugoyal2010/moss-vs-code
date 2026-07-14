#!/usr/bin/env python3
"""Ingest system design rubrics into a local Moss index.

Supports a JSON file of documents or a directory of markdown files.
Creates/loads the ``system-design-rubric`` index and runs a sample query
to verify sub-10ms retrieval.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from moss import DocumentInfo, MossClient, QueryOptions

INDEX_NAME = "system-design-rubric"
DEFAULT_SOURCE = Path(__file__).resolve().parent / "knowledge" / "system_design_rubrics.json"
DEFAULT_MODEL = "moss-minilm"


def _require_credentials() -> tuple[str, str]:
    project_id = os.getenv("MOSS_PROJECT_ID", "").strip()
    project_key = os.getenv("MOSS_PROJECT_KEY", "").strip()
    if not project_id or not project_key:
        print(
            "Missing MOSS_PROJECT_ID or MOSS_PROJECT_KEY. "
            "Copy backend/.env.example to backend/.env and fill in Moss credentials.",
            file=sys.stderr,
        )
        sys.exit(1)
    return project_id, project_key


def _documents_from_json(path: Path) -> list[DocumentInfo]:
    raw: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"JSON source must be a list of documents: {path}")

    documents: list[DocumentInfo] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"Document at index {i} must be an object")
        doc_id = str(item.get("id") or f"doc-{i}")
        title = str(item.get("title") or "").strip()
        text = str(item.get("text") or "").strip()
        if not text:
            raise ValueError(f"Document {doc_id} has empty text")
        body = f"{title}\n\n{text}".strip() if title else text
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        if title and "topic" not in metadata:
            metadata = {**metadata, "topic": title}
        documents.append(DocumentInfo(id=doc_id, text=body, metadata=metadata))
    return documents


def _documents_from_markdown_dir(path: Path) -> list[DocumentInfo]:
    md_files = sorted(path.glob("*.md"))
    if not md_files:
        raise ValueError(f"No .md files found in {path}")

    documents: list[DocumentInfo] = []
    for md_path in md_files:
        text = md_path.read_text(encoding="utf-8").strip()
        if not text:
            continue
        documents.append(
            DocumentInfo(
                id=md_path.stem,
                text=text,
                metadata={"topic": md_path.stem, "source": md_path.name},
            )
        )
    if not documents:
        raise ValueError(f"All markdown files in {path} were empty")
    return documents


def load_documents(source: Path) -> list[DocumentInfo]:
    if not source.exists():
        raise FileNotFoundError(f"Source not found: {source}")
    if source.is_dir():
        return _documents_from_markdown_dir(source)
    if source.suffix.lower() == ".json":
        return _documents_from_json(source)
    raise ValueError(f"Unsupported source (use .json or a directory of .md): {source}")


async def _delete_index_if_exists(client: MossClient, index_name: str) -> None:
    delete = getattr(client, "delete_index", None)
    if callable(delete):
        try:
            await delete(index_name)
            print(f"Deleted existing index '{index_name}'.")
        except Exception as exc:  # noqa: BLE001 — best-effort recreate
            print(f"Note: could not delete existing index ({exc}); create may fail if it exists.")


async def ingest(source: Path, *, recreate: bool) -> None:
    project_id, project_key = _require_credentials()
    documents = load_documents(source)
    print(f"Loaded {len(documents)} document(s) from {source}")

    client = MossClient(project_id, project_key)

    if recreate:
        await _delete_index_if_exists(client, INDEX_NAME)

    try:
        await client.create_index(INDEX_NAME, documents, DEFAULT_MODEL)
        print(f"Created index '{INDEX_NAME}' with model '{DEFAULT_MODEL}'.")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "exist" in msg or "already" in msg:
            print(
                f"Index '{INDEX_NAME}' already exists. "
                "Re-run with --recreate to delete and rebuild, or load as-is.",
                file=sys.stderr,
            )
            if recreate:
                raise
        else:
            raise

    await client.load_index(INDEX_NAME)
    print(f"Loaded index '{INDEX_NAME}' into the local Moss runtime.")

    sample_query = "How would you design rate limiting for a public API?"
    results = await client.query(
        INDEX_NAME,
        sample_query,
        QueryOptions(top_k=1, alpha=0.6),
    )
    elapsed = getattr(results, "time_taken_ms", None)
    elapsed_str = f"{elapsed:.2f} ms" if isinstance(elapsed, (int, float)) else "n/a"
    print(f"\nSample query: {sample_query}")
    print(f"Retrieval latency: {elapsed_str}")
    if results.docs:
        top = results.docs[0]
        preview = (top.text[:160] + "…") if len(top.text) > 160 else top.text
        print(f"Top hit [{top.id}] score={top.score:.3f}: {preview}")
    else:
        print("No documents returned.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest system design guidelines into the Moss system-design-rubric index.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"JSON file or markdown directory (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--recreate",
        action="store_true",
        help="Delete the index if it exists, then create it fresh.",
    )
    return parser.parse_args(argv)


def main() -> None:
    load_dotenv()
    args = parse_args()
    try:
        asyncio.run(ingest(args.source.resolve(), recreate=args.recreate))
    except Exception as exc:  # noqa: BLE001
        print(f"Ingest failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

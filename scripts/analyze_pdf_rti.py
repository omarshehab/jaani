from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF


LABEL_SPLIT_RE = re.compile(r"\s*[:：]\s*")
ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d]")
WS_RE = re.compile(r"\s+")


def norm_text(s: str) -> str:
    s = ZERO_WIDTH_RE.sub("", s or "")
    s = WS_RE.sub(" ", s)
    return s.strip()


def is_probably_bangla(s: str) -> bool:
    # crude heuristic: has any Bangla letters
    return any("\u0980" <= ch <= "\u09FF" for ch in (s or ""))


def extract_kv_pairs(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw_line in (text or "").splitlines():
        line = norm_text(raw_line)
        if not line:
            continue
        # Match: "নাম: মো: ..." or "ইমেইল : director@..."
        parts = LABEL_SPLIT_RE.split(line, maxsplit=1)
        if len(parts) != 2:
            continue
        key, val = norm_text(parts[0]), norm_text(parts[1])
        if not key or not val:
            continue
        if len(key) > 40:
            continue
        if not is_probably_bangla(key):
            continue
        out[key] = val
    return out


@dataclass
class PdfSummary:
    path: Path
    pages: int
    images: int
    top_labels: list[tuple[str, int]]
    sample_kv: list[dict[str, str]]


def analyze_pdf(pdf_path: Path, max_pages_for_sample: int = 3) -> PdfSummary:
    doc = fitz.open(pdf_path)
    label_counter: Counter[str] = Counter()
    sample: list[dict[str, str]] = []

    total_images = 0

    for i in range(doc.page_count):
        page = doc.load_page(i)
        total_images += len(page.get_images(full=True))
        text = page.get_text("text")
        kv = extract_kv_pairs(text)
        for k in kv.keys():
            label_counter[k] += 1
        if kv and len(sample) < max_pages_for_sample:
            sample.append(kv)

    return PdfSummary(
        path=pdf_path,
        pages=doc.page_count,
        images=total_images,
        top_labels=label_counter.most_common(30),
        sample_kv=sample,
    )


def main() -> None:
    pdf_path = Path(r"D:\D Drive\E Drive\Semester 4.1\RTI\PROJECT FILES\x_files\তথ্য কর্মকর্তা _ স্থানীয় সরকার বিভাগ.pdf")
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    s = analyze_pdf(pdf_path)

    print("PDF:", s.path.name)
    print("Type: PDF (binary), typically generated from HTML / portal page for offline sharing/printing")
    print("Pages:", s.pages)
    print("Embedded images (count):", s.images)

    print("\nTop detected Bangla labels:")
    for k, c in s.top_labels[:20]:
        print(f"- {k}: {c}")

    print("\nSample extracted key/value maps:")
    for idx, kv in enumerate(s.sample_kv, start=1):
        print(f"\n--- sample page block {idx} ---")
        for k, v in kv.items():
            print(f"{k}: {v}")


if __name__ == "__main__":
    main()

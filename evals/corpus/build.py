#!/usr/bin/env python3
"""
Builds the eval corpus from the downloads named in SOURCES.md. Provenance, not
a lane: the built files are committed (with their sha256 in manifest.json), so
an eval run never touches the network and two runs read the same bytes.

    python3 evals/corpus/build.py <download-dir>

Python standard library only (html.parser), because the two web pages need an
HTML parser and nothing in the Node workspace has one. Run it again only to
refresh a source; then bump its row in SOURCES.md and re-check every gold quote
(`pnpm --filter @rag/evals test` fails on a quote that no longer matches).

What it writes, all under evals/corpus/files/:

- six Wikipedia articles (CC BY-SA 4.0) from the API's plain-text extract at a
  pinned revision: `== Heading ==` becomes `## Heading`, and the reference
  sections (See also, References, ...) are dropped. Five as markdown, one
  (Tardigrade) as plain text, so the text reader is measured too.
- the Constitution transcript (archives.gov, public domain) and Yellowstone's
  safety page (nps.gov, public domain) as markdown: headings, paragraphs and
  list items only, from the page's main content.
- the two NIST PDFs (public domain) copied byte for byte.
- the scanned PDF, rendered here from scanned-source.txt as an image-only
  page (ImageMagick), so the "no text layer" path is in the set.

The hostile document (hostile.md) is written by hand and lives in files/ as is.
Not "docs/": that name is git-ignored at every level in this repo.
"""
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = HERE / "files"
DROP = {
    "see also", "references", "notes", "further reading", "external links",
    "bibliography", "sources", "citations", "footnotes", "explanatory notes",
    "general and cited sources", "works cited", "cited sources",
}

WIKI = [
    ("Espresso", "espresso.md"),
    ("French_press", "french-press.md"),
    ("Honey_bee", "honey-bee.md"),
    ("Sourdough", "sourdough.md"),
    ("Panama_Canal", "panama-canal.md"),
    ("Tardigrade", "tardigrade.txt"),
]


def wiki(downloads: Path, title: str, out: str) -> dict:
    page = json.loads((downloads / f"wiki-{title}.json").read_text("utf-8"))["query"]["pages"][0]
    lines = [f"# {page['title']}", ""]
    skipping = False
    for raw in page["extract"].split("\n"):
        m = re.match(r"^(=+)\s*(.*?)\s*=+$", raw)
        if m:
            depth, name = len(m.group(1)), m.group(2)
            if depth == 2:
                skipping = name.lower() in DROP
            if skipping:
                continue
            lines += ["", f"{'#' * depth} {name}", ""]
            continue
        if not skipping:
            lines.append(raw.rstrip())
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"
    if out.endswith(".txt"):
        text = re.sub(r"^#+ ", "", text, flags=re.M)
    (FILES / out).write_text(text, "utf-8")
    rev = page["revisions"][0]
    return {"revid": rev["revid"], "timestamp": rev["timestamp"]}


class Markdown(HTMLParser):
    """Headings, paragraphs and list items between two markers, nothing else."""

    BLOCK = {"p": "", "li": "- ", "h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### "}

    def __init__(self, start: str, stop: str):
        super().__init__(convert_charrefs=True)
        self.start, self.stop = start, stop
        self.on, self.done = False, False
        self.stack: list[str] = []
        self.buf: list[str] = []
        self.blocks: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.stack.append(tag)
        elif tag in self.BLOCK:
            self.flush()
            self.buf = [self.BLOCK[tag]]
        elif tag == "br":
            self.buf.append(" ")

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        elif tag in self.BLOCK:
            self.flush()

    def handle_data(self, data):
        if self.stack or self.done:
            return
        if not self.on and self.start in data:
            self.on = True
        if self.on and self.stop in data:
            self.done = True
            return
        if self.on:
            self.buf.append(data)

    def flush(self):
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        if self.on and not self.done and text and text not in ("-", "#", "##", "###", "####"):
            self.blocks.append(text)


def page(downloads: Path, src: str, out: str, title: str, start: str, stop: str):
    parser = Markdown(start, stop)
    parser.feed((downloads / src).read_text("utf-8"))
    parser.flush()
    body = [b for b in parser.blocks if not re.fullmatch(r"#+\s*", b)]
    if not parser.on or not parser.done:
        sys.exit(f"build: {src}: start or stop marker not found")
    (FILES / out).write_text(f"# {title}\n\n" + "\n\n".join(body) + "\n", "utf-8")


def scanned():
    out = FILES / "scanned-notice.pdf"
    text = (HERE / "scanned-source.txt").read_text("utf-8")
    subprocess.run(
        ["convert", "-size", "1240x1754", "xc:white", "-font", "DejaVu-Sans", "-pointsize", "26",
         "-fill", "black", "-annotate", "+90+140", text, "-density", "150",
         "-define", "pdf:use-trimbox=true", "-strip", str(out)],
        check=True,
    )


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    downloads = Path(sys.argv[1])
    FILES.mkdir(exist_ok=True)
    revisions = {title: wiki(downloads, title, out) for title, out in WIKI}
    page(downloads, "constitution-transcript", "us-constitution.md",
         "The Constitution of the United States: A Transcription",
         "We the People", "G°. Washington")
    page(downloads, "safety.htm", "yellowstone-safety.md", "Yellowstone National Park: Safety",
         "Thermal Areas", "Park footer")
    shutil.copyfile(downloads / "NIST.SP.800-63B-4.pdf", FILES / "nist-sp-800-63b-4.pdf")
    shutil.copyfile(downloads / "NIST.CSWP.29.pdf", FILES / "nist-csf-2.0.pdf")
    scanned()
    print(json.dumps(revisions, indent=2))
    for path in sorted(FILES.iterdir()):
        print(hashlib.sha256(path.read_bytes()).hexdigest(), path.name)


if __name__ == "__main__":
    main()

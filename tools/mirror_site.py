"""Mirror puppy.instabizweb.com into ./mirror for local, offline viewing.

Fetches every page in the sitemap plus every asset those pages need
(Next.js chunks, CSS, fonts, media, cursors, icons), following chunk
references recursively so lazily loaded code is included too.

    python -I tools/mirror_site.py            # writes ./mirror
    node serve-mirror.js                      # then open http://localhost:4173
"""
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://puppy.instabizweb.com"
ROOT = Path(__file__).resolve().parent.parent / "mirror"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"

# Root-relative asset paths as they appear in HTML, CSS, JS and escaped RSC payloads
ASSET_RE = re.compile(
    r"(?<![\w.])/(?:_next/static|media|brand|cursor|fonts|icons|images|img|video|videos|audio|sounds)/"
    r"[^\s\"'\\)<>?#,`]+"
)
ROOT_FILE_RE = re.compile(r"(?<![\w./])/[\w.-]+\.(?:png|ico|svg|webmanifest|json|xml|txt)(?![\w/])")
CHUNK_RE = re.compile(r"static/(?:chunks|media|css)/[\w./-]+?\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|gif|mp4|webm)")
NEXT_IMAGE_RE = re.compile(r"/_next/image\?url=([^&\"'\\\s]+)")
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")
# Third-party analytics, and Cloudflare's email decoder (emails are decoded below), are
# edge-injected and not part of the app
STRIP_RE = re.compile(r"<script[^>]*(?:static\.cloudflareinsights\.com|/cdn-cgi/scripts/)[^>]*>\s*</script>")
CF_LINK_RE = re.compile(r'href="/cdn-cgi/l/email-protection#([0-9a-f]+)"')
CF_SPAN_RE = re.compile(r'<span class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email&#160;protected\]</span>')


def cf_decode(hexstr):
    key = int(hexstr[:2], 16)
    return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))


def clean_html(html):
    """Undo edge rewrites so the HTML matches what React hydrates against."""
    html = STRIP_RE.sub("", html)
    html = CF_LINK_RE.sub(lambda m: f'href="mailto:{cf_decode(m.group(1))}"', html)
    return CF_SPAN_RE.sub(lambda m: cf_decode(m.group(1)), html)


def fetch(url, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            # 4xx is final; 5xx (Cloudflare 520s included) is worth another go
            if e.code < 500 or attempt == tries - 1:
                raise
        except (TimeoutError, urllib.error.URLError):
            if attempt == tries - 1:
                raise
        time.sleep(1 + attempt * 2)


def local_path(url_path):
    p = urllib.parse.unquote(url_path.split("?")[0].split("#")[0]).lstrip("/")
    dest = (ROOT / p).resolve()
    if ROOT.resolve() not in dest.parents and dest != ROOT.resolve():
        raise ValueError(f"refusing path outside mirror: {url_path}")
    return dest


def page_dest(url_path):
    p = url_path.strip("/")
    return ROOT / p / "index.html" if p else ROOT / "index.html"


def refs_in(text, origin):
    """Every same-site asset path referenced by a text resource."""
    found = set()
    unescaped = text.replace("\\/", "/").replace("\\u002F", "/")
    for m in ASSET_RE.finditer(unescaped):
        found.add(m.group(0))
    for m in ROOT_FILE_RE.finditer(unescaped):
        found.add(m.group(0))
    for m in CHUNK_RE.finditer(unescaped):
        found.add("/_next/" + m.group(0))
    for m in NEXT_IMAGE_RE.finditer(unescaped):
        src = urllib.parse.unquote(m.group(1).replace("&amp;", "&"))
        if src.startswith("/"):
            found.add(src)
    if origin.endswith(".css"):
        for m in CSS_URL_RE.finditer(text):
            u = m.group(1).strip()
            if u.startswith(("data:", "http:", "https:", "#")):
                continue
            found.add(urllib.parse.urljoin(origin, u))
    return {f.rstrip(".") for f in found if not f.startswith("/_next/image")}


def main():
    sitemap = fetch(BASE + "/sitemap.xml").decode()
    pages = [urllib.parse.urlparse(u).path or "/" for u in re.findall(r"<loc>([^<]+)</loc>", sitemap)]
    print(f"{len(pages)} pages in sitemap")

    seen, failed = set(), []
    queue = set()

    def save_page(path):
        html = clean_html(fetch(BASE + path).decode("utf-8"))
        dest = page_dest(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(html, encoding="utf-8")
        return refs_in(html, path)

    with ThreadPoolExecutor(8) as pool:
        for refs in pool.map(save_page, pages):
            queue |= refs

    # Next renders its not-found page for unknown routes; keep a copy for the local server
    try:
        req = urllib.request.Request(BASE + "/__mirror_404__", headers={"User-Agent": UA})
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        html = clean_html(e.read().decode("utf-8"))
        (ROOT / "404.html").write_text(html, encoding="utf-8")
        queue |= refs_in(html, "/404")

    def save_asset(path):
        try:
            data = fetch(BASE + urllib.parse.quote(path, safe="/%@:+-._~"))
        except Exception as e:  # noqa: BLE001 - report and keep going
            return path, None, str(e)
        dest = local_path(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        new = set()
        if dest.suffix in (".js", ".css", ".json", ".svg", ".webmanifest"):
            new = refs_in(data.decode("utf-8", "replace"), path)
        return path, new, None

    with ThreadPoolExecutor(12) as pool:
        while queue:
            batch = queue - seen
            seen |= batch
            queue = set()
            for path, new, err in pool.map(save_asset, sorted(batch)):
                if err:
                    failed.append((path, err))
                else:
                    queue |= new
            print(f"  fetched {len(batch)} assets, {len(queue - seen)} new references")

    print(f"done: {len(pages)} pages, {len(seen) - len(failed)} assets -> {ROOT}")
    if failed:
        print(f"{len(failed)} references could not be fetched (often false positives from minified code):")
        for p, e in failed:
            print(f"  {p}  ({e})")


if __name__ == "__main__":
    sys.exit(main())

# TeddyPups mirror

An offline mirror of [puppy.instabizweb.com](https://puppy.instabizweb.com/): all 49 pages from its sitemap, with the original Next.js build, styles, fonts, photos and videos, running locally with the same animations and client-side navigation.

## Run it

Requires Node.js 18+. No install step.

```bash
node serve-mirror.js
```

Then open http://localhost:4173 (set `PORT` to use another port).

## What's here

| Path | What it is |
| --- | --- |
| `mirror/` | The site: page HTML, `_next/` build output, `media/` images and videos, and `_rsc/` recorded navigation payloads |
| `serve-mirror.js` | Static server that also stands in for the two things Next.js expects from its host: the `/_next/image` endpoint (serves originals, unresized) and RSC navigation requests (served from `mirror/_rsc`) |
| `rsc-key.js` | How a recorded RSC payload is keyed; shared by the server and the recorder |
| `tools/mirror_site.py` | Crawls the sitemap and downloads every page and asset |
| `tools/record_rsc.js` | Drives Chrome through every page to record the RSC payloads behind in-site navigation |

## Refreshing the mirror

The mirror is a snapshot. To pull the current live site:

```bash
python -I tools/mirror_site.py
cd tools && npm install && npm run record-rsc
```

The recorder uses your installed Chrome (or Edge); set `CHROME_PATH` if it isn't found.

## Differences from the live site

- Cloudflare's analytics beacon and email obfuscation are removed from the saved HTML; the email address is decoded back to plain text so React hydrates without a mismatch.
- Images are served at original size rather than resized per screen.
- `/admin` and `/api` are not mirrored, so anything that writes data won't work offline.
- WhatsApp, phone, email and social links still point at the real accounts.

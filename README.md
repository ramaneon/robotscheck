# RobotsCheck — Bug Bounty Recon Tool

> Paste a domain. Fetch `robots.txt` + sitemap. See every `Disallow` path. Open all in **one click**.

**Live Tool:** https://robotscheck.github.io/robotscheck/

---

## Features

| Feature | Description |
|---|---|
| 🤖 robots.txt Fetcher | Full syntax-highlighted parse via CORS proxy |
| 🚫 Disallow Extractor | All `Disallow` paths by user-agent, filterable |
| 🗺️ Sitemap Discovery | Auto-finds sitemap.xml, sitemap_index.xml, etc. |
| 🔗 Open All in Tabs | One-click opens ALL disallowed paths in new tabs |
| ✅ URL Tester | Test any path against all rules (Google-style matching) |
| 📤 Export | JSON, Markdown, CSV, plain text reports |
| 🎨 3D UI | Interactive 3D sphere + animated network background |

## How it works

1. Paste your target domain (e.g. `example.com`)
2. RobotsCheck fetches `robots.txt` via CORS proxy
3. Parses all rules — Disallow, Allow, Sitemap, Crawl-delay
4. Click **OPEN ALL IN TABS** to open every disallowed path at once
5. Filter by User-Agent, select individual paths, export findings

## CORS Note

Browser-based tools can't fetch cross-origin resources directly.  
This tool uses [corsproxy.io](https://corsproxy.io) and [allorigins.win](https://api.allorigins.win) as fallback proxies.

## Run Locally

```bash
git clone https://github.com/robotscheck/robotscheck.git
cd robotscheck
# Just open index.html in your browser — zero dependencies!
```

## Deploy on GitHub Pages

1. Push to GitHub repo named `robotscheck`
2. Go to **Settings → Pages → Source: main branch / root**
3. Your tool is live at `https://<username>.github.io/robotscheck/`

## Legal

For **authorized testing only**. Always have explicit permission before scanning a target.

---
Made with ⚡ for bug bounty hunters

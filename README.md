# RobotsCheck — Bug Bounty Recon Tool

> Instant `robots.txt` & `sitemap.xml` parser, rule tester & **1-click batch endpoint opener** for bug bounty hunters and security researchers.

🌐 **Live Tool (GitHub Pages):** [https://ramaneon.github.io/robotscheck/](https://ramaneon.github.io/robotscheck/)  
🐙 **Repository:** [https://github.com/ramaneon/robotscheck](https://github.com/ramaneon/robotscheck)

---

## ⚡ Why RobotsCheck?

When reconning targets during bug bounty assessments, checking `robots.txt` and `sitemap.xml` reveals sensitive developer endpoints, forgotten admin consoles, staging areas, internal APIs, and unlinked endpoints.

Opening dozens of `Disallow:` paths one by one wastes valuable hunting time. **RobotsCheck extracts every single disallowed endpoint and lets you open all of them in browser tabs in ONE SINGLE CLICK.**

Inspired by [Patrick Stox's Robots.txt Tester](https://patrickstox.com/tools/robots-txt-tester/), RobotsCheck adds full **batch 1-click execution**, user-agent filtering, interactive 3D visualizations, and export tooling.

---

## 🚀 Key Features

| Feature | Description |
|---|---|
| 🤖 **Automatic Fetch & Parse** | Auto-probes `robots.txt` using resilient multi-tier CORS proxies |
| ✍️ **Patrick Stox Tester Mode** | Paste or edit custom `robots.txt` rules directly with instant re-parsing |
| 🚫 **Disallowed Endpoints** | Categorized, filtered by user-agent, and ready for inspection |
| 🔗 **1-Click Tab Opener** | Open ALL disallowed paths in tabs at once with smart rate-limiting |
| 🗺️ **Sitemap Discovery** | Automatically finds referenced and default sitemap XML files |
| ✅ **Batch URL Testing** | Paste a list of URLs and test which ones are Allowed vs Blocked |
| 🎨 **3D Interactive HUD** | Cyberpunk 3D rotating holographic sphere and live particle canvas |
| 📤 **Multi-Format Export** | Export findings as JSON, Markdown, CSV, or plain URL lists |

---

## 🛠️ How to Use

1. Enter your target domain (e.g. `example.com` or `https://target.com/robots.txt`).
2. Click **FETCH & SCAN** (or click **✍️ Paste / Edit** to analyze raw text).
3. Review the parsed Disallowed paths, Sitemaps, and User-Agents.
4. Click **OPEN ALL IN 1-CLICK** to pop all endpoints into browser tabs.
5. Use the **Rule Tester** to check specific endpoints against bot directives.
6. Export your recon report in Markdown or JSON for your bug bounty documentation.

---

## 🖥️ Local Usage & GitHub Desktop

### Using Git:
```bash
git clone https://github.com/ramaneon/robotscheck.git
cd robotscheck
# Just open index.html in any browser — zero build steps or npm needed!
```

### Using GitHub Desktop:
1. Open **GitHub Desktop**.
2. Go to **File → Add Local Repository** (or press `Ctrl+O`).
3. Browse to `D:\cdrive\Desktop\New folder`.
4. Click **Add Repository**.
5. You can now commit, branch, and sync with `origin/main` directly from GitHub Desktop!

---

## 🌐 GitHub Pages Setup

The repository is configured for GitHub Pages:
1. Go to repository **Settings → Pages**.
2. Select **Source: Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`.
4. Click **Save**.
5. Accessible at: `https://ramaneon.github.io/robotscheck/`

---

## ⚖️ Legal Disclaimer

For **authorized security testing and educational research only**. Always ensure you have appropriate authorization before testing targets.

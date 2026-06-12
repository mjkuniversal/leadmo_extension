# LeadMomentum Browser Extension

Import contact information from **any website** directly into [LeadMomentum](https://leadmomentum.com) (GoHighLevel). Chrome and Firefox, Manifest V3.

## Features

- **Works on any site** — auto-detects form fields with heuristic mapping; click-to-select for manual field assignment, saved per domain
- **Built-in presets** for VanillaSoft (`*.vanillasoft.net`) and Intruity OneLink (`*.onelink.intruity.com`)
- **Auto-scrapes** name, phone, email, address, and date of birth — including GoHighLevel's own contact pages
- **GHL survey integration** — opens your survey pre-filled with the scraped contact via URL parameters
- **Tag contacts** (applied additively — existing tags are never overwritten) and **add to workflows** on import
- **Phone verification** via LandlineScrubber (DNC check + line type detection)
- **Multi-account support** — save and switch between multiple API keys

## Installation

- **Chrome:** [Chrome Web Store](https://chromewebstore.google.com/detail/leadmomentum/kfhclnlhochkkmeedbieadfdaakedgpl) (requires Chrome 116+)
- **Firefox:** Firefox Add-ons / AMO (requires Firefox 127+)

### For Development

- **Chrome:** `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the `LeadMomentum-Chrome/` folder
- **Firefox:** `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `LeadMomentum-Firefox/manifest.json`

## Setup

1. Click the LeadMomentum extension icon in your toolbar
2. Enter an account name, your **GoHighLevel Private Integration Token**, and your **Location ID**
3. Click **Add**, then **Select** the account from the dropdown
4. (Optional) Paste your GHL **survey URL** and click **Save URL**
5. (Optional) Enter your **LandlineScrubber API key** to enable phone verification

## Usage

1. Navigate to a page showing contact data (CRM, dialer, GHL contact page, web form)
2. Click the LeadMomentum icon — the popup scans the page and auto-maps detected fields
3. Adjust mappings if needed (dropdowns or **Pick** to click an element on the page), then **Grab Data**
4. (Optional) Select a **tag**, then click **Send To LeadMomentum** to upsert the contact
5. (Optional) Select a **workflow** and click **Add to Workflow**
6. (Optional) **Open Survey** — loads your survey pre-filled with the grabbed contact

> Note: GHL surveys typically capture the pre-filled contact data in **hidden fields** — the survey may look empty while the data is attached on submission.

## Privacy & Data Handling

This extension handles personal contact information (names, phone numbers, email addresses, physical addresses, dates of birth). Data is:

- **Stored locally** in browser extension storage, sandboxed to this extension
- **Transmitted** only to GoHighLevel (contact upsert) and LandlineScrubber (phone verification) via your own API keys
- **Not collected** by the extension developer — all data stays between your browser and your API accounts
- **Cleared** when the extension is uninstalled

Use of this extension with CRM platforms is subject to those platforms' terms of service.

## Development

Tests (Playwright, headed Chrome required): `npx playwright test`

See `CLAUDE.md` for architecture, message flow, packaging instructions, and the full version history.

# LeadMomentum Chrome Extension

## Project Overview

Chrome Extension (Manifest V3, minimum Chrome 116) that scrapes contact data from **any website** and imports it into LeadMomentum/GoHighLevel. Auto-detects form fields with heuristic mapping, supports click-to-select for manual field assignment, and includes built-in presets for VanillaSoft and Intruity OneLink. Includes phone verification via LandlineScrubber API.

## Directory Structure

```
leadmo/
├── Chrome Extension/
│   ├── extension36 - need to update to this version/   # Latest source (v2.0)
│   │   ├── manifest.json          # MV3 manifest
│   │   ├── background.js          # Service worker - GHL API calls
│   │   ├── content.js             # Content script - field detection, pick mode, DOM scraping
│   │   ├── jquery.min.js          # jQuery 3.6.4
│   │   ├── style.css              # Content script styles (injected via manifest css)
│   │   ├── icons/                 # Extension icons (36-512px)
│   │   └── popup/
│   │       ├── index.html         # Popup layout
│   │       ├── script.js          # Popup logic + message handling
│   │       ├── style.css          # Popup styles
│   │       ├── logo.png           # LeadMomentum logo
│   │       ├── select2.min.js     # Select2 4.1.0-rc.0
│   │       └── select2.min.css    # Select2 styles
│   ├── LeadMomentum v1.1/         # Previous version (archived)
│   ├── LeadMomentum v1.0.zip      # Archived release
│   ├── LeadMomentum v1.1.zip      # Archived release
│   └── LeadMomentum v1.2.zip      # Current release for Chrome Web Store
└── .gitignore
```

## Vendored Dependencies

| Library | Version | File | Notes |
|---------|---------|------|-------|
| jQuery | 3.6.4 | `jquery.min.js` | Above CVE-2020-11022 threshold (3.5.0) |
| Select2 | 4.1.0-rc.0 | `popup/select2.min.js` | Dropdown UI component |

## Version History

| Version | Changes |
|---------|---------|
| 1.0 | Initial Chrome Web Store release |
| 1.1 | Added `host_permissions` for LandlineScrubber API |
| 1.2 | Added sender verification on message listeners, added `host_permissions` for GHL + LandlineScrubber, added `minimum_chrome_version`, commented out console.log debug statements |
| 2.0 | Universal website support: auto-detect form fields on any site, click-to-select field mapping, per-domain mapping persistence, built-in VanillaSoft/Intruity presets. Content scripts now match `<all_urls>` with CSS injection. |

## Architecture

### Message Flow

```
Content Script (content.js)
  ↕ chrome.runtime.sendMessage (sender.id verified)
Popup (popup/script.js)
  ↕ chrome.runtime.sendMessage (sender.id verified)
Background Service Worker (background.js)
  ↕ fetch()
GoHighLevel REST API (rest.gohighlevel.com/v1/)
```

All `onMessage` listeners verify `sender.id === chrome.runtime.id` to reject messages from other extensions.

### Key Message Types

| From | Subject | Purpose |
|------|---------|---------|
| popup → content | `detectFields` | Scan page for form fields, return descriptors with auto-mapping |
| popup → content | `startPicking` | Enter click-to-select mode (highlight on hover) |
| popup → content | `cancelPicking` | Exit pick mode, remove highlights |
| popup → content | `grabData` | Read field values via mappings, save `profile_data` |
| content → popup | `fieldsDetected` | Return detected fields with labels and suggested mappings |
| content → popup | `loadContactData` | Notify data is ready in storage |
| popup → background | `makeApiCall` / `getWorkflowsAndTags` | Fetch workflows + tags from GHL |
| popup → background | `makeApiCall` / `sendToLeadmomentum` | Create contact in GHL |
| popup → background | `makeApiCall` / `addWorkflow` | Create contact + add to workflow |
| background → popup | `loadWorkflows` | Return workflow list |
| background → popup | `loadTags` | Return tag list |
| background → popup | `contactCreated` | Confirm contact creation |
| background → popup | `workflowAdded` | Confirm workflow assignment |

### Data Storage (chrome.storage.local)

| Key | Type | Purpose |
|-----|------|---------|
| `api_keys` | `Array<[name, key]>` | Saved GHL API keys |
| `selected_api_key` | `string` | Currently active API key |
| `profile_data` | `object` | Scraped contact data (PII) |
| `landlinescrubber_api_key` | `string` | Phone verification API key |
| `lm_domain_mappings` | `{domain: {field: {selector}}}` | Saved per-domain field mappings |
| `lm_pick_state` | `{active, fieldKey, domain, result}` | Transient click-to-select state |

**Security note:** API keys and contact PII are stored unencrypted in `chrome.storage.local`. This storage is sandboxed to the extension but is not encrypted at rest. Data persists until the extension is uninstalled or storage is manually cleared.

### Supported Sites

Works on **any website** with form fields. Auto-detects inputs/selects/textareas and applies heuristic keyword matching (e.g., fields named "first_name", "fname", etc.). Users can manually map fields via click-to-select and save mappings per domain.

#### Built-in Presets

| Platform | URL Pattern | Fields Scraped |
|----------|-------------|----------------|
| VanillaSoft | `*.vanillasoft.net` | Name, phone, email, address, DOB |
| Intruity OneLink | `*.onelink.intruity.com` | Name, phone (Day/Home), email, address, DOB |

### External APIs

| API | Base URL | Usage |
|-----|----------|-------|
| GoHighLevel v1 | `rest.gohighlevel.com/v1/` | Contacts, workflows, tags |
| LandlineScrubber | `api.landlinescrubber.com/api/` | Phone DNC + line type check |

## Packaging for Chrome Web Store

1. Bump `version` in `manifest.json` (must exceed the currently published version)
2. Create zip from the extension source directory:
   ```bash
   cd "Chrome Extension/extension36 - need to update to this version"
   zip -r "../LeadMomentum vX.Y.zip" . -x ".*"
   ```
3. Upload the zip at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)

## Development

### Loading Unpacked

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `Chrome Extension/extension36 - need to update to this version/`

### Configuration

1. Open extension popup
2. Enter API name + GoHighLevel API key → click **Add** → **Select**
3. (Optional) Enter LandlineScrubber API key for phone verification

### Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Save API keys and scraped contact data |
| `host_permissions` for `rest.gohighlevel.com` | Cross-origin API calls from service worker |
| `host_permissions` for `api.landlinescrubber.com` | Cross-origin phone verification from popup |
| Content scripts on `<all_urls>` | Field detection and DOM scraping on any site |

# LeadMomentum Chrome Extension

Import contact information from your CRM directly into [LeadMomentum](https://leadmomentum.com) (GoHighLevel).

## Features

- **One-click contact import** from VanillaSoft and Intruity OneLink
- **Auto-scrapes** name, phone, email, address, and date of birth
- **Tag contacts** during import using your GoHighLevel tags
- **Add to workflows** automatically when importing
- **Phone verification** via LandlineScrubber (DNC check + line type detection)
- **Multi-account support** — save and switch between multiple API keys

## Supported CRMs

| Platform | URL |
|----------|-----|
| VanillaSoft | `*.vanillasoft.net` |
| Intruity OneLink | `*.onelink.intruity.com` |

## Installation

Install from the [Chrome Web Store](https://chrome.google.com/webstore) (search "LeadMomentum").

Requires Chrome 116 or later.

### For Development

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `Chrome Extension/extension36 - need to update to this version/` folder

## Setup

1. Click the LeadMomentum extension icon in your toolbar
2. Enter a name for your account and your **GoHighLevel API key**
3. Click **Add**, then **Select** the account from the dropdown
4. (Optional) Enter your **LandlineScrubber API key** to enable phone verification

## Usage

1. Navigate to a contact page in VanillaSoft or Intruity OneLink
2. Click the LeadMomentum extension icon
3. Verify the scraped contact data shown in the popup
4. (Optional) Select a **tag** from the dropdown
5. Click **Send To LeadMomentum** to create the contact
6. (Optional) Select a **workflow** and click **Add to Workflow**

### Phone Verification

1. Enter your LandlineScrubber API key
2. The phone number auto-fills from the scraped contact
3. Click **Check** to see DNC status and line type

## Privacy & Data Handling

This extension handles personal contact information (names, phone numbers, email addresses, physical addresses, dates of birth). Data is:

- **Stored locally** in Chrome extension storage, sandboxed to this extension
- **Transmitted** only to GoHighLevel (contact creation) and LandlineScrubber (phone verification) via your own API keys
- **Not collected** by the extension developer — all data stays between your browser and your API accounts
- **Cleared** when the extension is uninstalled

Use of this extension with CRM platforms is subject to those platforms' terms of service.

## Version History

| Version | Changes |
|---------|---------|
| 1.2 | Added sender verification, explicit host_permissions, minimum Chrome version, cleaned up debug logging |
| 1.1 | Added LandlineScrubber API integration |
| 1.0 | Initial release |

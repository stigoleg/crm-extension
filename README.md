# ServiceNow CRM Opportunity Overview

Chrome extension (Manifest V3) that injects a compact, configurable Overview
panel on ServiceNow CRM opportunity record pages.

Supported pages are matched by **path**, not host, so the extension works
across every ServiceNow instance that hosts the CRM application — for
example:

- `https://alfred.service-now.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/…`
- `https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/…`
- any other `https://<instance>/x/ssasi/crm/record/x_ssasi_crm_opportunity/…`

## Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick this repository root (the folder
   containing `manifest.json`).
4. The badge shows **ON** when the active tab is a supported opportunity URL.

## Usage

- Navigate to any opportunity record under the supported URL prefix. The
  Overview panel appears near the top of the record content.
- Click **Configure** in the panel header — or use **Open settings** from the
  popup — to choose which fields are shown.
- The popup shows whether the current tab is supported and exposes quick
  toggles. Full settings are always available via **Open settings**.

## Default fields

Account, Name, Stage, Due Date, Close Date, Apps Status, Apps Client Owner,
Apps Community, Apps Opportunity Manager, Apps Opportunity Team.

If your instance exposes slightly different labels, the extractor normalizes
whitespace and case, and supports a small alias list per field (see
`src/content/field-registry.js`). Add aliases there to teach it new variants.

## Adding a newly detected field

The options page reports columns that exist on the live form but not in the
static catalog. To integrate one:

1. Add an entry to `RAW_FIELDS` in `src/content/field-registry.js`. Use the
   ServiceNow column name as `key`, the live section heading as `group`, and
   set `renderAs` when the value is a date (`date`), URL (`link`), pill set
   (`badge` / `badge-list`), integer (`number`), or long text (`markdown`).
2. Run `npm run build:content` so `src/content/content-script.bundle.js`
   picks up the registry change (the manifest loads only the bundle).
3. Run `npm test`.

Persisted `detected:*` discoveries for a promoted column fold into normal
`known` entries automatically, and selected `detected:<name>` layout keys
migrate to the static key on the next boot. Discovery re-runs on manual
Refresh and when a ServiceNow section is expanded, so new fields can be
picked up without reloading the record.

## Architecture

```
src/
  shared/        prefix rule, logger, storage, messaging, constants
  background/    minimal service worker (badge + openOptions relay)
  content/       controller state machine, navigation tracker,
                 field registry, DOM extractors, UI, styles
  popup/         status + quick toggles
  options/       authoritative settings editor
```

- Manifest match pattern covers the opportunity route; the exact `startsWith`
  rule is enforced in `src/shared/url.js` (`isSupportedUrl`) and reused
  everywhere page support is checked.
- Content script state machine handles delayed hydration, in-app navigation,
  record-to-record transitions, and DOM re-renders.
- Field extraction runs five ordered strategies per field: `data-field`
  attribute, `aria-labelledby`, `<label for>`, definition list, and
  normalized label-text match.
- Settings persist in `chrome.storage.sync` with a versioned schema. The
  content script listens for storage changes and re-renders live.

## Markdown fields

- Markdown links allow `http:`, `https:`, `mailto:`, and same-origin
  root-relative ServiceNow paths such as `/nav_to.do?...` or `/x/...`.
- Dangerous link targets such as `javascript:` and protocol-relative
  `//...` links are rewritten to `#`.

## Debugging

1. Open the extension popup and enable **Debug logging**. (Or toggle
   `debug: true` from the options page.)
2. Open DevTools on the opportunity tab. Logs are namespaced:
   - `[sncrm:ctrl]` controller state transitions and mount decisions
   - `[sncrm:nav]` URL changes and their source (pushState, poll, …)
   - `[sncrm:extract]` which strategy won for each field, or miss reasons
   - `[sncrm:ui]` mount target chosen
   - `[sncrm:storage]` read/write operations
   - `[sncrm:sw]` service worker lifecycle
3. Failure-mode to log mapping:
   - no panel + badge OFF → unsupported URL (check prefix match)
   - no panel + badge ON → content script not injected (reload, check
     `chrome://extensions` errors)
   - empty panel with skeleton stuck → hydration timeout (inspect DOM; may
     need a new alias)
   - empty values for a field → `[sncrm:extract] miss <key>`; add an alias
     or DOM hint
   - panel duplicated → should be impossible (guarded by `PANEL_ID`);
     report as a bug
4. Storage issues are visible under `chrome://extensions` → Inspect views
   → Service worker → `[sncrm:storage]`.

## Testing

The extension is deliberately DOM-agnostic — there is no bundler or test
runner. To verify a change:

1. Reload the extension in `chrome://extensions`.
2. Open a supported opportunity record; confirm the Overview appears within
   ~1 s of hydration.
3. Navigate to a second opportunity without reloading; confirm the panel
   re-renders with the new values.
4. Open **Options**, toggle a field off; confirm the panel updates live.
5. Toggle **Debug logging** on; confirm `[sncrm:*]` lines appear.

## Permissions

- `storage` — persist settings.
- `tabs` — read the active tab URL for popup status.
- `scripting` + `webNavigation` — let the service worker inject the content
  script as a fallback when a tab reaches an opportunity URL via SPA-style
  routing or late navigation, so users do not need a hard refresh.
- Narrow host permission on
  `https://*/x/ssasi/crm/record/x_ssasi_crm_opportunity/*` — required for
  both the declarative content script and the fallback injection path, while
  still excluding unrelated HTTPS pages.

No external libraries. No analytics. No network calls.

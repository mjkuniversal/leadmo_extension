/* ============================================================
   LeadMomentum Content Script v2.1
   - Injected on demand via chrome.scripting.executeScript()
   - Field detection with heuristic auto-mapping
   - VanillaSoft / Intruity OneLink presets
   - Click-to-select (pick) mode
   - grabData handler (builds profile_data)
   ============================================================ */

// Guard against double-injection
if (window._lmContentScriptLoaded) {
    // Already injected — skip re-initialization
} else {
window._lmContentScriptLoaded = true;

// ── Presets ──────────────────────────────────────────────────
const PRESETS = {
    vanillasoft: {
        match: "vanillasoft.net",
        fields: {
            first_name:  "#FirstName",
            last_name:   "#LastName",
            phone:       '[placeholder="Phone Number"]',
            email:       "#Email",
            address:     "#Address1",
            city:        "#City",
            state:       "#State",
            zipcode:     "#ZipCode",
            // NOTE: must stay valid for document.querySelector — no jQuery-only
            // pseudo-selectors like :contains(). The read-only table DOB is
            // handled by the special-case scrape in grab_data().
            birthdate:   ".otherInformationDateTimePicker"
        }
    },
    intruity: {
        match: "onelink.intruity.com",
        fields: {
            first_name:  "#First_Name",
            last_name:   "#Last_Name",
            phone:       "#Day_Phone, #Home_Phone",
            email:       "#Email",
            address:     "#Street1, #Home_Address1",
            address2:    "#Street2, #Home_Address2",
            city:        "#City, #Home_City",
            state:       "#State, #Home_State",
            zipcode:     "#Zipcode, #Home_Zip",
            birthdate:   "#DOB, #Applicant_DOB"
        }
    }
};

// ── Heuristic keyword patterns ──────────────────────────────
const FIELD_PATTERNS = {
    full_name:  /^name$|full.?name|contact.?name|your.?name/i,
    first_name: /first.?name|fname|given.?name/i,
    last_name:  /last.?name|lname|surname|family.?name/i,
    phone:      /phone|mobile|cell|tel/i,
    email:      /email|e-mail/i,
    birthdate:  /birth|dob|date.?of.?birth/i,
    address:    /^address$|address.?1|street.?1|street$|^address1$/i,
    address2:   /address.?2|street.?2|apt|suite|unit/i,
    city:       /city|town|locality/i,
    state:      /state|province|region/i,
    zipcode:    /zip|postal|postcode/i
};

// ── Pick-mode state ─────────────────────────────────────────
let pickModeActive = false;
let pickBanner = null;

// ── Message listener ────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;

    if (msg.subject === "detectFields") {
        // Never let a detection error kill the message port — the popup
        // misreads a dead port as "content script not loaded".
        try {
            let result = detect_fields();
            sendResponse({ fields: result.fields, autoMap: result.autoMap });
        } catch (e) {
            sendResponse({ fields: [], autoMap: {}, error: String(e) });
        }
        return;
    }

    if (msg.subject === "startPicking") {
        start_picking(msg.fieldKey);
        sendResponse({ status: "ok" });
        return;
    }

    if (msg.subject === "cancelPicking") {
        stop_picking();
        sendResponse({ status: "ok" });
        return;
    }

    if (msg.subject === "grabData") {
        try {
            grab_data(msg.mappings);
            sendResponse({ status: "ok" });
        } catch (e) {
            sendResponse({ status: "error", error: String(e) });
        }
        return true;
    }
});

// ── Field detection ─────────────────────────────────────────
function detect_fields() {
    let elements = document.querySelectorAll("input, select, textarea");
    let fields = [];

    elements.forEach(function (el) {
        if (!is_visible(el)) return;
        if (el.type === "hidden" || el.type === "password" || el.type === "submit" || el.type === "button" || el.type === "reset"
            || el.type === "checkbox" || el.type === "radio" || el.type === "file" || el.type === "image") return;

        let label = find_label(el);
        let selector = generate_selector(el);
        let currentValue = get_element_value(el);

        fields.push({
            selector: selector,
            label: label,
            name: el.name || "",
            id: el.id || "",
            placeholder: el.placeholder || "",
            tagName: el.tagName.toLowerCase(),
            type: el.type || "",
            currentValue: currentValue
        });
    });

    let url = window.location.href;
    let preset = get_preset_for_url(url);
    let autoMap = try_auto_map(fields, preset);

    return { fields: fields, autoMap: autoMap };
}

function is_visible(el) {
    if (!el.offsetParent && el.style.position !== "fixed") return false;
    let style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function find_label(el) {
    // Strategy 1: <label for="id">
    if (el.id) {
        let lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) return lbl.textContent.trim();
    }

    // Strategy 2: parent <label>
    let parentLabel = el.closest("label");
    if (parentLabel) {
        let text = parentLabel.textContent.trim();
        // Remove the element's own value from label text
        let elVal = el.value || "";
        if (elVal && text.endsWith(elVal)) text = text.slice(0, -elVal.length).trim();
        if (text) return text;
    }

    // Strategy 3: aria-label / aria-labelledby
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    if (el.getAttribute("aria-labelledby")) {
        let ref = document.getElementById(el.getAttribute("aria-labelledby"));
        if (ref) return ref.textContent.trim();
    }

    // Strategy 4: preceding sibling text / label
    let prev = el.previousElementSibling;
    if (prev) {
        if (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "B") {
            return prev.textContent.trim();
        }
    }

    // Strategy 5: table layout — look at the preceding <td> or <th>
    let td = el.closest("td, th");
    if (td) {
        let prevCell = td.previousElementSibling;
        if (prevCell) return prevCell.textContent.trim();
    }

    // Strategy 6: component-library wrappers (e.g. GoHighLevel's contact
    // panel "hr-form-item"): the input has NO name/id/for/aria wiring and a
    // junk placeholder ("--"); the label is an element inside the nearest
    // ancestor that wraps ONLY this control. Verified live against the GHL
    // contact detail page June 2026.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        let controls = node.querySelectorAll("input, select, textarea");
        if (controls.length === 1) {
            let lbl = node.querySelector('label, [class*="label"]');
            if (lbl) {
                let text = lbl.textContent.trim();
                if (text && text !== "--") return text;
            }
        } else if (controls.length > 1) {
            // Wrapper spans multiple fields — any label here is a section
            // title, not this field's label.
            break;
        }
    }

    // Fallback: placeholder, name, or id
    return el.placeholder || el.name || el.id || "";
}

function generate_selector(el) {
    // Prefer #id if unique
    if (el.id) {
        if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
            return "#" + CSS.escape(el.id);
        }
    }

    // tag[name="..."] if unique (escape quotes/backslashes so the
    // selector stays valid CSS for querySelector)
    if (el.name) {
        let escapedName = el.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        let sel = el.tagName.toLowerCase() + '[name="' + escapedName + '"]';
        try {
            if (document.querySelectorAll(sel).length === 1) {
                return sel;
            }
        } catch (e) { /* invalid selector — fall through to path-based */ }
    }

    // Build nth-of-type path from nearest ancestor with id
    let path = [];
    let current = el;
    while (current && current !== document.body) {
        let tag = current.tagName.toLowerCase();
        if (current.id) {
            path.unshift("#" + CSS.escape(current.id));
            break;
        }
        let parent = current.parentElement;
        if (parent) {
            let siblings = Array.from(parent.children).filter(function (c) {
                return c.tagName === current.tagName;
            });
            if (siblings.length > 1) {
                let idx = siblings.indexOf(current) + 1;
                path.unshift(tag + ":nth-of-type(" + idx + ")");
            } else {
                path.unshift(tag);
            }
        } else {
            path.unshift(tag);
        }
        current = parent;
    }

    return path.join(" > ");
}

function get_preset_for_url(url) {
    for (let key in PRESETS) {
        if (url.includes(PRESETS[key].match)) {
            return PRESETS[key];
        }
    }
    return null;
}

function try_auto_map(fields, preset) {
    let autoMap = {};

    if (preset) {
        // Match detected fields against preset selectors
        for (let fieldKey in preset.fields) {
            let presetSelector = preset.fields[fieldKey];
            let selectors = presetSelector.split(",").map(function (s) { return s.trim(); });
            for (let i = 0; i < selectors.length; i++) {
                let el = null;
                try { el = document.querySelector(selectors[i]); }
                catch (e) { continue; } // skip invalid selectors instead of killing the scan
                if (el) {
                    // Find matching detected field
                    let genSel = generate_selector(el);
                    for (let j = 0; j < fields.length; j++) {
                        if (fields[j].selector === genSel) {
                            autoMap[fieldKey] = fields[j].selector;
                            break;
                        }
                    }
                    if (autoMap[fieldKey]) break;
                }
            }
        }
    }

    // Heuristic matching for any remaining unmapped fields
    for (let fieldKey in FIELD_PATTERNS) {
        if (autoMap[fieldKey]) continue;
        let pattern = FIELD_PATTERNS[fieldKey];
        for (let i = 0; i < fields.length; i++) {
            let f = fields[i];
            let text = [f.label, f.name, f.id, f.placeholder].join(" ");
            if (pattern.test(text)) {
                // Don't double-assign a selector
                let alreadyUsed = false;
                for (let k in autoMap) {
                    if (autoMap[k] === f.selector) { alreadyUsed = true; break; }
                }
                if (!alreadyUsed) {
                    autoMap[fieldKey] = f.selector;
                    break;
                }
            }
        }
    }

    return autoMap;
}

// ── Click-to-select (pick) mode ─────────────────────────────
function start_picking(fieldKey) {
    stop_picking(); // clean up any prior session
    pickModeActive = true;

    // Save pick state so popup can read it on next open
    chrome.storage.local.set({
        lm_pick_state: { active: true, fieldKey: fieldKey, result: null }
    });

    // Banner
    pickBanner = document.createElement("div");
    pickBanner.id = "lm-pick-banner";
    pickBanner.textContent = "LeadMomentum: Click the field for \"" + fieldKey.replace(/_/g, " ") + "\" — press Esc to cancel";
    document.body.appendChild(pickBanner);

    document.addEventListener("mouseover", pick_mouseover, true);
    document.addEventListener("mouseout", pick_mouseout, true);
    document.addEventListener("click", pick_click, true);
    document.addEventListener("keydown", pick_keydown, true);
}

function stop_picking() {
    pickModeActive = false;
    document.removeEventListener("mouseover", pick_mouseover, true);
    document.removeEventListener("mouseout", pick_mouseout, true);
    document.removeEventListener("click", pick_click, true);
    document.removeEventListener("keydown", pick_keydown, true);

    // Remove highlights
    let highlighted = document.querySelectorAll(".lm-pick-highlight");
    highlighted.forEach(function (el) { el.classList.remove("lm-pick-highlight"); });

    // Remove banner
    if (pickBanner && pickBanner.parentNode) {
        pickBanner.parentNode.removeChild(pickBanner);
    }
    pickBanner = null;
}

function pick_mouseover(e) {
    if (!pickModeActive) return;
    e.target.classList.add("lm-pick-highlight");
}

function pick_mouseout(e) {
    if (!pickModeActive) return;
    e.target.classList.remove("lm-pick-highlight");
}

function pick_click(e) {
    if (!pickModeActive) return;
    e.preventDefault();
    e.stopPropagation();

    let el = e.target;
    let selector = generate_selector(el);
    let displayName = find_label(el) || el.tagName.toLowerCase();
    let currentValue = get_element_value(el);

    // Write result to storage (popup will read on next open)
    chrome.storage.local.get(["lm_pick_state"], function (data) {
        let state = data.lm_pick_state || {};
        state.active = false;
        state.result = {
            selector: selector,
            displayName: displayName,
            currentValue: currentValue
        };
        chrome.storage.local.set({ lm_pick_state: state });
    });

    stop_picking();
}

function pick_keydown(e) {
    if (e.key === "Escape") {
        chrome.storage.local.set({ lm_pick_state: { active: false, result: null } });
        stop_picking();
    }
}

// ── Grab data ───────────────────────────────────────────────
function grab_data(mappings) {
    let profile_data = {
        full_name: "",
        first_name: "",
        last_name: "",
        phone: "",
        email: "",
        birthdate: "",
        address: "",
        address2: "",
        city: "",
        state: "",
        zipcode: ""
    };

    let matchedSelectors = 0;
    let capturedValues = 0;

    for (let fieldKey in mappings) {
        let selector = mappings[fieldKey];
        if (!selector) continue;
        let el = null;
        try { el = document.querySelector(selector); }
        catch (e) { continue; } // stale/invalid saved selector — skip, don't abort the grab
        if (!el) continue;
        matchedSelectors++;
        let val = get_element_value(el);
        if (val && profile_data.hasOwnProperty(fieldKey)) {
            profile_data[fieldKey] = val;
            capturedValues++;
        }
    }

    // Special handling for VanillaSoft DOB via table layout
    if (!profile_data.birthdate && window.location.href.includes("vanillasoft.net")) {
        document.querySelectorAll(".tableInfolabel").forEach(function (info_item) {
            if (info_item.textContent.trim() === "DOB") {
                let next = info_item.nextElementSibling;
                if (next) {
                    let span = next.querySelector(".spanField");
                    if (span) profile_data.birthdate = span.textContent.trim();
                }
            }
        });
        if (!profile_data.birthdate) {
            let dobInput = document.querySelector("input.otherInformationDateTimePicker");
            if (dobInput) profile_data.birthdate = dobInput.value || "";
        }
        if (profile_data.birthdate) capturedValues++;
    }

    // Special handling for Intruity OneLink DOB on Health/Life tab (tab4).
    // Content scripts run in an isolated world: page globals like
    // Show_Tab_Panel are NOT visible here, but the DOM is shared — read the
    // input directly, and fall back to a real DOM click on the tab (synthetic
    // clicks DO trigger the page's own handlers).
    if (!profile_data.birthdate && window.location.href.includes("onelink.intruity.com")) {
        let dobEl = document.querySelector("#DOB, #Applicant_DOB");
        if (dobEl && dobEl.value) {
            profile_data.birthdate = dobEl.value;
            capturedValues++;
        } else {
            let healthTab = document.querySelector("#tab4 a, #tab4");
            if (healthTab) {
                healthTab.click();
                // Wait for the page's tab handler to render, then read DOB and save
                setTimeout(function () {
                    let lateDob = document.querySelector("#Applicant_DOB, #DOB");
                    if (lateDob && lateDob.value) {
                        profile_data.birthdate = lateDob.value;
                        capturedValues++;
                    }
                    finish_grab(profile_data, matchedSelectors, capturedValues);
                }, 250);
                return;
            }
        }
    }

    finish_grab(profile_data, matchedSelectors, capturedValues);
}

// Guard: a grab that captured no values must not overwrite a previously
// grabbed contact in storage with empty strings. This includes the
// matched-but-blank case (AJAX CRMs render inputs before lead data loads,
// and new-lead forms are legitimately empty).
function finish_grab(profile_data, matchedSelectors, capturedValues) {
    if (!capturedValues) {
        chrome.runtime.sendMessage({
            from: "content",
            subject: "grabEmpty",
            matchedSelectors: matchedSelectors
        });
        return;
    }
    save_profile_data(profile_data);
}

function save_profile_data(profile_data) {

    if (profile_data.phone) {
        profile_data.phone = format_phone(profile_data.phone);
    }

    chrome.storage.local.set({
        profile_data: profile_data,
        contact_id: ""
    }, function () {
        chrome.runtime.sendMessage({
            from: "content",
            subject: "loadContactData"
        });
    });
}

function get_element_value(el) {
    if (el.tagName === "SELECT") {
        if (el.selectedIndex < 0) return "";
        let opt = el.options[el.selectedIndex];
        // A selected option with an empty value is a placeholder
        // ("-- Select State --") — not contact data.
        if (!opt || opt.value === "") return "";
        return opt.textContent.trim() || opt.value;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        if (el.type === "checkbox" || el.type === "radio") {
            return el.checked ? el.value : "";
        }
        return el.value || "";
    }
    // For spans, divs, etc.
    return el.textContent.trim();
}

// ── format_phone (preserved from v1.x) ─────────────────────
function format_phone(phone) {
    phone = phone.replace("(", "");
    phone = phone.replace(")", "");
    phone = phone.replace(/-/g, '');
    phone = phone.replace(/\./g, '');
    phone = phone.replace(/  +/g, ' ');
    phone = phone.replace(/ /g, '');
    phone = phone.replace(/^\+/, '');
    phone = phone.trim();
    if (phone.length == 11) {
        phone = "+" + phone;
    } else if (phone.length == 10) {
        phone = "+1" + phone;
    }
    return phone;
}

} // end double-injection guard

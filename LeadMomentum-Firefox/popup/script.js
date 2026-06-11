/* ============================================================
   LeadMomentum Popup v5.7 (Firefox)
   - Field detection + mapping dropdowns
   - Click-to-select via detached window (stays open during pick)
   - Per-domain mapping persistence
   - Existing API key / workflow / tag / phone check preserved
   ============================================================ */

// Maps profile_data keys → GHL survey query parameter names. Array values
// send the same data under multiple keys. Verified June 2026 against the
// live "Everything Survey": GHL's standard hidden Street Address field uses
// query key "address" (not "street_address") — we send both so either
// builder configuration captures it. All other standard hidden fields
// (first_name, last_name, phone, email, date_of_birth, city, state,
// postal_code) match these names exactly.
const SURVEY_PARAM_MAP = {
    first_name: "first_name",
    last_name: "last_name",
    phone: "phone",
    email: "email",
    birthdate: "date_of_birth",
    address: ["street_address", "address"],
    city: "city",
    state: "state",
    zipcode: "postal_code"
};

// Detect if running as a detached pick window (opened via chrome.windows.create)
let urlParams = new URLSearchParams(window.location.search);
let isDetachedWindow = urlParams.has("tabId");

// Tracks the current tab's domain and detected fields
let currentDomain = "";
let currentTabId = null;
let currentFrameId = 0;       // frame hosting the richest form (iframe CRMs)
let detectedFields = [];
let currentSurveyUrl = "";
let localPickActive = false;  // mirror of lm_pick_state.active for unload cleanup

// ── Message listener (from background + content) ────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if ((msg.from === 'content') && (msg.subject === 'loadContactData')) {
        sendResponse({});
        load_contact_data();
    }

    if ((msg.from === 'background') && (msg.subject === 'contactCreated')) {
        sendResponse({});
        show_toast("Contact created successfully", 2500);

        // Auto-refresh survey with fresh form for next submission
        chrome.storage.local.get(['profile_data'], function (data) {
            let profile = data.profile_data || {};
            refresh_survey_iframe(profile);
        });
    }

    if ((msg.from === 'background') && (msg.subject === 'workflowAdded')) {
        sendResponse({});
        show_toast("Workflow added successfully", 2500);
    }

    if ((msg.from === 'background') && (msg.subject === 'contactFailed')) {
        sendResponse({});
        show_send_error("Contact NOT created: " + (msg.message || ("error " + msg.status)));
        consume_send_result();
    }

    if ((msg.from === 'background') && (msg.subject === 'workflowFailed')) {
        sendResponse({});
        show_toast("Workflow NOT added: " + (msg.message || ("error " + msg.status)), 6000);
        consume_send_result();
    }

    if ((msg.from === 'background') && (msg.subject === 'tagFailed')) {
        sendResponse({});
        show_toast("Tag NOT added: " + (msg.message || ("error " + msg.status)), 6000);
        consume_send_result();
    }

    if ((msg.from === 'content') && (msg.subject === 'grabEmpty')) {
        sendResponse({});
        if (msg.matchedSelectors) {
            show_mapping_status("No data captured — the form fields are empty. Previous contact kept.");
        } else {
            show_mapping_status("No data captured — check your field mappings and rescan.");
        }
    }

    // Icon clicked while this window is open: rebind to the user's current tab
    if ((msg.from === 'background') && (msg.subject === 'retarget')) {
        sendResponse({});
        // A pick on the old tab must not survive the rebind — it would
        // strand that page in pick mode and save the picked selector under
        // the new tab's domain.
        if (localPickActive && currentTabId) {
            chrome.tabs.sendMessage(currentTabId, { subject: "cancelPicking" }, { frameId: currentFrameId }, function () {
                void chrome.runtime.lastError;
            });
            chrome.storage.local.remove("lm_pick_state");
            localPickActive = false;
        }
        currentTabId = msg.tabId;
        currentDomain = msg.domain || "";
        scan_page();
    }
});

// Toast container sits OUTSIDE #wrapper so send/workflow outcomes stay
// visible when the survey view auto-shows (which hides #wrapper).
// Keeps id="notification_message" on the message element for compatibility.
function show_toast(message, ms) {
    $("#notification_message").remove();
    $('<p id="notification_message"></p>')
        .text(message || "")
        .appendTo("#lm_toast");
    setTimeout(function () { $("#notification_message").remove(); }, ms || 4000);
}

function show_send_error(message) {
    show_toast(message || "Send failed.", 6000);
}

// A failure already shown live must not be re-shown on the next popup open.
function consume_send_result() {
    chrome.storage.local.remove("lm_last_send_result");
}

// ── Document ready ──────────────────────────────────────────
$(document).ready(function () {

    load_api_keys();
    load_survey_url();

    // Close button
    $("#close_btn").click(function () {
        window.close();
        return false;
    });

    // Get active tab, then trigger field detection
    if (isDetachedWindow) {
        // Opened as detached window — tab ID passed via URL params
        currentTabId = parseInt(urlParams.get("tabId"), 10);
        if (isNaN(currentTabId)) {
            show_mapping_status("Invalid tab ID.");
            return;
        }
        currentDomain = urlParams.get("domain") || "";
        // The anchored-branch chrome:// guard never runs in detached mode —
        // check the target tab here too so we don't attempt injection into
        // browser-internal pages. If the URL is unreadable, proceed; the
        // injection failure path already reports cleanly.
        chrome.tabs.get(currentTabId, function (tab) {
            void chrome.runtime.lastError;
            let url = tab && tab.url;
            if (url && /^(chrome|chrome-extension|about|moz-extension|edge):/.test(url)) {
                show_mapping_status("Cannot scan this page.");
                return;
            }
            check_pick_result(function () {
                scan_page(); // scan_page injects the content script itself
            });
            // Pick handed off from an anchored popup (Firefox: the anchored
            // popup dies the moment the detached window opens, so it cannot
            // reliably send startPicking itself — this window starts it).
            let pickField = urlParams.get("pickField");
            if (pickField) {
                localPickActive = true;
                inject_content_script(currentTabId, function () {
                    chrome.tabs.sendMessage(currentTabId, {
                        subject: "startPicking",
                        fieldKey: pickField
                    }, { frameId: currentFrameId });
                });
            }
        });
    } else {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (!tabs || !tabs[0]) {
                show_mapping_status("No active tab found.");
                return;
            }

            let tab = tabs[0];
            currentTabId = tab.id;

            // Can't inject into browser-internal or extension pages
            if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")
                || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension://")) {
                show_mapping_status("Cannot scan this page.");
                return;
            }

            try {
                currentDomain = new URL(tab.url).hostname;
            } catch (e) {
                currentDomain = "";
            }

            check_pick_result(function () {
                scan_page(); // scan_page injects the content script itself
            });
        });
    }

    // Restore a previously grabbed contact and surface any send result the
    // user missed while the popup was closed.
    chrome.storage.local.get(["profile_data", "lm_last_send_result"], function (data) {
        let p = data.profile_data;
        if (p && Object.keys(p).some(function (k) { return p[k]; })) {
            load_contact_data(true); // true = don't auto-switch to the survey view
        }
        let res = data.lm_last_send_result;
        if (res) {
            // Show-once: surface a recent failure the user missed, then
            // always clear the entry (stale and ok entries must not linger).
            if (!res.ok && (Date.now() - (res.ts || 0)) < 120000) {
                show_send_error(res.message);
            }
            chrome.storage.local.remove("lm_last_send_result");
        }
    });

    // Clean up orphaned pick state when the window closes mid-pick.
    // Note: async storage.get callbacks don't run during unload, so we rely
    // on the locally tracked localPickActive flag and fire the calls directly.
    window.addEventListener("beforeunload", function () {
        if (localPickActive) {
            chrome.storage.local.remove("lm_pick_state");
            chrome.tabs.sendMessage(currentTabId, { subject: "cancelPicking" }, { frameId: currentFrameId });
        }
    });

    // ── Rescan button ───────────────────────────────────────
    $("#rescan_btn").click(function () {
        scan_page();
        return false;
    });

    // ── Grab Data button ────────────────────────────────────
    $("#grab_data_btn").click(function () {
        let mappings = collect_mappings();
        // Re-inject first: navigation destroys the content script, and the
        // double-injection guard makes this idempotent. Re-pick the frame
        // too — navigation also renumbers frames, so a frameId captured by
        // the last scan can point at a frame that no longer exists.
        inject_content_script(currentTabId, function () {
            pick_best_frame(function () {
                chrome.tabs.sendMessage(currentTabId, {
                    subject: "grabData",
                    mappings: mappings
                }, { frameId: currentFrameId }, function (response) {
                    if (chrome.runtime.lastError || !response) {
                        show_mapping_status("Grab failed — click Scan and try again.");
                        return;
                    }
                    if (response.status === "error") {
                        show_mapping_status("Grab error: " + response.error);
                    }
                });
            });
        });
        return false;
    });

    // ── Save Mapping button ─────────────────────────────────
    $("#save_mapping_btn").click(function () {
        if (!currentDomain) return false;
        let mappings = collect_mappings();
        save_domain_mapping(currentDomain, mappings);
        show_mapping_status("Mapping saved for " + currentDomain);
        return false;
    });

    // ── Clear Mapping button ────────────────────────────────
    $("#clear_mapping_btn").click(function () {
        if (!currentDomain) return false;
        clear_domain_mapping(currentDomain);
        // Reset all dropdowns to empty
        $("#mapping_table .mapping_dd").val("");
        $(".field_preview").text("");
        show_mapping_status("Mapping cleared for " + currentDomain);
        return false;
    });

    // ── Pick buttons ────────────────────────────────────────
    $("#mapping_table").on("click", ".pick_btn", function () {
        let row = $(this).closest("tr");
        let fieldKey = row.data("field");

        chrome.storage.local.set({
            lm_pick_state: { active: true, fieldKey: fieldKey, domain: currentDomain, result: null }
        }, function () {
            if (isDetachedWindow) {
                localPickActive = true;
                inject_content_script(currentTabId, function () {
                    chrome.tabs.sendMessage(currentTabId, {
                        subject: "startPicking",
                        fieldKey: fieldKey
                    }, { frameId: currentFrameId });
                });
            } else {
                // Anchored popup (Firefox default_popup, or a tab): it dies
                // as soon as the detached window takes focus, so injecting
                // and messaging from here is a race that can silently lose
                // the startPicking send. Hand the pick to the detached
                // window via URL param — it owns the whole lifecycle.
                let detachedUrl = chrome.runtime.getURL("popup/index.html")
                    + "?tabId=" + currentTabId
                    + "&domain=" + encodeURIComponent(currentDomain)
                    + "&pickField=" + encodeURIComponent(fieldKey);
                chrome.windows.create({
                    url: detachedUrl,
                    type: "popup",
                    width: 500,
                    height: 700
                });
            }
        });
        return false;
    });

    // ── Dropdown change → update preview ────────────────────
    $("#mapping_table").on("change", ".mapping_dd", function () {
        let row = $(this).closest("tr");
        let selector = $(this).val();
        let preview = row.find(".field_preview");
        if (selector) {
            let field = find_field_by_selector(selector);
            preview.text(field ? field.currentValue : "");
        } else {
            preview.text("");
        }
    });

    // ── Existing handlers (unchanged) ───────────────────────

    $("#save_api_key").click(function () {
        let api_key = $('#api_key').val().trim();
        let api_name = $('#api_name').val().trim();
        let location_id = $('#location_id').val().trim();
        if (api_key && api_name && location_id) {
            chrome.storage.local.get(['api_keys', 'selected_api_key', 'selected_location_id'], function (data) {
                let api_keys = [];
                let selected_api_key = '';
                let selected_location_id = '';
                if (data['api_keys'] && (data['api_keys'] != 'undefined'))
                    api_keys = data['api_keys'];
                if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
                    selected_api_key = data['selected_api_key'];
                if (data['selected_location_id'] && (data['selected_location_id'] != 'undefined'))
                    selected_location_id = data['selected_location_id'];

                api_keys.push([api_name, api_key, location_id]);

                if (!selected_api_key) {
                    selected_api_key = api_key;
                    selected_location_id = location_id;
                }

                chrome.storage.local.set({
                    api_keys: api_keys,
                    selected_api_key: selected_api_key,
                    selected_location_id: selected_location_id
                }, function () {
                    $("#api_key_box input").val("");
                    load_api_keys();
                });
            });
        }
        return false;
    });

    $("#select_api_key").click(function () {
        let selected_api_key = $("#api_keys_dd").val();
        let selected_location_id = $("#api_keys_dd option:selected").data('location-id') || '';
        chrome.storage.local.set({
            selected_api_key: selected_api_key,
            selected_location_id: selected_location_id
        }, function () {
            fetch_workflows_and_tags();
            // .text(), never string-HTML: the account name is user input
            show_toast($("#api_keys_dd option:selected").text() + " account selected", 2500);
        });
        return false;
    });

    $("#send_to_leadmomentum").click(function () {
        $("#notification_message").remove();
        let tag = $("#tags_dd").val();
        chrome.runtime.sendMessage({
            from: 'popup',
            subject1: 'makeApiCall',
            subject2: 'sendToLeadmomentum',
            tag: tag
        });
        return false;
    });

    $("#add_to_workflow").click(function () {
        $("#notification_message").remove();
        let workflow_id = $("#workflows_dd").val();
        if (!workflow_id) {
            show_toast("Select a workflow first. If the list is empty, verify your API key has workflow access.", 4000);
            return false;
        }
        let tag = $("#tags_dd").val();
        chrome.runtime.sendMessage({
            from: 'popup',
            subject1: 'makeApiCall',
            subject2: 'addWorkflow',
            workflow_id: workflow_id,
            tag: tag
        });
        return false;
    });

    $("#check_phone").click(function () {
        let landlinescrubber_api_key = $("#landlinescrubber_api_key").val();
        chrome.storage.local.set({
            landlinescrubber_api_key: landlinescrubber_api_key
        }, function () {
            let phone = $("#phone_for_check").val();
            $.ajax({
                url: "https://api.landlinescrubber.com/api/check_number"
                    + "?p=" + encodeURIComponent(phone)
                    + "&k=" + encodeURIComponent(landlinescrubber_api_key),
                method: "GET",
                success: function (response) {
                    let dnc = "no";
                    if (response["blacklist"] === true) {
                        dnc = "yes";
                    }
                    $("#dnc").text(dnc);

                    let linetype = "";
                    if (response["linetype"]) {
                        linetype = response["linetype"];
                    }
                    $("#linetype").text(linetype);
                },
                error: function (xhr) {
                    $("#dnc").text("");
                    $("#linetype").text("check failed (" + (xhr.status || "network error") + ")");
                }
            });
        });
        return false;
    });

    // ── Save Survey URL button ────────────────────────────────
    $("#save_survey_url").click(function () {
        let url = $("#survey_url").val().trim();
        if (!url) {
            $("#survey_status").text("Please enter a survey URL.");
            return false;
        }
        try {
            let parsed = new URL(url);
            if (parsed.protocol !== "https:") {
                $("#survey_status").text("Survey URL must use https://");
                return false;
            }
        } catch (e) {
            $("#survey_status").text("Invalid URL.");
            return false;
        }
        chrome.storage.local.set({ survey_url: url }, function () {
            $("#survey_status").text("Survey URL saved.");
            setTimeout(function () { $("#survey_status").text(""); }, 2500);
        });
        return false;
    });

    // ── Open Survey button ────────────────────────────────────
    $("#open_survey_btn").click(function () {
        chrome.storage.local.get(["survey_url", "profile_data"], function (data) {
            let baseUrl = data.survey_url;
            if (!baseUrl) {
                $("#survey_status").text("No survey URL saved. Paste one and click Save URL.");
                return;
            }

            let profile = data.profile_data || {};

            // If only full_name is set, split into first/last
            if (profile.full_name && !profile.first_name && !profile.last_name) {
                let nameParts = profile.full_name.trim().split(/\s+/);
                profile.first_name = nameParts.shift() || "";
                profile.last_name = nameParts.join(" ") || "";
            }

            let surveyUrl;
            try {
                surveyUrl = new URL(baseUrl);
                if (surveyUrl.protocol !== "https:") {
                    $("#survey_status").text("Survey URL must use https://");
                    return;
                }
            } catch (e) {
                $("#survey_status").text("Saved survey URL is invalid.");
                return;
            }
            apply_survey_params(surveyUrl, profile);

            currentSurveyUrl = surveyUrl.href;
            $("#survey_frame").attr("src", currentSurveyUrl);
            $("#wrapper").hide();
            $("#survey_frame_container").show();
        });
        return false;
    });

    // ── Survey iframe: Back button ───────────────────────────
    $("#survey_back_btn").click(function () {
        $("#survey_frame").attr("src", "about:blank");
        currentSurveyUrl = "";
        $("#survey_frame_container").hide();
        $("#wrapper").show();
        return false;
    });

    // ── Survey iframe: Open in Tab fallback ──────────────────
    $("#survey_open_tab_btn").click(function () {
        if (currentSurveyUrl) {
            chrome.tabs.create({ url: currentSurveyUrl });
        }
        return false;
    });
});

// ── Inject content script on demand ──────────────────────────
// Tries all frames first (covers iframe-hosted CRM forms); if that fails
// (e.g. activeTab on a page with cross-origin iframes), falls back to the
// top frame only. The double-injection guard in content.js makes repeated
// calls safe, so callers re-inject before every scan/grab/pick.
function inject_content_script(tabId, callback) {
    chrome.scripting.insertCSS({
        target: { tabId: tabId, allFrames: true },
        files: ["style.css"]
    }).catch(function () {
        return chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ["style.css"]
        });
    }).catch(function (err) { console.warn("LeadMomentum: insertCSS failed:", err); });

    chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ["jquery.min.js", "content.js"]
    }).then(function () {
        callback();
    }).catch(function () {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ["jquery.min.js", "content.js"]
        }).then(function () {
            callback();
        }).catch(function (err) {
            console.warn("LeadMomentum: executeScript failed:", err);
            show_mapping_status("Cannot inject into this page.");
        });
    });
}

// ── Pick the frame with the most form fields ────────────────
// The count must mirror detect_fields' filter (visible, text-bearing
// fields only) — counting raw inputs lets a chat-widget iframe full of
// hidden inputs outscore the actual lead form. Ties prefer the top frame.
function pick_best_frame(callback) {
    chrome.scripting.executeScript({
        target: { tabId: currentTabId, allFrames: true },
        func: function () {
            let count = 0;
            document.querySelectorAll("input, select, textarea").forEach(function (el) {
                if (el.type === "hidden" || el.type === "password" || el.type === "submit"
                    || el.type === "button" || el.type === "reset" || el.type === "checkbox"
                    || el.type === "radio" || el.type === "file" || el.type === "image") return;
                if (!el.offsetParent && el.style.position !== "fixed") return;
                count++;
            });
            return count;
        }
    }).then(function (results) {
        let best = { frameId: 0, count: -1 };
        (results || []).forEach(function (r) {
            let count = r.result || 0;
            if (count > best.count || (count === best.count && r.frameId === 0)) {
                best = { frameId: r.frameId, count: count };
            }
        });
        currentFrameId = best.frameId;
        callback();
    }).catch(function () {
        currentFrameId = 0;
        callback();
    });
}

// ── Scan page for fields ────────────────────────────────────
let scanInFlight = false; // live pick results are buffered while true

function scan_page() {
    if (!currentTabId) return;
    show_mapping_status("Scanning...");
    scanInFlight = true;
    // Always re-inject: navigation destroys the content script, and the
    // injection guard makes this idempotent.
    inject_content_script(currentTabId, function () {
        pick_best_frame(function () {
            send_detect_fields(0);
        });
    });
}

// Every scan exit path must run this: a pick completed during the scan (or
// pending from a closed window) would otherwise be wiped by the dropdown
// rebuild — or dropped entirely when the scan fails.
function finish_scan_attempt() {
    scanInFlight = false;
    if (pendingPickResult) {
        apply_pick_result(pendingPickResult.fieldKey, pendingPickResult.result);
        pendingPickResult = null;
    }
}

function send_detect_fields(retryCount) {
    chrome.tabs.sendMessage(currentTabId, { subject: "detectFields" }, { frameId: currentFrameId }, function (response) {
        if (chrome.runtime.lastError) {
            let errorMessage = chrome.runtime.lastError.message || "";
            // Content script may not have registered its listener yet — retry after a delay
            if (retryCount < 3) {
                setTimeout(function () { send_detect_fields(retryCount + 1); }, 300);
            } else {
                if (errorMessage.includes("before a response was received")) {
                    show_mapping_status("No fields detected on this page.");
                } else {
                    show_mapping_status("Cannot scan this page (content script not loaded).");
                }
                finish_scan_attempt();
            }
            return;
        }
        if (!response || !response.fields) {
            show_mapping_status("No fields detected.");
            finish_scan_attempt();
            return;
        }
        if (response.error) {
            show_mapping_status("Scan error: " + response.error);
            finish_scan_attempt();
            return;
        }

        detectedFields = response.fields;
        let autoMap = response.autoMap || {};

        populate_dropdowns(detectedFields);

        // Try loading saved mapping first, fall back to auto-map
        load_saved_mapping(currentDomain, function (savedMapping) {
            if (savedMapping) {
                apply_mapping(savedMapping);
                show_mapping_status(detectedFields.length + " fields found. Saved mapping loaded.");
            } else {
                apply_mapping(autoMap);
                let mapped = Object.keys(autoMap).length;
                show_mapping_status(detectedFields.length + " fields found, " + mapped + " auto-mapped.");
            }
            // Apply a pick completed while this window was closed or while
            // the scan was in flight — after the dropdown rebuild, so
            // populate_dropdowns can't wipe it.
            finish_scan_attempt();
        });
    });
}

// ── Populate dropdowns with detected fields ─────────────────
// Options are built via the DOM (never string-concatenated HTML): selectors
// like input[name="phone"] contain double quotes that corrupt a concatenated
// value attribute, silently truncating the stored selector.
function populate_dropdowns(fields) {
    $("#mapping_table .mapping_dd").each(function () {
        let dd = $(this);
        dd.empty();
        dd.append($("<option>").val("").text("— none —"));
        for (let i = 0; i < fields.length; i++) {
            let f = fields[i];
            let display = f.label || f.name || f.id || f.placeholder || f.selector;
            // Truncate long labels
            if (display.length > 40) display = display.substring(0, 37) + "...";
            let valHint = f.currentValue ? " [" + f.currentValue.substring(0, 20) + "]" : "";
            dd.append($("<option>").val(f.selector).text(display + valHint));
        }
    });
}

// ── Apply a mapping object to the dropdowns ─────────────────
function apply_mapping(mapping) {
    for (let fieldKey in mapping) {
        let selector = mapping[fieldKey];
        if (!selector) continue;
        let row = $('#mapping_table tr[data-field="' + fieldKey + '"]');
        if (row.length) {
            let dd = row.find(".mapping_dd");
            dd.val(selector);
            if (dd.val() !== selector) {
                // Saved/picked selector isn't among the detected fields (element
                // hidden at scan time, or a picked span/div) — add it instead of
                // silently dropping the mapping.
                dd.append($("<option>").val(selector).text(selector));
                dd.val(selector);
                detectedFields.push({
                    selector: selector, label: selector,
                    name: "", id: "", placeholder: "",
                    tagName: "", type: "", currentValue: ""
                });
            }
            let field = find_field_by_selector(selector);
            row.find(".field_preview").text(field ? field.currentValue : "");
        }
    }
}

// ── Collect current dropdown selections into a mapping ──────
function collect_mappings() {
    let mappings = {};
    $("#mapping_table tbody tr").each(function () {
        let fieldKey = $(this).data("field");
        let selector = $(this).find(".mapping_dd").val();
        if (fieldKey && selector) {
            mappings[fieldKey] = selector;
        }
    });
    return mappings;
}

// ── Find a detected field by its selector ───────────────────
function find_field_by_selector(selector) {
    for (let i = 0; i < detectedFields.length; i++) {
        if (detectedFields[i].selector === selector) return detectedFields[i];
    }
    return null;
}

// ── Show status text below the Contact heading ──────────────
function show_mapping_status(text) {
    $("#mapping_status").text(text);
}

// ── Apply a pick result to the UI ────────────────────────────
function apply_pick_result(fieldKey, result) {
    let row = $('#mapping_table tr[data-field="' + fieldKey + '"]');
    if (row.length) {
        let dd = row.find(".mapping_dd");
        let exists = dd.find("option").filter(function () {
            return this.value === result.selector;
        }).length > 0;
        if (!exists) {
            let display = result.displayName || result.selector;
            let valHint = result.currentValue ? " [" + result.currentValue.substring(0, 20) + "]" : "";
            dd.append($("<option>").val(result.selector).text(display + valHint));
            detectedFields.push({
                selector: result.selector,
                label: result.displayName,
                name: "", id: "", placeholder: "",
                tagName: "", type: "",
                currentValue: result.currentValue || ""
            });
        }
        dd.val(result.selector);
        row.find(".field_preview").text(result.currentValue || "");
        show_mapping_status("Picked element applied to " + fieldKey.replace(/_/g, " ") + ".");
    }
}

// ── Listen for live pick completion (detached window) ────────
chrome.storage.onChanged.addListener(function (changes) {
    if (changes.lm_pick_state) {
        let state = changes.lm_pick_state.newValue;
        // Mirror both ways: an externally started pick (anchored-popup
        // handoff) must set the flag too, or this window's unload cleanup
        // never cancels the page's pick mode.
        localPickActive = !!(state && state.active);
        if (state && !state.active && state.result && state.fieldKey) {
            if (scanInFlight) {
                // Applying now would be wiped by the imminent dropdown
                // rebuild — buffer it for finish_scan_attempt.
                pendingPickResult = { fieldKey: state.fieldKey, result: state.result };
            } else {
                apply_pick_result(state.fieldKey, state.result);
            }
            chrome.storage.local.remove("lm_pick_state");
        }
    }
});

// ── Check for pending pick result (from previous session) ────
let pendingPickResult = null; // applied by finish_scan_attempt on every scan exit path

function check_pick_result(callback) {
    chrome.storage.local.get(["lm_pick_state"], function (data) {
        let state = data.lm_pick_state;
        if (state && state.active) {
            // Adopt an in-progress pick so this window's unload cleanup
            // owns it (otherwise closing mid-pick wedges the page in pick
            // mode and the eventual click lands as a ghost result).
            localPickActive = true;
        }
        if (state && !state.active && state.result && state.fieldKey) {
            pendingPickResult = { fieldKey: state.fieldKey, result: state.result };
            chrome.storage.local.remove("lm_pick_state", function () {
                callback();
            });
            return;
        }
        callback();
    });
}

// ── Domain mapping persistence ──────────────────────────────
function save_domain_mapping(domain, mappings) {
    chrome.storage.local.get(["lm_domain_mappings"], function (data) {
        let all = data.lm_domain_mappings || {};
        all[domain] = mappings;
        chrome.storage.local.set({ lm_domain_mappings: all });
    });
}

function load_saved_mapping(domain, callback) {
    chrome.storage.local.get(["lm_domain_mappings"], function (data) {
        let all = data.lm_domain_mappings || {};
        callback(all[domain] || null);
    });
}

function clear_domain_mapping(domain) {
    chrome.storage.local.get(["lm_domain_mappings"], function (data) {
        let all = data.lm_domain_mappings || {};
        delete all[domain];
        chrome.storage.local.set({ lm_domain_mappings: all });
    });
}

// ── Survey URL persistence ───────────────────────────────────

function load_survey_url() {
    chrome.storage.local.get(["survey_url"], function (data) {
        if (data.survey_url) {
            $("#survey_url").val(data.survey_url);
        }
    });
}

// ── Fetch workflows and tags from background ─────────────────

function fetch_workflows_and_tags() {
    chrome.runtime.sendMessage({
        from: 'popup',
        subject1: 'makeApiCall',
        subject2: 'getWorkflowsAndTags'
    }, function (response) {
        if (chrome.runtime.lastError || !response) {
            show_toast("Failed to load tags/workflows. Check your API key.", 4000);
            return;
        }
        // ALWAYS rebuild both dropdowns with whatever arrived — even empty
        // arrays. Returning early on error left the previous account's
        // workflows/tags in the UI, and a partial failure (workflows scope
        // missing, tags fine) used to blank both halves.
        load_workflows(response.workflows || []);
        load_tags(response.tags || []);

        if (response.error) {
            let errorMsg;
            if (response.error === 'missing-location-id') {
                errorMsg = 'Location ID is missing. Re-add your account with a Location ID.';
            } else if (response.error === 'no-api-key') {
                errorMsg = 'No account selected. Add and select an API key below.';
            } else {
                let parts = [];
                if (response.workflowsError) parts.push('workflows: ' + response.workflowsError);
                if (response.tagsError) parts.push('tags: ' + response.tagsError);
                let detail = parts.length ? parts.join(', ') : response.error;
                errorMsg = 'API error (' + detail + '). Verify your API key and Location ID are valid.';
            }
            show_toast(errorMsg, 4000);
        }
    });
}

// ── Existing functions (unchanged) ──────────────────────────

function load_api_keys() {
    let existingApiDD = $("#api_keys_dd");
    if (existingApiDD.length && existingApiDD.data('select2')) existingApiDD.select2('destroy');
    existingApiDD.remove();
    $('<select id="api_keys_dd"></select>').insertBefore($("#select_api_key"));
    chrome.storage.local.get(['api_keys', 'selected_api_key', 'selected_location_id', 'landlinescrubber_api_key'], function (data) {
        let api_keys = [];
        let selected_api_key = '';
        let selected_location_id = '';
        let landlinescrubber_api_key = '';
        if (data['api_keys'] && (data['api_keys'] != 'undefined'))
            api_keys = data['api_keys'];
        if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
            selected_api_key = data['selected_api_key'];
        if (data['selected_location_id'] && (data['selected_location_id'] != 'undefined'))
            selected_location_id = data['selected_location_id'];
        if (data['landlinescrubber_api_key'] && (data['landlinescrubber_api_key'] != 'undefined'))
            landlinescrubber_api_key = data['landlinescrubber_api_key'];

        $("#landlinescrubber_api_key").val(landlinescrubber_api_key);

        // Clear any previous setup notices
        $(".lm-setup-notice").remove();

        for (let i = 0; i < api_keys.length; i++) {
            // DOM-built, never string-concatenated: the account name is
            // user input (HTML injection) and keys/names containing quotes
            // would truncate a concatenated value attribute.
            $("#api_keys_dd").append(
                $("<option>")
                    .val(api_keys[i][1])
                    .attr("data-location-id", api_keys[i][2] || '')
                    .text(api_keys[i][0])
            );
        }

        if (!api_keys.length) {
            // No accounts configured at all
            $("#api_key_box").prepend(
                '<p class="lm-setup-notice">Add your API Name, API Key (Private Integration Token), and Location ID below, then click Add and Select.</p>'
            );
            $("#tags_box").prepend('<p class="lm-setup-notice">Add an API key below to load tags.</p>');
            $("#workflows_box").prepend('<p class="lm-setup-notice">Add an API key below to load workflows.</p>');
        } else if (!selected_api_key) {
            // Accounts exist but none selected
            $("#api_key_box").prepend(
                '<p class="lm-setup-notice">Select an account below to load workflows and tags.</p>'
            );
            $("#tags_box").prepend('<p class="lm-setup-notice">Select an account to load tags.</p>');
            $("#workflows_box").prepend('<p class="lm-setup-notice">Select an account to load workflows.</p>');
        } else {
            fetch_workflows_and_tags();
            $("#api_keys_dd").val(selected_api_key);
        }

        selectize_dd($("#api_keys_dd"));
    });
}

function load_workflows(workflows) {
    let existingWfDD = $("#workflows_dd");
    if (existingWfDD.length && existingWfDD.data('select2')) existingWfDD.select2('destroy');
    existingWfDD.remove();
    $('<select id="workflows_dd"></select>').insertBefore($("#add_to_workflow"));
    for (let i = 0; i < workflows.length; i++) {
        $("#workflows_dd").append(
            $("<option>").val(workflows[i]["id"]).text(workflows[i]["name"])
        );
    }
    // Selectize even when empty — skipping it left a bare native select
    // after switching to an account with no workflows.
    selectize_dd($("#workflows_dd"));
}

function load_tags(tags) {
    let existingTagDD = $("#tags_dd");
    if (existingTagDD.length && existingTagDD.data('select2')) existingTagDD.select2('destroy');
    existingTagDD.remove();
    $('<select id="tags_dd"><option value=""></option></select>').insertBefore($("#send_to_leadmomentum"));
    for (let i = 0; i < tags.length; i++) {
        $("#tags_dd").append(
            $("<option>").val(tags[i]["name"]).text(tags[i]["name"])
        );
    }
    // Selectize even when empty — see load_workflows.
    selectize_dd($("#tags_dd"));
}

function load_contact_data(skipSurveyAutoShow) {
    chrome.storage.local.get(['profile_data'], function (data) {
        let profile_data = {};
        if (data['profile_data'] && (data['profile_data'] != 'undefined'))
            profile_data = data['profile_data'];

        // Show the contact preview section
        $("#contact_preview").show();

        $("#full_name").text(profile_data["full_name"]);
        $("#first_name").text(profile_data["first_name"]);
        $("#last_name").text(profile_data["last_name"]);
        $("#phone").text(profile_data["phone"]);
        $("#email").text(profile_data["email"]);
        $("#address1").text(profile_data["address"]);
        $("#address2").text(profile_data["address2"]);
        $("#city").text(profile_data["city"]);
        $("#state").text(profile_data["state"]);
        $("#zipcode").text(profile_data["zipcode"]);
        $("#dob").text(profile_data["birthdate"]);

        $("#phone_for_check").val(profile_data["phone"]);

        // Auto-refresh survey with new contact data
        refresh_survey_iframe(profile_data, skipSurveyAutoShow);
    });
}

// Set every mapped query param on the survey URL; array map values send
// the same profile value under each listed key.
function apply_survey_params(surveyUrl, profile) {
    for (let key in SURVEY_PARAM_MAP) {
        let value = profile[key];
        if (!value) continue;
        let paramNames = SURVEY_PARAM_MAP[key];
        if (!Array.isArray(paramNames)) paramNames = [paramNames];
        for (let i = 0; i < paramNames.length; i++) {
            surveyUrl.searchParams.set(paramNames[i], value);
        }
    }
}

function refresh_survey_iframe(profile, skipAutoShow) {
    chrome.storage.local.get(["survey_url"], function (data) {
        let baseUrl = data.survey_url;
        if (!baseUrl) return;

        // Split full_name if needed
        if (profile.full_name && !profile.first_name && !profile.last_name) {
            let nameParts = profile.full_name.trim().split(/\s+/);
            profile.first_name = nameParts.shift() || "";
            profile.last_name = nameParts.join(" ") || "";
        }

        let surveyUrl;
        try {
            surveyUrl = new URL(baseUrl);
            if (surveyUrl.protocol !== "https:") return;
        } catch (e) { return; }

        apply_survey_params(surveyUrl, profile);

        currentSurveyUrl = surveyUrl.href;
        $("#survey_frame").attr("src", currentSurveyUrl);

        // Auto-show survey if not already visible
        if (!skipAutoShow && $("#survey_frame_container").is(":hidden")) {
            $("#wrapper").hide();
            $("#survey_frame_container").show();
        }
    });
}

function selectize_dd(dd_selector) {
    dd_selector.select2();
}

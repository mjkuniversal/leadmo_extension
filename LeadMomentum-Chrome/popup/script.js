/* ============================================================
   LeadMomentum Popup v5.0
   - Field detection + mapping dropdowns
   - Click-to-select via detached window (stays open during pick)
   - Per-domain mapping persistence
   - Existing API key / workflow / tag / phone check preserved
   ============================================================ */

// Maps profile_data keys → GHL survey query parameter names
const SURVEY_PARAM_MAP = {
    first_name: "first_name",
    last_name: "last_name",
    phone: "phone",
    email: "email",
    birthdate: "date_of_birth",
    address: "address1",
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
let detectedFields = [];
let currentSurveyUrl = "";

// ── Message listener (from background + content) ────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if ((msg.from === 'content') && (msg.subject === 'loadContactData')) {
        sendResponse({});
        load_contact_data();
    }

    if ((msg.from === 'background') && (msg.subject === 'contactCreated')) {
        sendResponse({});
        $("#tags_box").prepend('<p id="notification_message">Contact created succesfully</p>');
        setTimeout(function () {
            $("#notification_message").remove();
        }, 2500);
    }

    if ((msg.from === 'background') && (msg.subject === 'workflowAdded')) {
        sendResponse({});
        $("#workflows_box").prepend('<p id="notification_message">Workflow added succesfully</p>');
        setTimeout(function () {
            $("#notification_message").remove();
        }, 2500);
    }
});

// ── Document ready ──────────────────────────────────────────
$(document).ready(function () {

    load_api_keys();
    load_survey_url();

    // Get active tab, then trigger field detection
    if (isDetachedWindow) {
        // Opened as detached window — tab ID passed via URL params
        currentTabId = parseInt(urlParams.get("tabId"), 10);
        if (isNaN(currentTabId)) {
            show_mapping_status("Invalid tab ID.");
            return;
        }
        currentDomain = urlParams.get("domain") || "";
        inject_content_script(currentTabId, function () {
            check_pick_result(function () {
                scan_page();
            });
        });
    } else {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (!tabs || !tabs[0]) {
                show_mapping_status("No active tab found.");
                return;
            }

            let tab = tabs[0];
            currentTabId = tab.id;

            // Can't inject into chrome:// or extension pages
            if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
                show_mapping_status("Cannot scan this page.");
                return;
            }

            try {
                currentDomain = new URL(tab.url).hostname;
            } catch (e) {
                currentDomain = "";
            }

            // Inject content script + CSS on demand, then scan
            inject_content_script(currentTabId, function () {
                check_pick_result(function () {
                    scan_page();
                });
            });
        });
    }

    // Clean up orphaned pick state when detached window closes without picking
    if (isDetachedWindow) {
        window.addEventListener("beforeunload", function () {
            chrome.storage.local.get(["lm_pick_state"], function (data) {
                if (data.lm_pick_state && data.lm_pick_state.active) {
                    chrome.storage.local.remove("lm_pick_state");
                    chrome.tabs.sendMessage(currentTabId, { subject: "cancelPicking" });
                }
            });
        });
    }

    // ── Rescan button ───────────────────────────────────────
    $("#rescan_btn").click(function () {
        scan_page();
        return false;
    });

    // ── Grab Data button ────────────────────────────────────
    $("#grab_data_btn").click(function () {
        let mappings = collect_mappings();
        chrome.tabs.sendMessage(currentTabId, {
            subject: "grabData",
            mappings: mappings
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

    // ── Pick buttons (disabled in detached window to prevent nested windows) ──
    $("#mapping_table").on("click", ".pick_btn", function () {
        if (isDetachedWindow) return false;

        let row = $(this).closest("tr");
        let fieldKey = row.data("field");

        chrome.storage.local.set({
            lm_pick_state: { active: true, fieldKey: fieldKey, domain: currentDomain, result: null }
        }, function () {
            chrome.tabs.sendMessage(currentTabId, {
                subject: "startPicking",
                fieldKey: fieldKey
            });

            if (!isDetachedWindow) {
                // Open a detached window so the UI stays visible during pick
                let detachedUrl = chrome.runtime.getURL("popup/index.html")
                    + "?tabId=" + currentTabId
                    + "&domain=" + encodeURIComponent(currentDomain);
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
            $("#api_key_items").prepend('<p id="notification_message">' + $("#api_keys_dd option:selected").text() + ' account selected</p>');
            setTimeout(function () {
                $("#notification_message").remove();
            }, 2500);
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
                url: "https://api.landlinescrubber.com/api/check_number?p=" + phone + "&k=" + landlinescrubber_api_key,
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
                error: function (xhr, ajaxOptions, thrownError) {
                    alert("Error status:" + xhr.status + "\n" + "Error message:" + thrownError);
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
            for (let key in SURVEY_PARAM_MAP) {
                let value = profile[key];
                if (value) {
                    surveyUrl.searchParams.set(SURVEY_PARAM_MAP[key], value);
                }
            }

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
function inject_content_script(tabId, callback) {
    chrome.scripting.insertCSS({
        target: { tabId: tabId, allFrames: true },
        files: ["style.css"]
    }).catch(function (err) { console.warn("LeadMomentum: insertCSS failed:", err); });

    chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ["jquery.min.js", "content.js"]
    }).then(function () {
        callback();
    }).catch(function (err) {
        console.warn("LeadMomentum: executeScript failed:", err);
        show_mapping_status("Cannot inject into this page.");
    });
}

// ── Scan page for fields ────────────────────────────────────
function scan_page() {
    if (!currentTabId) return;

    show_mapping_status("Scanning...");
    chrome.tabs.sendMessage(currentTabId, { subject: "detectFields" }, function (response) {
        if (chrome.runtime.lastError) {
            show_mapping_status("Cannot scan this page (content script not loaded).");
            return;
        }
        if (!response || !response.fields) {
            show_mapping_status("No fields detected.");
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
        });
    });
}

// ── Populate dropdowns with detected fields ─────────────────
function populate_dropdowns(fields) {
    let options = '<option value="">— none —</option>';
    for (let i = 0; i < fields.length; i++) {
        let f = fields[i];
        let display = f.label || f.name || f.id || f.placeholder || f.selector;
        // Truncate long labels
        if (display.length > 40) display = display.substring(0, 37) + "...";
        let valHint = f.currentValue ? " [" + f.currentValue.substring(0, 20) + "]" : "";
        // Escape HTML
        let safeDisplay = $("<span>").text(display + valHint).html();
        let safeSelector = $("<span>").text(f.selector).html();
        options += '<option value="' + safeSelector + '">' + safeDisplay + '</option>';
    }

    $("#mapping_table .mapping_dd").each(function () {
        $(this).html(options);
    });
}

// ── Apply a mapping object to the dropdowns ─────────────────
function apply_mapping(mapping) {
    for (let fieldKey in mapping) {
        let selector = mapping[fieldKey];
        if (!selector) continue;
        let row = $('#mapping_table tr[data-field="' + fieldKey + '"]');
        if (row.length) {
            row.find(".mapping_dd").val(selector);
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
        if (dd.find('option[value="' + CSS.escape(result.selector) + '"]').length === 0) {
            let display = result.displayName || result.selector;
            let valHint = result.currentValue ? " [" + result.currentValue.substring(0, 20) + "]" : "";
            let safeDisplay = $("<span>").text(display + valHint).html();
            let safeSelector = $("<span>").text(result.selector).html();
            dd.append('<option value="' + safeSelector + '">' + safeDisplay + '</option>');
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
    if (changes.lm_pick_state && changes.lm_pick_state.newValue) {
        let state = changes.lm_pick_state.newValue;
        if (!state.active && state.result && state.fieldKey) {
            apply_pick_result(state.fieldKey, state.result);
            chrome.storage.local.remove("lm_pick_state");
        }
    }
});

// ── Check for pending pick result (from previous session) ────
function check_pick_result(callback) {
    chrome.storage.local.get(["lm_pick_state"], function (data) {
        let state = data.lm_pick_state;
        if (state && !state.active && state.result && state.fieldKey) {
            let fieldKey = state.fieldKey;
            let result = state.result;

            chrome.storage.local.remove("lm_pick_state", function () {
                let originalCallback = callback;
                callback = function () {};
                originalCallback();

                // Wait a tick for scan_page to finish populating
                setTimeout(function () {
                    apply_pick_result(fieldKey, result);
                }, 500);
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
            $("#notification_message").remove();
            $("#tags_box").prepend('<p id="notification_message">Failed to load tags/workflows. Check your API key.</p>');
            setTimeout(function () { $("#notification_message").remove(); }, 4000);
            return;
        }
        if (response.error) {
            $("#notification_message").remove();
            let errorMsg = response.error === 'missing-location-id'
                ? 'Location ID is missing. Re-add your account with a Location ID.'
                : 'API error (' + response.error + '). Verify your API key and Location ID are valid.';
            $('<p id="notification_message"></p>')
                .text(errorMsg)
                .prependTo('#tags_box');
            setTimeout(function () { $("#notification_message").remove(); }, 4000);
            return;
        }
        if (response.workflows) {
            load_workflows(response.workflows);
        }
        if (response.tags) {
            load_tags(response.tags);
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

        for (let i = 0; i < api_keys.length; i++) {
            let locationId = api_keys[i][2] || '';
            let option = '<option value="' + api_keys[i][1] + '" data-location-id="' + locationId + '">' + api_keys[i][0] + '</option>';
            $("#api_keys_dd").append(option);
        }

        if (selected_api_key) {
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
    if (workflows.length) {
        for (let i = 0; i < workflows.length; i++) {
            let option = '<option value="' + workflows[i]["id"] + '">' + workflows[i]["name"] + '</option>';
            $("#workflows_dd").append(option);
        }
        selectize_dd($("#workflows_dd"));
    }
}

function load_tags(tags) {
    let existingTagDD = $("#tags_dd");
    if (existingTagDD.length && existingTagDD.data('select2')) existingTagDD.select2('destroy');
    existingTagDD.remove();
    $('<select id="tags_dd"><option value=""></option></select>').insertBefore($("#send_to_leadmomentum"));
    if (tags.length) {
        for (let i = 0; i < tags.length; i++) {
            let option = '<option value="' + tags[i]["name"] + '">' + tags[i]["name"] + '</option>';
            $("#tags_dd").append(option);
        }
        selectize_dd($("#tags_dd"));
    }
}

function load_contact_data() {
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
    });
}

function selectize_dd(dd_selector) {
    dd_selector.select2();
}

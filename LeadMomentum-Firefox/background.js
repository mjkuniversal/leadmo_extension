const GHL_BASE = "https://services.leadconnectorhq.com";

// Fire-and-forget message to extension pages. Reading lastError in the
// callback prevents "Receiving end does not exist" noise when no popup
// is open (outcomes are also persisted via record_send_result).
function notify_popup(msg) {
    chrome.runtime.sendMessage(msg, function () {
        void chrome.runtime.lastError;
    });
}

// Persist the outcome of the last send so the popup can show a failure the
// user missed while the popup was closed (Firefox's anchored popup closes
// on any blur, so this matters even mid-operation).
function record_send_result(ok, message) {
    chrome.storage.local.set({
        lm_last_send_result: { ok: ok, message: message, ts: Date.now() }
    });
}

function format_api_error(status, body) {
    let msg = body && body.message;
    if (Array.isArray(msg)) msg = msg.join("; ");
    return (msg ? String(msg) : "Unexpected API response") + " (HTTP " + status + ")";
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;
    if ((msg.from === 'popup') && (msg.subject1 === 'makeApiCall')) {
        chrome.storage.local.get(['selected_api_key', 'selected_location_id'], function (data) {
            let selected_api_key = 0;
            let selected_location_id = '';
            if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
                selected_api_key = data['selected_api_key'];
            if (data['selected_location_id'] && (data['selected_location_id'] != 'undefined'))
                selected_location_id = data['selected_location_id'];

            if (selected_api_key) {
                if (msg.subject2 === 'getWorkflowsAndTags') {
                    if (!selected_location_id) {
                        sendResponse({ workflows: [], tags: [], error: 'missing-location-id' });
                        return;
                    }
                    let headers = {
                        'Authorization': 'Bearer ' + selected_api_key,
                        'Content-Type': 'application/json',
                        'Version': '2021-07-28'
                    };
                    Promise.all([
                        fetch(GHL_BASE + "/workflows/?locationId=" + encodeURIComponent(selected_location_id), {
                            headers: headers,
                            method: 'GET'
                        }).then(async response => {
                            if (!response.ok) return { _error: response.status };
                            try { return await response.json(); }
                            catch (e) { return { _error: 'invalid-json' }; }
                        }).catch(() => ({ _error: 'network' })),
                        fetch(GHL_BASE + "/locations/" + encodeURIComponent(selected_location_id) + "/tags", {
                            headers: headers,
                            method: 'GET'
                        }).then(async response => {
                            if (!response.ok) return { _error: response.status };
                            try { return await response.json(); }
                            catch (e) { return { _error: 'invalid-json' }; }
                        }).catch(() => ({ _error: 'network' }))
                    ]).then(([workflowData, tagData]) => {
                        let error = workflowData._error || tagData._error || null;
                        sendResponse({
                            workflows: workflowData['workflows'] || [],
                            tags: tagData['tags'] || [],
                            error: error
                        });
                    }).catch(error => {
                        console.log(error);
                        sendResponse({ workflows: [], tags: [], error: 'unknown' });
                    });
                }

                if (msg.subject2 === 'sendToLeadmomentum') {
                    sendResponse({});
                    let tag = "";
                    if (msg.tag) {
                        tag = msg.tag;
                    }
                    create_contact(tag, "", selected_api_key, selected_location_id);
                }

                if (msg.subject2 === 'addWorkflow') {
                    sendResponse({});
                    let tag = "";
                    if (msg.tag) {
                        tag = msg.tag;
                    }
                    let workflow_id = msg.workflow_id;
                    create_contact(tag, workflow_id, selected_api_key, selected_location_id);
                }
            } else {
                if (msg.subject2 === 'getWorkflowsAndTags') {
                    sendResponse({ workflows: [], tags: [], error: 'no-api-key' });
                } else {
                    sendResponse({});
                    let failMsg = "No account selected — add and select an API key first.";
                    record_send_result(false, failMsg);
                    notify_popup({ from: 'background', subject: 'contactFailed', status: 0, message: failMsg });
                }
            }
        });
        return true; // keep message channel open for async sendResponse
    }
});

function create_contact(tag, workflow_id, selected_api_key, selected_location_id) {
    let tags = [];
    if (tag) {
        tags.push(tag);
    }

    chrome.storage.local.get(['profile_data'], function (data) {
        let profile_data = {}

        if (data['profile_data'] && (data['profile_data'] != 'undefined'))
            profile_data = data['profile_data'];

        // Split full_name into first/last if individual fields are empty
        let firstName = profile_data["first_name"] || "";
        let lastName = profile_data["last_name"] || "";
        if (profile_data["full_name"] && !firstName && !lastName) {
            let nameParts = profile_data["full_name"].trim().split(/\s+/);
            firstName = nameParts.shift() || "";
            lastName = nameParts.join(" ") || "";
        }

        let create_contact_data = {
            "locationId": selected_location_id,
            "firstName": firstName,
            "lastName": lastName,
            "name": profile_data["full_name"] || (firstName + " " + lastName).trim(),
            "email": profile_data["email"],
            "phone": profile_data["phone"],
            "dateOfBirth": profile_data["birthdate"],
            "address1": profile_data["address"],
            "city": profile_data["city"],
            "state": profile_data["state"],
            "country": "US",
            "postalCode": profile_data["zipcode"],
            "tags": tags,
            "source": "public api"
        };

        // GHL v2 validates every field that is PRESENT in the payload: an
        // empty-string email/phone/dateOfBirth fails validation and 422s the
        // whole request. Omit anything empty — locationId is the only
        // required field.
        Object.keys(create_contact_data).forEach(function (key) {
            if (key === "locationId") return;
            let v = create_contact_data[key];
            if (v === "" || v === undefined || v === null
                || (Array.isArray(v) && v.length === 0)) {
                delete create_contact_data[key];
            }
        });

        // Upsert instead of create: GHL locations commonly disallow duplicate
        // contacts, making POST /contacts/ return 400 on every re-send of a
        // known lead. Upsert updates the existing contact and returns its id.
        fetch(GHL_BASE + "/contacts/upsert", {
            headers: {
                'Authorization': 'Bearer ' + selected_api_key,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
            },
            method: 'POST',
            body: JSON.stringify(create_contact_data)
        }).then(async function (response) {
            let responseData = {};
            try { responseData = await response.json(); } catch (e) { }
            if (response.ok && responseData["contact"] && responseData["contact"]["id"]) {
                record_send_result(true, "Contact sent to LeadMomentum");
                notify_popup({ from: 'background', subject: 'contactCreated' });
                if (workflow_id) {
                    add_to_workflow(responseData["contact"]["id"], workflow_id, selected_api_key);
                }
            } else {
                let message = format_api_error(response.status, responseData);
                record_send_result(false, "Contact NOT created: " + message);
                notify_popup({ from: 'background', subject: 'contactFailed', status: response.status, message: message });
            }
        }).catch(function () {
            let message = "Network error — could not reach GoHighLevel.";
            record_send_result(false, "Contact NOT created: " + message);
            notify_popup({ from: 'background', subject: 'contactFailed', status: 0, message: message });
        });
    });
}

function add_to_workflow(contact_id, workflow_id, selected_api_key) {
    let current_datetime = String(new Date().toISOString()).slice(0, 19) + "+00:00";
    let add_workflow_data = { "eventStartTime": current_datetime };
    fetch(GHL_BASE + "/contacts/" + contact_id + "/workflow/" + workflow_id, {
        headers: {
            'Authorization': 'Bearer ' + selected_api_key,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
        },
        method: 'POST',
        body: JSON.stringify(add_workflow_data)
    }).then(async function (response) {
        if (response.ok) {
            record_send_result(true, "Workflow added");
            notify_popup({ from: 'background', subject: 'workflowAdded' });
        } else {
            let body = {};
            try { body = await response.json(); } catch (e) { }
            let message = format_api_error(response.status, body);
            record_send_result(false, "Workflow NOT added: " + message);
            notify_popup({ from: 'background', subject: 'workflowFailed', status: response.status, message: message });
        }
    }).catch(function () {
        let message = "Network error — could not reach GoHighLevel.";
        record_send_result(false, "Workflow NOT added: " + message);
        notify_popup({ from: 'background', subject: 'workflowFailed', status: 0, message: message });
    });
}

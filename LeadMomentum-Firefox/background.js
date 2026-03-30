const GHL_BASE = "https://services.leadconnectorhq.com";

// Open popup as a persistent window instead of browser popup
let popupWindowId = null;

chrome.action.onClicked.addListener(function (tab) {
    // If window already exists, focus it
    if (popupWindowId !== null) {
        chrome.windows.get(popupWindowId, function (win) {
            if (chrome.runtime.lastError || !win) {
                popupWindowId = null;
                openPopupWindow(tab);
            } else {
                chrome.windows.update(popupWindowId, { focused: true });
            }
        });
    } else {
        openPopupWindow(tab);
    }
});

function openPopupWindow(tab) {
    let url = chrome.runtime.getURL("popup/index.html")
        + "?tabId=" + tab.id
        + "&domain=" + encodeURIComponent(new URL(tab.url || "").hostname || "");
    chrome.windows.create({
        url: url,
        type: "popup",
        width: 520,
        height: 750
    }, function (win) {
        popupWindowId = win.id;
    });
}

chrome.windows.onRemoved.addListener(function (windowId) {
    if (windowId === popupWindowId) {
        popupWindowId = null;
    }
});

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
                sendResponse({});
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
            "companyName": "",
            "website": "",
            "tags": tags,
            "source": "public api",
            "customFields": []
        };

        fetch(GHL_BASE + "/contacts/", {
            headers: {
                'Authorization': 'Bearer ' + selected_api_key,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
            },
            method: 'POST',
            body: JSON.stringify(create_contact_data)
        }).then(response => response.json()).then(responseData => {
            if (responseData["contact"] && responseData["contact"]["id"]) {
                if (workflow_id) {
                    add_to_workflow(responseData["contact"]["id"], workflow_id, selected_api_key);
                }

                chrome.runtime.sendMessage({
                    from: 'background',
                    subject: 'contactCreated'
                });
            }

        }).catch(error => {
            console.log(error);
        });
    });
}

function add_to_workflow(contact_id, workflow_id, selected_api_key) {
    let current_datetime = String(new Date().toISOString()).slice(0, 19) + "+00:00";
    let add_workflow_data = {"eventStartTime": current_datetime};
    fetch(GHL_BASE + "/contacts/" + contact_id + "/workflow/" + workflow_id, {
        headers: {
            'Authorization': 'Bearer ' + selected_api_key,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
        },
        method: 'POST',
        body: JSON.stringify(add_workflow_data)
    }).then(response => response.text()).then(() => {
        chrome.runtime.sendMessage({
            from: 'background',
            subject: 'workflowAdded'
        });
    }).catch(error => {
        console.log(error);
    });
}

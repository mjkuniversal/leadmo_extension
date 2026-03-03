chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;
    if ((msg.from === 'popup') && (msg.subject1 === 'makeApiCall')) {
        chrome.storage.local.get(['selected_api_key'], function (data) {
            let selected_api_key = 0;
            if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
                selected_api_key = data['selected_api_key'];

            if (selected_api_key) {
                if (msg.subject2 === 'getWorkflowsAndTags') {
                    let headers = {
                        'Authorization': 'Bearer ' + selected_api_key,
                        'Content-Type': 'application/json'
                    };
                    Promise.all([
                        fetch("https://rest.gohighlevel.com/v1/workflows/", {
                            headers: headers,
                            method: 'GET'
                        }).then(response => response.json()).catch(() => ({})),
                        fetch("https://rest.gohighlevel.com/v1/tags/", {
                            headers: headers,
                            method: 'GET'
                        }).then(response => response.json()).catch(() => ({}))
                    ]).then(([workflowData, tagData]) => {
                        sendResponse({
                            workflows: workflowData['workflows'] || [],
                            tags: tagData['tags'] || []
                        });
                    }).catch(error => {
                        console.log(error);
                        sendResponse({ workflows: [], tags: [] });
                    });
                }

                if (msg.subject2 === 'sendToLeadmomentum') {
                    sendResponse({});
                    let tag = "";
                    if (msg.tag) {
                        tag = msg.tag;
                    }
                    create_contact(tag, "", selected_api_key);
                }

                if (msg.subject2 === 'addWorkflow') {
                    sendResponse({});
                    let tag = "";
                    if (msg.tag) {
                        tag = msg.tag;
                    }
                    let workflow_id = msg.workflow_id;
                    create_contact(tag, workflow_id, selected_api_key);
                }
            } else {
                sendResponse({});
            }
        });
        return true; // keep message channel open for async sendResponse
    }
});

function create_contact(tag, workflow_id, selected_api_key) {
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
            "customField": {
                "__custom_field_id__": ""
            }
        };

        //console.log(create_contact_data);

        fetch("https://rest.gohighlevel.com/v1/contacts/", {
            headers: {
                'Authorization': 'Bearer ' + selected_api_key,
                'Content-Type': 'application/json'
            },
            method: 'POST',
            body: JSON.stringify(create_contact_data)
        }).then(response => response.json()).then(data => {
            //console.log(data);
            if (data["contact"]["id"]) {
                if (workflow_id) {
                    add_to_workflow(data["contact"]["id"], workflow_id, selected_api_key);
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
    fetch("https://rest.gohighlevel.com/v1/contacts/" + contact_id + "/workflow/" + workflow_id, {
        headers: {
            'Authorization': 'Bearer ' + selected_api_key,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify(add_workflow_data)
    }).then(response => response.text()).then(data => {
        chrome.runtime.sendMessage({
            from: 'background',
            subject: 'workflowAdded'
        });
    }).catch(error => {
        console.log(error);
    });
}


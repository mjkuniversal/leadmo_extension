chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if ((msg.from === 'background') && (msg.subject === 'loadWorkflows')) {
        sendResponse({});
        load_workflows(msg.workflows);
    }

    if ((msg.from === 'background') && (msg.subject === 'loadTags')) {
        sendResponse({});
        load_tags(msg.tags);
    }

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

$(document).ready(function () {

    load_api_keys();

    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, function (tabs) {
        chrome.tabs.sendMessage(tabs[0].id, {subject: 'getLeadData'});
    });


    $("#save_api_key").click(function () {
        let api_key = $('#api_key').val().trim();
        let api_name = $('#api_name').val().trim();
        if (api_key && api_name) {
            chrome.storage.local.get(['api_keys', 'selected_api_key'], function (data) {
                let api_keys = [];
                let selected_api_key = '';
                if (data['api_keys'] && (data['api_keys'] != 'undefined'))
                    api_keys = data['api_keys'];
                if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
                    selected_api_key = data['selected_api_key'];

                let api_keys_item = [];
                api_keys_item.push(api_name);
                api_keys_item.push(api_key);
                api_keys.push(api_keys_item);

                if (!selected_api_key) {
                    selected_api_key = api_key;
                }

                chrome.storage.local.set({
                    api_keys: api_keys,
                    selected_api_key: selected_api_key
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
        chrome.storage.local.set({
            selected_api_key: selected_api_key
        }, function () {
            chrome.runtime.sendMessage({
                from: 'popup',
                subject1: 'makeApiCall',
                subject2: 'getWorkflowsAndTags'
            });
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
});

function load_api_keys() {
    $("#api_keys_dd").remove();
    $('<select id="api_keys_dd"></select>').insertBefore($("#select_api_key"));
    chrome.storage.local.get(['api_keys', 'selected_api_key', 'landlinescrubber_api_key'], function (data) {
        let api_keys = [];
        let selected_api_key = '';
        let landlinescrubber_api_key = '';
        if (data['api_keys'] && (data['api_keys'] != 'undefined'))
            api_keys = data['api_keys'];
        if (data['selected_api_key'] && (data['selected_api_key'] != 'undefined'))
            selected_api_key = data['selected_api_key'];
        if (data['landlinescrubber_api_key'] && (data['landlinescrubber_api_key'] != 'undefined'))
            landlinescrubber_api_key = data['landlinescrubber_api_key'];

        $("#landlinescrubber_api_key").val(landlinescrubber_api_key);

        for (let i = 0; i < api_keys.length; i++) {
            let option = '<option value="' + api_keys[i][1] + '">' + api_keys[i][0] + '</option>';
            $("#api_keys_dd").append(option);
        }

        if (selected_api_key) {
            chrome.runtime.sendMessage({
                from: 'popup',
                subject1: 'makeApiCall',
                subject2: 'getWorkflowsAndTags'
            });
            $("#api_keys_dd").val(selected_api_key);
        }

        selectize_dd($("#api_keys_dd"));
    });
}

function load_workflows(workflows) {
    $("#workflows_dd").remove();
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
    $("#tags_dd").remove();
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
        let profile_data = {}
        if (data['profile_data'] && (data['profile_data'] != 'undefined'))
            profile_data = data['profile_data'];

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
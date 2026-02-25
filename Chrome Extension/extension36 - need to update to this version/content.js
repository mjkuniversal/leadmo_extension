chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return;

    if ((msg.subject === 'getLeadData')) {

        sendResponse({status: "yes"});

        let first_name = "";
        let last_name = "";
        let phone = "";
        let email = "";
        let birthdate = "";
        let address = "";
        let address2 = "";
        let city = "";
        let state = "";
        let zipcode = "";

        let current_url = window.location.href;

        if (current_url.includes("vanillasoft.net")) {
            first_name = $("#FirstName").val();
            last_name = $("#LastName").val();
            phone = $('[placeholder="Phone Number"]').eq(0).val();

            email = $("#Email").val();
            address = $("#Address1").val();
            city = $("#City").val();
            state = $("#State").val();
            zipcode = $("#ZipCode").val();
            $(".tableInfolabel").each(function () {
                let info_item = $(this);
                let info_label = info_item.text();
                let info_item_next = info_item.next();
                if (info_label == "DOB") {
                    if (info_item_next.find(".spanField").length) {
                        let info_value = info_item_next.find(".spanField").eq(0).text();
                        birthdate = info_value;
                    }
                }
            });
            if (!birthdate) {
                birthdate = $("input.otherInformationDateTimePicker").val();
            }
        } else if (current_url.includes("onelink.intruity.com")) {
            if ($('#Day_Phone').length) {
                phone = $('#Day_Phone').val();
            } else if ($('#Home_Phone').length) {
                phone = $('#Home_Phone').val();
            }
            first_name = $('#First_Name').val();
            last_name = $('#Last_Name').val();
            email = $("#Email").val();
            if ($("#Street1").length) {
                address = $("#Street1").val();
                address2 = $("#Street2").val();
                city = $("#City").val();
                state = $("#State").val();
                zipcode = $("#Zipcode").val();
            } else {
                address = $("#Home_Address1").val();
                address2 = $("#Home_Address2").val();
                city = $("#Home_City").val();
                state = $("#Home_State").val();
                zipcode = $("#Home_Zip").val();
            }
            birthdate = $("#DOB").val();
        }

        if (phone && (phone != "undefined")) {
            phone = format_phone(phone);
            let profile_data = {
                first_name: first_name,
                last_name: last_name,
                phone: phone,
                email: email,
                birthdate: birthdate,
                address: address,
                address2: address2,
                city: city,
                state: state,
                zipcode: zipcode
            };

            //alert(JSON.stringify(profile_data));

            chrome.storage.local.set({
                profile_data: profile_data,
                contact_id: ""
            }, function () {
                chrome.runtime.sendMessage({
                    from: 'content',
                    subject: 'loadContactData'
                });
            });

            return true;
        }
    }
});

function get_value(id) {
    let final_value = "";
    if ($("#" + id).length) {
        let temp_value = $("#" + id).parent().html();
        if (temp_value.includes('data-previousvalue="')) {
            let parts = temp_value.split('data-previousvalue="');
            let parts2 = parts[1].split('"');
            final_value = parts2[0];
        }
    }
    return final_value;
}

function get_contact_info(contact) {
    let contact_info = {};
    let first_name = "";
    let last_name = "";

    let contact_parts = contact.split(" ");
    if (contact_parts[1]) {
        first_name = contact_parts[0];
        last_name = contact_parts[1];
    } else {
        first_name = contact_parts[0];
    }

    contact_info["first_name"] = first_name;
    contact_info["last_name"] = last_name;

    return contact_info;
}

function format_phone(phone) {
    phone = phone.replace("(", "");
    phone = phone.replace(")", "");
    phone = phone.replace(/-/g, '');
    phone = phone.replace(/\./g, '');
    phone = phone.replace(/  +/g, ' ');
    phone = phone.replace(/ /g, '');
    phone = phone.trim();
    if (phone.length == 11) {
        phone = "+" + phone;
    } else if (phone.length == 10) {
        phone = "+1" + phone;
    }

    return phone;
}

function get_data_value(data_html, sep1, sep2) {
    let data_value = "";
    if (data_html.includes(sep1)) {
        let parts1 = data_html.split(sep1);
        let parts2 = parts1[1].split(sep2);
        data_value = parts2[0];
    }

    return data_value;
}
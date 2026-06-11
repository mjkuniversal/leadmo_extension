import {
  test,
  expect,
  openPopupForTab,
  getChromeTabId,
  getStorageLocal,
  setStorageLocal,
  clearStorageLocal,
  grabAndWaitForProfile,
} from "./fixtures";
import type { Page, BrowserContext } from "@playwright/test";

/**
 * Regression suite for the v5.6 bug-sweep. Each test pins a defect that was
 * confirmed by the audit:
 *  - jQuery-only :contains() preset selector killing VanillaSoft scans
 *  - double quotes in tag[name="..."] selectors corrupting <option value>
 *  - empty grabs overwriting previously grabbed contact data
 *  - silent create-contact API failures (now upsert + error surfacing)
 *  - "Add to Workflow" with nothing selected
 *  - iframe-hosted forms invisible to top-frame-only injection
 *  - stale content script after tab navigation
 *  - contact preview lost on popup reopen
 *  - workflow/tag names with quotes truncating dropdown values
 */

async function waitForScan(popup: Page) {
  await popup.waitForFunction(() => {
    const status = document.getElementById("mapping_status");
    return (
      status &&
      status.textContent !== "" &&
      status.textContent !== "Scanning..."
    );
  }, { timeout: 10_000 });
}

async function openScannedPopup(
  context: BrowserContext,
  extensionId: string,
  fixtureBaseUrl: string,
  fixtureFile: string
): Promise<{ popup: Page; formPage: Page }> {
  const formPage = await context.newPage();
  await formPage.goto(`${fixtureBaseUrl}/${fixtureFile}`);
  await formPage.waitForLoadState("domcontentloaded");
  const tabId = await getChromeTabId(context, extensionId, fixtureFile);
  const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");
  await waitForScan(popup);
  return { popup, formPage };
}

test.describe("v5.6 Regressions", () => {
  test.beforeEach(async ({ popupPage }) => {
    await clearStorageLocal(popupPage);
  });

  // ── VanillaSoft preset: scan must survive, DOB via table scrape ──

  test("scans a VanillaSoft-shaped page and grabs DOB from the info table", async ({
    context,
    extensionId,
    fixtureBaseUrl,
  }) => {
    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "vanillasoft.net-contact.html"
    );

    // The old preset contained :contains() which threw in querySelector and
    // surfaced as "Cannot scan this page (content script not loaded)."
    const statusText = await popup.locator("#mapping_status").textContent();
    expect(statusText).toContain("fields found");

    const profile = await grabAndWaitForProfile(popup);
    expect(profile).toBeTruthy();
    expect(profile.first_name).toBe("Vana");
    expect(profile.last_name).toBe("Soft");
    // DOB is not an input on this view — must come from the
    // .tableInfolabel/.spanField special-case scrape.
    expect(profile.birthdate).toBe("03/15/1985");

    await popup.close();
    await formPage.close();
  });

  // ── Quote-safe dropdowns for name-only selectors ──────────────

  test("auto-maps and grabs fields whose selectors contain double quotes", async ({
    context,
    extensionId,
    fixtureBaseUrl,
  }) => {
    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "name-only-form.html"
    );

    // The generated selector is input[name="first_name"] — the old
    // string-concatenated <option value="..."> truncated it at the inner
    // quote, silently unmapping the field.
    const ddValue = await popup
      .locator('tr[data-field="first_name"] .mapping_dd')
      .inputValue();
    expect(ddValue).toBe('input[name="first_name"]');

    const profile = await grabAndWaitForProfile(popup);
    expect(profile).toBeTruthy();
    expect(profile.first_name).toBe("Quota");
    expect(profile.last_name).toBe("Crusher");
    expect(profile.email).toBe("quota@example.com");

    await popup.close();
    await formPage.close();
  });

  // ── Empty grab must not clobber stored contact data ───────────

  test("a grab that matches nothing leaves stored profile_data untouched", async ({
    context,
    extensionId,
    fixtureBaseUrl,
    popupPage,
  }) => {
    await setStorageLocal(popupPage, {
      profile_data: { first_name: "Keep", last_name: "Me", phone: "+15550001111" },
    });

    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "empty-page.html"
    );

    await popup.locator("#grab_data_btn").click();

    // The guard reports the empty grab instead of saving empties
    await popup.waitForFunction(() => {
      const status = document.getElementById("mapping_status");
      return status && status.textContent?.includes("No data captured");
    }, { timeout: 5_000 });

    const profile = await getStorageLocal(popup, "profile_data");
    expect(profile.first_name).toBe("Keep");
    expect(profile.last_name).toBe("Me");

    await popup.close();
    await formPage.close();
  });

  // ── Send To LeadMomentum: upsert + visible outcomes ────────────

  test("send success calls /contacts/upsert and shows a confirmation", async ({
    context,
    popupPage,
  }) => {
    let upsertCalled = false;
    await context.route("**/contacts/upsert", (route) => {
      upsertCalled = true;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ new: true, contact: { id: "contact-123" } }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
      profile_data: { first_name: "Jane", last_name: "Lead", phone: "+15551234567" },
    });
    await popupPage.reload();

    await popupPage.locator("#send_to_leadmomentum").click();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("Contact created");
    }, { timeout: 5_000 });

    expect(upsertCalled).toBe(true);
  });

  test("send failure surfaces the GHL error instead of failing silently", async ({
    context,
    popupPage,
  }) => {
    await context.route("**/contacts/upsert", (route) => {
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ statusCode: 422, message: ["email must be an email"] }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
      profile_data: { first_name: "Bad", email: "not-an-email" },
    });
    await popupPage.reload();

    await popupPage.locator("#send_to_leadmomentum").click();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("NOT created");
    }, { timeout: 5_000 });

    const errorText = await popupPage.locator("#notification_message").textContent();
    expect(errorText).toContain("email must be an email");

    // Show-once (v5.7): the failure was displayed live, so the persisted
    // copy is consumed — reopening the popup must NOT re-show a stale error.
    await popupPage.waitForFunction(async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["lm_last_send_result"], (d) =>
          resolve(d.lm_last_send_result === undefined)
        );
      });
    }, { timeout: 5_000 });
  });

  test("empty profile fields are stripped from the upsert payload", async ({
    context,
    popupPage,
  }) => {
    let payload: any = null;
    await context.route("**/contacts/upsert", (route) => {
      payload = route.request().postDataJSON();
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ new: true, contact: { id: "c-1" } }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
      // Typical grab where the page had no email/DOB: empty strings used to
      // be sent verbatim and 422 the whole request.
      profile_data: {
        first_name: "NoEmail", last_name: "Lead", phone: "+15551230000",
        email: "", birthdate: "", address: "", city: "", state: "", zipcode: "",
      },
    });
    await popupPage.reload();

    await popupPage.locator("#send_to_leadmomentum").click();
    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("Contact created");
    }, { timeout: 5_000 });

    expect(payload).toBeTruthy();
    expect(payload.locationId).toBe("loc-1");
    expect(payload.firstName).toBe("NoEmail");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("dateOfBirth");
    expect(payload).not.toHaveProperty("address1");
  });

  // ── Add to Workflow guard ──────────────────────────────────────

  test("Add to Workflow with no workflow selected shows guidance and sends nothing", async ({
    context,
    popupPage,
  }) => {
    let anyApiCall = false;
    await context.route("**/services.leadconnectorhq.com/**", (route) => {
      anyApiCall = true;
      route.fulfill({ status: 401, body: "{}" });
    });

    await popupPage.locator("#add_to_workflow").click();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("Select a workflow");
    }, { timeout: 5_000 });

    expect(anyApiCall).toBe(false);
  });

  // ── Iframe-hosted forms ────────────────────────────────────────

  test("detects and grabs a form inside a same-origin iframe", async ({
    context,
    extensionId,
    fixtureBaseUrl,
  }) => {
    const formPage = await context.newPage();
    await formPage.goto(`${fixtureBaseUrl}/iframe-host.html`);
    // Make sure the iframe content is actually loaded before the popup
    // scans — otherwise frame selection legitimately sees zero fields.
    await formPage.frameLocator("iframe").locator("#first_name").waitFor({ timeout: 10_000 });

    const tabId = await getChromeTabId(context, extensionId, "iframe-host.html");
    const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");
    await waitForScan(popup);

    const statusText = await popup.locator("#mapping_status").textContent();
    expect(statusText).toContain("fields found");
    // The top frame has zero fields; anything found came from the iframe
    expect(statusText).not.toMatch(/^0 fields/);

    const profile = await grabAndWaitForProfile(popup);
    expect(profile).toBeTruthy();
    expect(profile.first_name).toBe("John");
    expect(profile.last_name).toBe("Doe");

    await popup.close();
    await formPage.close();
  });

  // ── Stale content script after navigation ──────────────────────

  test("rescan and grab still work after the tab navigates", async ({
    context,
    extensionId,
    fixtureBaseUrl,
  }) => {
    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "contact-form.html"
    );

    // Navigate the lead tab — this destroys the injected content script
    await formPage.goto(`${fixtureBaseUrl}/name-only-form.html`);
    await formPage.waitForLoadState("domcontentloaded");

    // Rescan must re-inject rather than messaging a dead document
    await popup.locator("#rescan_btn").click();
    await popup.waitForFunction(() => {
      const status = document.getElementById("mapping_status");
      return status && status.textContent?.includes("fields found");
    }, { timeout: 10_000 });

    const profile = await grabAndWaitForProfile(popup);
    expect(profile).toBeTruthy();
    expect(profile.first_name).toBe("Quota");

    await popup.close();
    await formPage.close();
  });

  // ── Contact preview restored on reopen ─────────────────────────

  test("reopened popup restores the grabbed contact preview without hijacking the view", async ({
    popupPage,
  }) => {
    await setStorageLocal(popupPage, {
      profile_data: { first_name: "Resta", last_name: "Ured", phone: "+15559998888" },
      survey_url: "https://forms.example.com/s",
    });
    await popupPage.reload();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("first_name");
      return el && el.textContent === "Resta";
    }, { timeout: 5_000 });

    await expect(popupPage.locator("#contact_preview")).toBeVisible();
    // Restoring on open must not auto-switch to the survey iframe view
    await expect(popupPage.locator("#wrapper")).toBeVisible();
    await expect(popupPage.locator("#survey_frame_container")).toBeHidden();
  });

  // ════ v5.7 regressions ═══════════════════════════════════════

  // ── Tags must never ride the upsert (it REPLACES the contact's tags) ──

  test("tag is applied additively via /contacts/{id}/tags, never in the upsert payload", async ({
    context,
    popupPage,
  }) => {
    let upsertPayload: any = null;
    let tagsPayload: any = null;
    await context.route("**/contacts/upsert", (route) => {
      upsertPayload = route.request().postDataJSON();
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ new: true, contact: { id: "c-77" } }),
      });
    });
    await context.route("**/contacts/c-77/tags", (route) => {
      tagsPayload = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await context.route("**/workflows/**", (route) => {
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ workflows: [] }),
      });
    });
    await context.route("**/locations/*/tags", (route) => {
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ tags: [{ id: "t-1", name: "Hot Lead", locationId: "loc-1" }] }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
      profile_data: { first_name: "Taggy", last_name: "Lead", phone: "+15550003333" },
    });
    await popupPage.reload();
    await popupPage.waitForSelector("#tags_dd option[value='Hot Lead']", {
      state: "attached", timeout: 5_000,
    });

    await popupPage.evaluate(() => {
      (document.getElementById("tags_dd") as HTMLSelectElement).value = "Hot Lead";
    });
    await popupPage.locator("#send_to_leadmomentum").click();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("Contact created");
    }, { timeout: 5_000 });
    await expect.poll(() => tagsPayload, { timeout: 5_000 }).toBeTruthy();

    expect(upsertPayload).toBeTruthy();
    expect(upsertPayload).not.toHaveProperty("tags");
    expect(tagsPayload).toEqual({ tags: ["Hot Lead"] });
  });

  // ── Matched-but-blank grab must not clobber stored contact ────

  test("grabbing a blank form (selectors match, values empty) keeps the stored contact", async ({
    context,
    extensionId,
    fixtureBaseUrl,
    popupPage,
  }) => {
    await setStorageLocal(popupPage, {
      profile_data: { first_name: "Keep", last_name: "Me2", phone: "+15550001112" },
    });

    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "blank-form.html"
    );

    await popup.locator("#grab_data_btn").click();

    await popup.waitForFunction(() => {
      const status = document.getElementById("mapping_status");
      return status && status.textContent?.includes("No data captured");
    }, { timeout: 5_000 });

    const profile = await getStorageLocal(popup, "profile_data");
    expect(profile.first_name).toBe("Keep");
    expect(profile.last_name).toBe("Me2");

    await popup.close();
    await formPage.close();
  });

  // ── Partial workflows/tags failure keeps the good half ────────

  test("workflows fetch failure still populates tags and clears stale workflows", async ({
    context,
    popupPage,
  }) => {
    await context.route("**/workflows/**", (route) => {
      route.fulfill({
        status: 401, contentType: "application/json",
        body: JSON.stringify({ message: "Unauthorized" }),
      });
    });
    await context.route("**/locations/*/tags", (route) => {
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ tags: [{ id: "t-9", name: "Survivor Tag", locationId: "loc-1" }] }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
    });
    await popupPage.reload();

    // The succeeded half loads…
    await popupPage.waitForSelector("#tags_dd option[value='Survivor Tag']", {
      state: "attached", timeout: 5_000,
    });
    // …the failed half is rebuilt empty (no stale entries), and the error
    // names the failing endpoint.
    const wfOptions = await popupPage.locator("#workflows_dd option").count();
    expect(wfOptions).toBe(0);
    const errorText = await popupPage.locator("#notification_message").textContent();
    expect(errorText).toContain("API error");
    expect(errorText).toContain("401");
  });

  // ── GHL-style wrapper-label markup must auto-map ───────────────

  test("auto-maps and grabs a GHL-style contact panel (no name/id/label wiring)", async ({
    context,
    extensionId,
    fixtureBaseUrl,
  }) => {
    const { popup, formPage } = await openScannedPopup(
      context, extensionId, fixtureBaseUrl, "ghl-contact-panel.html"
    );

    // The old label discovery found nothing on this markup: inputs have no
    // name/id/for/aria and placeholder "--" — "N fields found, 0 auto-mapped".
    const statusText = await popup.locator("#mapping_status").textContent();
    expect(statusText).toMatch(/4 auto-mapped/);

    const profile = await grabAndWaitForProfile(popup);
    expect(profile).toBeTruthy();
    expect(profile.first_name).toBe("Ghl");
    expect(profile.last_name).toBe("Mapper");
    expect(profile.email).toBe("ghl.mapper@example.com");
    expect(profile.phone).toBe("+15558675309");

    await popup.close();
    await formPage.close();
  });

  // ── Send outcome stays visible when the survey view auto-shows ──

  test("contact-created toast remains visible after survey auto-show hides the wrapper", async ({
    context,
    popupPage,
  }) => {
    await context.route("**/contacts/upsert", (route) => {
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ new: true, contact: { id: "c-1" } }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
      survey_url: "https://forms.example.com/s",
      profile_data: { first_name: "Vis", last_name: "Ible", phone: "+15551112222" },
    });
    await popupPage.reload();

    await popupPage.locator("#send_to_leadmomentum").click();

    await popupPage.waitForFunction(() => {
      const el = document.getElementById("notification_message");
      return el && el.textContent?.includes("Contact created");
    }, { timeout: 5_000 });

    // Survey view took over the main UI…
    await expect(popupPage.locator("#survey_frame_container")).toBeVisible();
    await expect(popupPage.locator("#wrapper")).toBeHidden();
    // …but the toast lives outside #wrapper and stays visible.
    await expect(popupPage.locator("#notification_message")).toBeVisible();
  });

  // ── Quote-safe workflow/tag dropdowns ──────────────────────────

  test("tag names containing quotes keep their full value in the dropdown", async ({
    context,
    popupPage,
  }) => {
    const trickyTag = `Bob's "VIP" List`;
    await context.route("**/workflows/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflows: [{ id: "wf-1", name: `Hot "Leads" Now` }] }),
      });
    });
    await context.route("**/locations/*/tags", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tags: [{ id: "t-1", name: trickyTag, locationId: "loc-1" }] }),
      });
    });

    await setStorageLocal(popupPage, {
      api_keys: [["Test", "fake-key", "loc-1"]],
      selected_api_key: "fake-key",
      selected_location_id: "loc-1",
    });
    await popupPage.reload();

    await popupPage.waitForSelector("#tags_dd option", { state: "attached", timeout: 5_000 });

    const tagValues = await popupPage.evaluate(() =>
      Array.from(document.querySelectorAll("#tags_dd option")).map((o) => (o as HTMLOptionElement).value)
    );
    expect(tagValues).toContain(trickyTag);
  });
});

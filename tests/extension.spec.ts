import {
  test,
  expect,
  openPopupForTab,
  getChromeTabId,
  getStorageLocal,
  setStorageLocal,
  clearStorageLocal,
} from "./fixtures";

test.describe("LeadMomentum Chrome Extension", () => {
  test.beforeEach(async ({ popupPage }) => {
    await clearStorageLocal(popupPage);
  });

  // ── Field Detection ────────────────────────────────────────

  test.describe("Field Detection", () => {
    test("detects form fields and auto-maps them", async ({
      context,
      extensionId,
      fixtureBaseUrl,
    }) => {
      // Navigate to fixture via HTTP so extension can inject content scripts
      const formPage = await context.newPage();
      await formPage.goto(`${fixtureBaseUrl}/contact-form.html`);
      await formPage.waitForLoadState("domcontentloaded");

      // Get the Chrome tab ID for this page
      const tabId = await getChromeTabId(context, extensionId, "contact-form.html");

      // Open popup in detached mode pointing at the form tab
      const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");

      // Wait for field detection to complete
      await popup.waitForFunction(() => {
        const status = document.getElementById("mapping_status");
        return (
          status &&
          status.textContent !== "" &&
          status.textContent !== "Scanning..."
        );
      }, { timeout: 10_000 });

      const statusText = await popup
        .locator("#mapping_status")
        .textContent();
      expect(statusText).toContain("fields found");

      // Verify dropdowns were populated (more than just "— none —")
      const firstNameOptions = await popup
        .locator('tr[data-field="first_name"] .mapping_dd option')
        .count();
      expect(firstNameOptions).toBeGreaterThan(1);

      await popup.close();
      await formPage.close();
    });

    test("shows no fields on an empty page", async ({
      context,
      extensionId,
      fixtureBaseUrl,
    }) => {
      const emptyPage = await context.newPage();
      await emptyPage.goto(`${fixtureBaseUrl}/empty-page.html`);
      await emptyPage.waitForLoadState("domcontentloaded");

      const tabId = await getChromeTabId(context, extensionId, "empty-page.html");
      const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");

      await popup.waitForFunction(() => {
        const status = document.getElementById("mapping_status");
        return (
          status &&
          status.textContent !== "" &&
          status.textContent !== "Scanning..."
        );
      }, { timeout: 10_000 });

      const statusText = await popup
        .locator("#mapping_status")
        .textContent();
      expect(statusText).toMatch(/no fields|cannot scan|0 fields found/i);

      await popup.close();
      await emptyPage.close();
    });
  });

  // ── Grab Data ──────────────────────────────────────────────

  test.describe("Grab Data", () => {
    test("grabs contact data from mapped fields", async ({
      context,
      extensionId,
      fixtureBaseUrl,
    }) => {
      const formPage = await context.newPage();
      await formPage.goto(`${fixtureBaseUrl}/contact-form.html`);
      await formPage.waitForLoadState("domcontentloaded");

      const tabId = await getChromeTabId(context, extensionId, "contact-form.html");
      const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");

      // Wait for field detection
      await popup.waitForFunction(() => {
        const status = document.getElementById("mapping_status");
        return status && status.textContent?.includes("fields found");
      }, { timeout: 10_000 });

      // Click "Grab Data"
      await popup.locator("#grab_data_btn").click();

      // Wait for profile_data to appear in storage
      await popup.waitForFunction(async () => {
        return new Promise((resolve) => {
          chrome.storage.local.get(["profile_data"], (data) => {
            resolve(data.profile_data && data.profile_data.first_name);
          });
        });
      }, { timeout: 5_000 });

      const profileData = await getStorageLocal(popup, "profile_data");
      expect(profileData).toBeTruthy();
      expect(profileData.first_name).toBe("John");
      expect(profileData.last_name).toBe("Doe");
      expect(profileData.email).toBe("john.doe@example.com");
      // format_phone: "(555) 123-4567" → strips parens/dash/space → "5551234567" (10 digits) → "+15551234567"
      expect(profileData.phone).toBe("+15551234567");

      await popup.close();
      await formPage.close();
    });
  });

  // ── Setup Notices ───────────────────────────────────────

  test.describe("Setup Notices", () => {
    test("shows setup notice when no API key is configured", async ({
      popupPage,
    }) => {
      // Storage was cleared in beforeEach — no accounts exist
      await popupPage.reload();

      // Check for notices in tags, workflows, and api_key sections
      const tagNotice = await popupPage.locator("#tags_box .lm-setup-notice").textContent();
      expect(tagNotice).toContain("Add an API key");

      const wfNotice = await popupPage.locator("#workflows_box .lm-setup-notice").textContent();
      expect(wfNotice).toContain("Add an API key");

      const apiNotice = await popupPage.locator("#api_key_box .lm-setup-notice").textContent();
      expect(apiNotice).toContain("API Name");
    });

    test("notices disappear after adding and selecting an account", async ({
      popupPage,
    }) => {
      await popupPage.locator("#api_name").fill("Test");
      await popupPage.locator("#api_key").fill("key-123");
      await popupPage.locator("#location_id").fill("loc-456");
      await popupPage.locator("#save_api_key").click();

      await popupPage.waitForTimeout(500);

      // Notices should be gone after account is added (auto-selected as first key)
      const notices = await popupPage.locator(".lm-setup-notice").count();
      expect(notices).toBe(0);
    });
  });

  // ── API Key Management ─────────────────────────────────────

  test.describe("API Key Management", () => {
    test("saves and selects an API key with location ID", async ({
      popupPage,
    }) => {
      await popupPage.locator("#api_name").fill("Test Account");
      await popupPage.locator("#api_key").fill("test-api-key-123");
      await popupPage.locator("#location_id").fill("loc-456");
      await popupPage.locator("#save_api_key").click();

      await popupPage.waitForTimeout(500);

      // api_keys is [[name, key, locationId]]
      const apiKeys = await getStorageLocal(popupPage, "api_keys");
      expect(apiKeys).toHaveLength(1);
      expect(apiKeys[0]).toEqual(["Test Account", "test-api-key-123", "loc-456"]);

      const selectedKey = await getStorageLocal(popupPage, "selected_api_key");
      expect(selectedKey).toBe("test-api-key-123");

      const selectedLocation = await getStorageLocal(popupPage, "selected_location_id");
      expect(selectedLocation).toBe("loc-456");
    });

    test("clears input fields after saving", async ({ popupPage }) => {
      await popupPage.locator("#api_name").fill("Test");
      await popupPage.locator("#api_key").fill("key");
      await popupPage.locator("#location_id").fill("loc");
      await popupPage.locator("#save_api_key").click();

      await popupPage.waitForTimeout(500);

      expect(await popupPage.locator("#api_name").inputValue()).toBe("");
      expect(await popupPage.locator("#api_key").inputValue()).toBe("");
      expect(await popupPage.locator("#location_id").inputValue()).toBe("");
    });
  });

  // ── Survey URL ─────────────────────────────────────────────

  test.describe("Survey URL", () => {
    test("saves a survey URL to storage", async ({ popupPage }) => {
      await popupPage
        .locator("#survey_url")
        .fill("https://forms.example.com/survey123");
      await popupPage.locator("#save_survey_url").click();

      await popupPage.waitForFunction(() => {
        const el = document.getElementById("survey_status");
        return el && el.textContent === "Survey URL saved.";
      });

      const savedUrl = await getStorageLocal(popupPage, "survey_url");
      expect(savedUrl).toBe("https://forms.example.com/survey123");
    });

    test("rejects non-https survey URLs", async ({ popupPage }) => {
      await popupPage
        .locator("#survey_url")
        .fill("http://forms.example.com/survey123");
      await popupPage.locator("#save_survey_url").click();

      const statusText = await popupPage
        .locator("#survey_status")
        .textContent();
      expect(statusText).toContain("https://");
    });

    test("builds survey iframe URL with contact data params", async ({
      popupPage,
    }) => {
      await setStorageLocal(popupPage, {
        survey_url: "https://forms.example.com/survey",
        profile_data: {
          first_name: "Jane",
          last_name: "Smith",
          phone: "+15551234567",
          email: "jane@example.com",
        },
      });

      await popupPage.locator("#open_survey_btn").click();

      await popupPage.waitForFunction(() => {
        const iframe = document.getElementById("survey_frame");
        return iframe && iframe.src && iframe.src !== "about:blank";
      });

      const iframeSrc = await popupPage
        .locator("#survey_frame")
        .getAttribute("src");

      expect(iframeSrc).toContain("first_name=Jane");
      expect(iframeSrc).toContain("last_name=Smith");
      expect(iframeSrc).toContain("phone=%2B15551234567");
      expect(iframeSrc).toContain("email=jane%40example.com");
    });
  });

  // ── Survey Param Mapping (v5.2 address fix) ────────────────

  test.describe("Survey Param Mapping", () => {
    test("maps address to street_address (not address1)", async ({
      popupPage,
    }) => {
      await setStorageLocal(popupPage, {
        survey_url: "https://forms.example.com/s",
        profile_data: {
          address: "123 Main St",
          city: "Springfield",
          state: "IL",
          zipcode: "62701",
        },
      });

      await popupPage.locator("#open_survey_btn").click();

      await popupPage.waitForFunction(() => {
        const iframe = document.getElementById("survey_frame");
        return iframe && iframe.src && iframe.src !== "about:blank";
      });

      const iframeSrc = await popupPage
        .locator("#survey_frame")
        .getAttribute("src");

      expect(iframeSrc).toContain("street_address=123");
      expect(iframeSrc).toContain("city=Springfield");
      expect(iframeSrc).toContain("state=IL");
      expect(iframeSrc).toContain("postal_code=62701");
      expect(iframeSrc).not.toContain("address1=");
    });
  });

  // ── Domain Mapping Persistence ─────────────────────────────

  test.describe("Domain Mapping", () => {
    test("persists domain mappings in storage", async ({ popupPage }) => {
      await setStorageLocal(popupPage, {
        lm_domain_mappings: {
          "example.com": {
            first_name: "#fname",
            last_name: "#lname",
          },
        },
      });

      const mappings = await getStorageLocal(popupPage, "lm_domain_mappings");
      expect(mappings["example.com"].first_name).toBe("#fname");
      expect(mappings["example.com"].last_name).toBe("#lname");
    });
  });

  // ── Phone Formatting ───────────────────────────────────────

  test.describe("Phone Formatting", () => {
    test("formats 10-digit phone with +1 prefix", async ({
      context,
      extensionId,
      fixtureBaseUrl,
    }) => {
      // Create a fixture-like page with just a phone field via HTTP
      const formPage = await context.newPage();
      await formPage.goto(`${fixtureBaseUrl}/contact-form.html`);
      await formPage.waitForLoadState("domcontentloaded");

      // Clear the phone field and set a bare 10-digit number
      await formPage.locator("#phone").fill("5551234567");

      const tabId = await getChromeTabId(context, extensionId, "contact-form.html");
      const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");

      await popup.waitForFunction(() => {
        const status = document.getElementById("mapping_status");
        return status && status.textContent?.includes("fields found");
      }, { timeout: 10_000 });

      await popup.locator("#grab_data_btn").click();

      await popup.waitForFunction(async () => {
        return new Promise((resolve) => {
          chrome.storage.local.get(["profile_data"], (data) => {
            resolve(data.profile_data && data.profile_data.phone);
          });
        });
      }, { timeout: 5_000 });

      const profileData = await getStorageLocal(popup, "profile_data");
      // format_phone: 10 digits → "+1" + phone
      expect(profileData.phone).toBe("+15551234567");

      await popup.close();
      await formPage.close();
    });
  });

  // ── GHL API: Workflows & Tags ──────────────────────────────

  test.describe("GHL Workflows & Tags", () => {
    test("loads workflows and tags from mocked GHL API", async ({
      context,
      popupPage,
    }) => {
      // Mock the GHL workflows endpoint (called by service worker)
      await context.route("**/workflows/**", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workflows: [
              { id: "wf-001", name: "New Lead Workflow" },
              { id: "wf-002", name: "Nurture Sequence" },
            ],
          }),
        });
      });

      // Mock the GHL tags endpoint
      await context.route("**/locations/*/tags", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tags: [
              { id: "tag-001", name: "Hot Lead", locationId: "loc-test" },
              { id: "tag-002", name: "ACA 2026", locationId: "loc-test" },
            ],
          }),
        });
      });

      // Pre-populate an API key + location ID so the popup triggers the fetch
      await setStorageLocal(popupPage, {
        api_keys: [["Test Account", "fake-api-key", "loc-test"]],
        selected_api_key: "fake-api-key",
        selected_location_id: "loc-test",
      });

      // Reload popup to trigger load_api_keys -> fetch_workflows_and_tags
      await popupPage.reload();

      // Wait for the workflows dropdown to appear with options
      // (Select2 hides the native <select>, so check attached, not visible)
      await popupPage.waitForSelector("#workflows_dd option[value='wf-001']", {
        state: "attached",
        timeout: 5_000,
      });

      // Verify workflow options
      const wfOptions = await popupPage.locator("#workflows_dd option").allTextContents();
      expect(wfOptions).toContain("New Lead Workflow");
      expect(wfOptions).toContain("Nurture Sequence");

      // Verify tag options
      const tagOptions = await popupPage.locator("#tags_dd option").allTextContents();
      expect(tagOptions).toContain("Hot Lead");
      expect(tagOptions).toContain("ACA 2026");
    });

    test("shows error when location ID is missing", async ({
      popupPage,
    }) => {
      // API key without location ID
      await setStorageLocal(popupPage, {
        api_keys: [["No Location", "fake-key", ""]],
        selected_api_key: "fake-key",
        selected_location_id: "",
      });

      await popupPage.reload();

      // Wait for error message about Location ID
      await popupPage.waitForFunction(() => {
        const el = document.getElementById("notification_message");
        return el && el.textContent?.includes("Location ID");
      }, { timeout: 5_000 });

      const errorText = await popupPage
        .locator("#notification_message")
        .textContent();
      expect(errorText).toContain("Location ID");
    });

    test("shows error on API failure (401)", async ({
      context,
      popupPage,
    }) => {
      // Mock a 401 response (bad token or missing scopes)
      await context.route("**/workflows/**", (route) => {
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ message: "Unauthorized" }),
        });
      });
      await context.route("**/locations/*/tags", (route) => {
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ message: "Unauthorized" }),
        });
      });

      await setStorageLocal(popupPage, {
        api_keys: [["Test", "bad-key", "loc-test"]],
        selected_api_key: "bad-key",
        selected_location_id: "loc-test",
      });

      await popupPage.reload();

      // Wait for error notification
      await popupPage.waitForFunction(() => {
        const el = document.getElementById("notification_message");
        return el && el.textContent?.includes("API error");
      }, { timeout: 5_000 });

      const errorText = await popupPage
        .locator("#notification_message")
        .textContent();
      expect(errorText).toContain("API error");
      expect(errorText).toContain("401");
    });
  });
});

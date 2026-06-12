import {
  test,
  expect,
  openPopupForTab,
  getChromeTabId,
  grabAndWaitForProfile,
  setStorageLocal,
  clearStorageLocal,
} from "./fixtures";
import fs from "fs";
import path from "path";

/**
 * End-to-end proof that grab → survey iframe delivers the contact data on
 * the iframe URL. The echo fixture renders every query param it receives —
 * exactly what a GHL survey sees in its own location.search. If this
 * passes, an empty real-world survey means the SURVEY side isn't consuming
 * the params (field Query Keys not matching) or the saved URL redirects
 * and drops the query string — not an extension defect.
 */
test.describe("Survey prefill delivery", () => {
  test.beforeEach(async ({ popupPage }) => {
    await clearStorageLocal(popupPage);
  });

  test("grabbed contact data reaches the embedded survey's query string", async ({
    context,
    extensionId,
    fixtureBaseUrl,
    popupPage,
  }, testInfo) => {
    // The extension enforces https on survey URLs; serve the echo fixture
    // via route interception on a fake https origin.
    const echoHtml = fs.readFileSync(
      path.resolve(__dirname, "fixtures/echo-survey.html"),
      "utf-8"
    );
    await context.route("https://surveys.example-ghl.test/**", (route) => {
      route.fulfill({ status: 200, contentType: "text/html", body: echoHtml });
    });

    await setStorageLocal(popupPage, {
      survey_url: "https://surveys.example-ghl.test/widget/survey/abc123",
    });

    // Real flow: open the form page, open the popup against it, grab.
    const formPage = await context.newPage();
    await formPage.goto(`${fixtureBaseUrl}/contact-form.html`);
    await formPage.waitForLoadState("domcontentloaded");
    const tabId = await getChromeTabId(context, extensionId, "contact-form.html");
    const popup = await openPopupForTab(context, extensionId, tabId, "127.0.0.1");
    await popup.waitForFunction(() => {
      const status = document.getElementById("mapping_status");
      return status && status.textContent?.includes("fields found");
    }, { timeout: 10_000 });

    const profile = await grabAndWaitForProfile(popup);
    expect(profile.first_name).toBe("John");

    // The grab broadcast auto-refreshes the survey iframe with the params.
    const surveyFrame = popup.frameLocator("#survey_frame");
    await expect(surveyFrame.locator("#param_first_name")).toHaveText("John", {
      timeout: 10_000,
    });
    await expect(surveyFrame.locator("#param_last_name")).toHaveText("Doe");
    await expect(surveyFrame.locator("#param_email")).toHaveText("john.doe@example.com");
    await expect(surveyFrame.locator("#param_phone")).toHaveText("+15551234567");

    // Visual proof for the user: the popup with the echo survey filled in.
    await popup.locator("#survey_frame").scrollIntoViewIfNeeded().catch(() => {});
    await popup.screenshot({
      path: testInfo.outputPath("survey-prefill-proof.png"),
      fullPage: true,
    });

    await popup.close();
    await formPage.close();
  });
});

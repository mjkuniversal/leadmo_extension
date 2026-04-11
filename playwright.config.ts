import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  workers: 1, // extensions require serial execution (single persistent context)
  use: {
    headless: false, // Chrome extensions require headed mode
  },
  projects: [
    {
      name: "chrome-extension",
      use: {
        browserName: "chromium",
      },
    },
  ],
});

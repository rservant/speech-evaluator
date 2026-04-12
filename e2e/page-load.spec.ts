// E2E: Page Load — verify JS modules, CSS, and static assets load correctly
import { test, expect } from "@playwright/test";

test.describe("Page Load", () => {
  test("all JS modules load without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // No syntax errors or module loading failures
    const syntaxErrors = errors.filter(
      (e) => e.includes("SyntaxError") || e.includes("Unexpected token"),
    );
    expect(syntaxErrors).toEqual([]);
  });

  test("start button exists on page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const startBtn = page.locator("#btn-start");
    await expect(startBtn).toBeVisible();
  });

  test("JS files serve JavaScript content-type, not HTML", async ({
    request,
  }) => {
    // Fetch the app module JS files and verify they're served as JS
    const jsFiles = [
      "/js/app.js",
      "/js/audio.js",
      "/js/websocket.js",
      "/js/history.js",
    ];

    for (const file of jsFiles) {
      const res = await request.get(file);
      expect(res.status()).toBe(200);
      const contentType = res.headers()["content-type"] ?? "";
      expect(contentType).toContain("javascript");
    }
  });

  test("CSS loads successfully", async ({ request }) => {
    const res = await request.get("/style.css");
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("css");
  });

  test("version footer displays", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The footer has id="app-footer" and fetches /api/version
    const footer = page.locator("#app-footer");
    await expect(footer).toBeVisible({ timeout: 5000 });
    const text = await footer.textContent();
    expect(text).toContain("v");
  });

  test("URL params pre-fill consent form (#196)", async ({ page }) => {
    await page.goto("/?speaker=DeepLink+Tester&title=My+Speech&project=Ice+Breaker");
    await page.evaluate(() => localStorage.setItem("speechEval_setupComplete", "1"));
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#consent-form")).toHaveClass(/visible/, { timeout: 5000 });

    const speaker = await page.locator("#speaker-name-input").inputValue();
    expect(speaker).toBe("DeepLink Tester");

    const title = await page.locator("#speech-title-input").inputValue();
    expect(title).toBe("My Speech");
  });
});

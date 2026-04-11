// E2E: State Machine — verify IDLE → RECORDING → PROCESSING transitions
import { test, expect } from "@playwright/test";

// Stub navigator.mediaDevices.getUserMedia with a fake MediaStream
const MEDIA_STUB_SCRIPT = `
  const fakeStream = (() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    } catch {
      return new MediaStream();
    }
  })();

  navigator.mediaDevices.getUserMedia = async () => fakeStream;
  navigator.mediaDevices.enumerateDevices = async () => [];
`;

test.describe("State Machine Transitions", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(MEDIA_STUB_SCRIPT);
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("speechEval_setupComplete", "1");
    });
    await page.reload();
    await page.waitForLoadState("networkidle");
    // Wait for JS module init — consent form starts display:none, becomes visible via updateUI(IDLE)
    await expect(page.locator("#consent-form")).toHaveClass(/visible/, { timeout: 5000 });
  });

  test("IDLE state shown on page load", async ({ page }) => {
    const startBtn = page.locator("#btn-start");
    await expect(startBtn).toBeVisible();

    const stopBtn = page.locator("#btn-stop");
    await expect(stopBtn).not.toBeVisible();
  });

  test("clicking Start transitions to RECORDING state", async ({ page }) => {
    await page.locator("#speaker-name-input").fill("E2E Tester");
    await page.locator("#consent-checkbox").check();
    await expect(page.locator("#btn-start")).toBeEnabled({ timeout: 2000 });

    await page.locator("#btn-start").click();

    const stopBtn = page.locator("#btn-stop");
    await expect(stopBtn).toBeVisible({ timeout: 10000 });
  });

  test("clicking Stop transitions to PROCESSING state", async ({ page }) => {
    await page.locator("#speaker-name-input").fill("E2E Tester");
    await page.locator("#consent-checkbox").check();
    await expect(page.locator("#btn-start")).toBeEnabled({ timeout: 2000 });
    await page.locator("#btn-start").click();

    await expect(page.locator("#btn-stop")).toBeVisible({ timeout: 10000 });

    await page.locator("#btn-stop").click();

    const deliverBtn = page.locator("#btn-deliver");
    await expect(deliverBtn).toBeVisible({ timeout: 10000 });
  });
});

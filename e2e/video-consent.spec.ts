// E2E: Video Consent — verify video toggle exists and is functional
import { test, expect } from "@playwright/test";

// Stub both audio and video getUserMedia
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

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const stream = canvas.captureStream(5);
      if (constraints.audio) {
        for (const track of fakeStream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
      return stream;
    }
    return fakeStream;
  };
  navigator.mediaDevices.enumerateDevices = async () => [];
`;

test.describe("Video Consent", () => {
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

  test("video consent checkbox exists on page", async ({ page }) => {
    const videoCheckbox = page.locator("#video-consent-checkbox");
    await expect(videoCheckbox).toBeVisible();
  });

  test("video consent checkbox can be checked", async ({ page }) => {
    await page.locator("#speaker-name-input").fill("Video Tester");
    await page.locator("#consent-checkbox").check();

    const videoCheckbox = page.locator("#video-consent-checkbox");
    await videoCheckbox.check();
    expect(await videoCheckbox.isChecked()).toBe(true);
  });
});

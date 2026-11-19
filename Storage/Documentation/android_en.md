# Installing MSE on Android

This guide explains how to install and run the MSE userscript extension on Android devices.

---

## 1. Supported Browsers

Standard Google Chrome on Android does not support browser extensions. Use one of the following browsers:

- **Option A (Recommended):** **Firefox for Android** with **Violentmonkey** or **Tampermonkey** add-on.
- **Option B:** **Kiwi Browser** (Chromium-based browser supporting Chrome Web Store extensions).

---

## 2. Setup with Firefox for Android

1. Install **Firefox** from Google Play.
2. Open Firefox, tap the three-dots menu -> **Add-ons**.
3. Search for and install **Violentmonkey** or **Tampermonkey**.
4. Navigate to or open the userscript artifact:
   - File: `Storage/artifacts/mse.user.js`
5. The extension will intercept the `.user.js` file and display the installation dialog.
6. Tap **Confirm installation** (or **Install**).

---

## 3. Setup with Kiwi Browser

1. Install **Kiwi Browser** from Google Play.
2. Visit the [Chrome Web Store](https://chrome.google.com/webstore) and install **Tampermonkey** or **Violentmonkey**.
3. Open or import `Storage/artifacts/mse.user.js`.
4. Confirm script installation.

---

## 4. Connecting to Gateway

1. Open your university or school Moodle portal in the browser and navigate to a quiz.
2. Tap the floating **MSE** badge on the page.
3. In the settings card, specify your **Gateway URL** (e.g. Cloudflared tunnel `https://<tunnel-host>.trycloudflare.com` or Tailscale Funnel address `https://<host>.<tailnet>.ts.net`).
4. Tap **Connect**. The server owner will receive an approval request via Telegram.
5. Once approved, the extension connects and displays your daily quota and remaining reset time.

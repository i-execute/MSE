# Installing MSE on Desktop (Windows, macOS, Linux)

This guide covers setting up MSE in desktop web browsers.

---

## 1. Supported Browsers

MSE works in any modern desktop browser supporting userscripts:
- Google Chrome and Chromium-based browsers
- Microsoft Edge
- Mozilla Firefox
- Brave Browser, Vivaldi, Opera
- Apple Safari on macOS (via Tampermonkey or Stay)

---

## 2. Installing a Userscript Manager

Install a compatible manager extension for your browser:

- **Tampermonkey** (Recommended):
  - [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
  - [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/)
  - [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- **Violentmonkey** (Lightweight open-source alternative):
  - Available on Chrome Web Store and Firefox Add-ons.

---

## 3. Installing MSE

1. Open or drag `Storage/artifacts/mse.user.js` into your browser.
2. The userscript manager will open the installation tab displaying metadata and permissions.
3. Click **Install**.
4. Confirm MSE is active in the userscript manager dashboard.

---

## 4. Gateway Connection and Usage

1. Open any Moodle quiz attempt page.
2. The discrete monochrome **MSE** badge will appear on the page.
3. Click the badge to open settings:
   - Provide your **Gateway URL**.
   - Click **Connect** to submit your device registration.
4. After approval in the Telegram management bot, full access is granted.
5. In multiple-choice questions, clicking AI recommendations directly checks Moodle form options, leaves the answer popover open, and highlights each clicked item.

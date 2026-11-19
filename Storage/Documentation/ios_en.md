# Installing MSE on iOS / iPadOS (Safari)

This guide walks through installing and setting up the MSE userscript extension on Apple mobile devices (iPhone and iPad) running iOS / iPadOS with Safari.

---

## 1. Requirements

- **Device:** iPhone or iPad running iOS / iPadOS 15.0 or later.
- **Browser:** Apple Safari.
- **Userscript Manager:** **Stay for Safari** (available on the [App Store](https://apps.apple.com/app/stay-for-safari/id1591620924)) or equivalent (e.g. Userscripts extension).

---

## 2. Setting Up Stay

1. Open the **App Store** on your iPhone or iPad.
2. Search for **Stay ‐ Userscript Extension** and install it.
3. Open **iOS Settings** -> **Safari** -> **Extensions**.
4. Tap **Stay** and toggle the switch to **On**.
5. Set permissions: under **Permissions for Stay**, select **All Websites** -> **Allow** so the userscript can run on your Moodle domain.

---

## 3. Installing the MSE Userscript

1. Locate the single-file userscript artifact:
   - Path: `Storage/artifacts/mse.user.js`
2. Open the **Stay** application:
   - Tap the **+** button in the upper-right corner.
   - Choose **Import from URL** or paste the raw contents of `mse.user.js`.
   - Tap **Save** to register the script.
3. Ensure the toggle switch for MSE is enabled.

---

## 4. Connecting to Your MSE Gateway

1. Open Safari and navigate to any quiz attempt page on your Moodle portal.
2. In the lower-right area of the page, the subtle monochrome **MSE** badge will appear.
3. Tap the badge to open the settings card:
   - Enter your MSE Gateway public address in the **Gateway URL** field (for example, your Cloudflared tunnel `https://<tunnel-host>.trycloudflare.com` or Tailscale Funnel domain `https://<host>.<tailnet>.ts.net`).
   - Tap **Connect**.
4. On the initial connection, a unique device key is generated and a registration request is sent to the gateway.
5. The gateway owner will receive an interactive card in Telegram with **Approve** and **Decline** buttons.
6. Once approved, the extension connects and displays daily quota information.

---

## 5. Usage in Moodle Quizzes

- **Answer Database:** Matching verified answers are highlighted instantly.
- **AI Agent:** Tap the agent button to invoke the model. Flowing aura and animated icons (brain for reasoning, eye for vision, pencil for answering) will reflect the agent state.
- **Multi-Choice Support:** For questions with multiple correct options, tap each recommended answer. Each tap applies directly to the Moodle form and lights up with brighter visual feedback while keeping the popover visible until completed.

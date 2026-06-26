# Setup: WhatsApp Links Open the Photo Visor App Directly

When a new album notification arrives on WhatsApp, tapping the link should open the Photo Visor app instead of the browser. This guide covers both cases: native APK installed, or only the PWA installed.

---

## Prerequisites

- Android phone (Samsung or otherwise)
- Photo Visor installed: either the **native APK** (from Google Play) or the **PWA** (installed via Samsung Browser)
- A computer with `adb` installed
- USB cable **or** Wireless Debugging enabled on the phone

---

## Step 1 — Connect via adb

### Option A: USB cable

1. On the phone go to **Settings → About phone → Software information** and tap **Build number** 7 times to enable Developer Options.
2. Go to **Settings → Developer options → USB debugging** and enable it.
3. Connect the USB cable, select **File transfer** mode on the phone, and tap **Allow** when prompted.
4. On the computer run:
   ```bash
   adb devices
   ```
   The device should appear as `authorized`.

### Option B: Wireless (no cable)

1. Enable Developer Options (same as above).
2. Go to **Settings → Developer options → Wireless debugging** and enable it.
3. Tap **Pair device with pairing code** — note the IP address and port shown (e.g. `192.168.0.12:40441`).
4. On the computer:
   ```bash
   adb connect 192.168.0.12:40441
   adb devices   # should show the device as connected
   ```

---

## Step 2 — Enable the link handler

Pick the section that matches what is installed on the phone.

### Case A: Native APK installed (Google Play)

Run:
```bash
adb shell pm set-app-links --package com.photovisor.family 2 fotos.forwardforecasting.eu
```

Verify:
```bash
adb shell pm get-app-links --package com.photovisor.family
```
`fotos.forwardforecasting.eu` should show `verified` or `approved`.

### Case B: Only the PWA installed (Samsung Browser WebAPK)

The PWA installed through Samsung Browser creates a WebAPK with a fixed package name. Run both commands:

```bash
adb shell pm set-app-links \
  --package com.sec.android.app.sbrowser.webapk.wb7487e39b203264614b64d39b5b928aa1 \
  2 fotos.forwardforecasting.eu

adb shell pm set-app-links-user-selection \
  --package com.sec.android.app.sbrowser.webapk.wb7487e39b203264614b64d39b5b928aa1 \
  --user 0 true fotos.forwardforecasting.eu
```

Verify:
```bash
adb shell pm get-app-links \
  --package com.sec.android.app.sbrowser.webapk.wb7487e39b203264614b64d39b5b928aa1
```
You should see:
```
User 0:
  Verification link handling allowed: true
  Selection state:
    Enabled:
      fotos.forwardforecasting.eu
```

---

## Step 3 — Test

Ask someone to send a Photo Visor album link (e.g. from a WhatsApp notification) and tap it. It should open the Photo Visor app directly without going through the browser.

---

## Notes

- These commands require Android 12 or later.
- The Samsung WebAPK package name (`wb7487...`) is derived from the PWA manifest URL and is the **same on every Samsung device** for Photo Visor — you do not need to look it up per device.
- If the user later installs the native APK, re-run **Case A** so links route to the APK instead.
- If Wireless Debugging disconnects, re-run `adb connect <IP>:<PORT>` and retry the command.

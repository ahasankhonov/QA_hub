---
name: android-emulator-dns-restart
description: "Android emulator \"No internet connection\" = empty net.dns1; fix is a cold restart with -dns-server, not runtime patching. Standing hub rule."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f154eb70-9881-495f-89be-6a0c67283ebc
  modified: 2026-08-25T17:28:24.971Z
---

**Symptom:** one or more Android emulators show **"No internet connection / Retry"** (or the harness
login times out waiting for Home) while the **host Mac is fully online**. Confirm with
`adb -s emulator-<port> shell getprop net.dns1` → **empty** on the affected emulator(s), and
`adb -s emulator-<port> shell ping -c1 google.com` → **"unknown host"** (raw IP ping to 8.8.8.8 may
still partly work — it's a DNS failure, not a routing failure).

**Cause:** the AVDs were launched **without `-dns-server`**, so they inherited DNS from the host at
boot. When the host network changes afterward (Wi‑Fi switch, VPN toggle, sleep/wake) the emulators'
DNS gets wiped and never returns. Runtime fixes do NOT stick on modern Android images:
`svc wifi/data`, airplane-mode cycle, `setprop net.dns1`, and `adb root` + `ndc resolver setnetdns`
(rejected: "500 Command not recognized") all fail.

**Standing rule (per the QA lead, 2026-08-25): when this happens, ALWAYS restart the emulators with an
explicit DNS server** — do not sink time into runtime patching:

```
for E in 5554 5556 5558 5560; do adb -s emulator-$E emu kill; done   # wait ~10s; kill -9 stragglers
EMU=~/Library/Android/sdk/emulator/emulator
for AVD in Pixel_6_API34 qa_pixel6 delta_2 delta_3; do               # launch order fixes ports 5554,5556,5558,5560
  nohup $EMU @$AVD -dns-server 8.8.8.8 -no-snapshot-save >/tmp/emu_$AVD.log 2>&1 & sleep 2
done
```

Prefer launching every Delta emulator with `-dns-server 8.8.8.8` from the start so it can't recur.
After restart the persona sessions are gone → the harness re-logs in (slow, ~2–3 min per device; see
[[delta-status]]). Pre-login each emulator FOREGROUND from the main thread (Bash `timeout` param
raised to 300000ms — macOS has no `timeout` command and the Bash tool auto-backgrounds past 120s),
then hand ready sessions to executor lanes so they never have to log in.

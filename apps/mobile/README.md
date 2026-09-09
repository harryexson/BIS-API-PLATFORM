# BIS API Platform — Mobile

Expo (React Native, SDK 57) app for issuing and verifying the platform's
NFC/QR credentials — the same primitive used for event check-in, asset/
shipment tracking, and membership/loyalty cards. It talks directly to the
`/v1/api/gateway/credentials*` endpoints in `services/api-gateway`.

## Screens

- **Setup** — enter the gateway URL, application API key, and tenant ID.
  Stored in the OS keychain/keystore via `expo-secure-store`, never in
  plain state or AsyncStorage.
- **Home** — two actions: issue a credential, or scan/verify one.
- **Issue** (encode) — pick a purpose (check-in / asset tracking /
  membership) and owner, then either render the resulting token as a QR
  code (`react-native-qrcode-svg`) or write it to an NFC tag
  (`react-native-nfc-manager`).
- **Scan** (read) — camera-based QR scanning (`expo-camera`'s
  `CameraView.onBarcodeScanned`) or an NFC tap-to-read, both resolving to
  the same `POST /v1/api/gateway/credentials/verify` call and the same
  valid / expired / revoked / unknown result display.

## Monorepo integration

This app lives inside the repo's npm workspaces (`apps/*`). npm hoists
whatever it can to the workspace root's `node_modules` and leaves the rest
nested under `apps/mobile/node_modules` — `metro.config.js` adds the
workspace root to Metro's resolver search path on top of its normal
hierarchical lookup so both cases resolve.

## Running it

```
cd apps/mobile
npm run start      # Expo dev server — scan the QR with Expo Go, or press i/a
npm run ios
npm run android
```

On first launch you'll land on **Setup**. Point it at a running
`services/api-gateway` instance reachable from the device/simulator (not
`localhost` on a physical device — use your machine's LAN IP or a tunnel).

## What's verified vs. not

**Verified in this environment:** `tsc --noEmit` passes; `expo export`
successfully bundles both the Android and iOS JS targets through Metro
(3000+ modules resolved, real Hermes bytecode produced) — this exercises
the full dependency graph and monorepo resolution, not just syntax.

**Not verified here (no device, simulator, or EAS access in this
sandbox):** on-device behavior of camera scanning, NFC read/write against
real hardware, iOS/Android permission prompts, `expo prebuild`/native
build output, and app store submission. Test all of these on real hardware
before shipping — NFC and camera behavior in particular varies enough
across devices that bundling successfully is necessary but not sufficient
evidence they work.

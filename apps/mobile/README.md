# BIS API Platform — Mobile

Expo (React Native, SDK 57) app shell for connecting to the BIS API Platform
gateway. Scaffolded via the official create-expo-app CLI so dependency
versions resolve against whatever is actually current rather than guessed
version numbers pinned from training data.

## Screens

- **Setup** — enter the gateway URL, application API key, and tenant ID.
  Stored in the OS keychain/keystore via `expo-secure-store`, never in
  plain state or AsyncStorage.
- **Home** — confirms the active gateway connection; sign-out returns to Setup.

This is currently a connection shell with no feature screens beyond that —
add resource modules under `src/api/` and screens under `src/screens/` as
features are built, following the existing `request()` helper in
`src/api/client.ts` (auth + tenant headers, flat error unwrapping) for any
new gateway calls.

## Monorepo integration

This app lives inside the repo's npm workspaces (`apps/*`). npm hoists
whatever it can to the workspace root's `node_modules` and leaves the rest
nested inside `apps/mobile/node_modules/expo/node_modules` — Metro's default
resolver only searches the project's own node_modules, so most packages
failed to resolve. `metro.config.js` points the resolver at the workspace
root in addition to (not instead of) Metro's normal hierarchical lookup; an
initial attempt that set `disableHierarchicalLookup: true` broke resolution
of expo's own nested `expo-modules-core`, so that flag is not used.

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

**Verified in this environment:** `tsc --noEmit` passes; `expo export
--platform ios --platform android` (this workspace's `build` script, and
part of the root type-check/build:all chains) successfully bundles both
targets through Metro — real Hermes bytecode produced, exercising the full
dependency graph and monorepo resolution, not just syntax.

**Not verified here (no device, simulator, or EAS access in this
sandbox):** on-device behavior, OS permission prompts, `expo prebuild`
native output, and app store submission. Test all of these on real
hardware before shipping.

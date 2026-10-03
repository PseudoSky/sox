# Expo / React Native Playbook

For Expo SDK 52+ and React Native 0.76+ (New Architecture). Extends the shared principles
in `SKILL.md`. Native budgets differ from web: 60 FPS and a launch budget replace Core Web
Vitals, and platform guidelines are part of accessibility.

## Checklist

- Expo SDK 52+; Strict TypeScript.
- Expo Router file-based navigation.
- Native modules via the Expo Modules API or config plugins (no manual native edits where
  a config plugin exists).
- 60 FPS on both platforms; launch budget met.
- EAS Update for OTA; EAS Build for store submissions.
- Accessibility (screen readers, dynamic type) verified.

## Architecture

- **Project structure** — Expo Router file-based routing, feature folders, platform
  overrides (`.ios.tsx` / `.android.tsx`), `app.config.ts`, config plugins, and
  monorepo/workspace support.
- **Navigation** — Expo Router v3: stack, tab, and drawer navigators, modals, deep and
  universal links, auth guards, and typed routes.
- **State & data** — TanStack Query, Zustand, Context for auth/theme, AsyncStorage, and
  SecureStore / react-native-mmkv for sensitive or fast storage; optimistic updates and
  offline-first behavior.

## UI & animation

- Reanimated 3, Gesture Handler, Skia, Lottie, SVG, `expo-image`, `safe-area-context`,
  `useWindowDimensions`, and `expo-haptics`. Respect reduced-motion and platform
  conventions (Material on Android, Human Interface Guidelines on iOS).

## Native features

- `expo-camera`, `expo-image-picker`, `expo-notifications`, `expo-location`,
  `expo-local-authentication`, `expo-file-system`, `expo-av` — each behind the platform
  permission flow.

## Performance

- `FlashList` over `FlatList` for long lists, Hermes engine, the New Architecture
  (Fabric/TurboModules), React DevTools profiling, lazy screen loading, and memoization
  where measured. Target 60 FPS and launch <2s.

## Platform-specific

- **iOS** — safe areas, Dynamic Island, App Tracking Transparency, APNs.
- **Android** — back handler, runtime permissions, FCM.
- Tablet/foldable layouts; widgets and Live Activities where relevant.

## Testing

- Jest + React Native Testing Library for components; Detox or Maestro for E2E; MSW for
  network mocking; Istanbul for coverage; snapshots sparingly.

## Deployment (EAS)

- EAS Build profiles, code signing, versioning, EAS Update branches, and EAS Submit for
  the stores; wire Sentry or Bugsnag for crash/error reporting.

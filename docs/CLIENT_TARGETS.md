# Client Targets

Tamishra Workspace ships from one shared frontend.

## Website

Technology:
- Next.js App Router
- static export for portable packaging
- responsive desktop/tablet/mobile layout

Build:
- npm run build:web

Output:
- apps/web/out

## Windows desktop

Technology:
- Tauri v2
- Rust host
- WebView2 frontend
- shared apps/web output

Build:
- npm run desktop:build

Primary targets:
- Windows NSIS executable installer
- Windows MSI installer

## Mobile

Technology:
- Capacitor
- shared apps/web output
- Android and iOS native containers

Android:
- APK for direct testing
- AAB for store distribution

iOS:
- Xcode archive / IPA through the normal Apple signing pipeline

## Why one frontend

The Workspace shell, app launcher, navigation, accessibility, theme, commands and future office editors should behave consistently across web, desktop and mobile. Native wrappers add OS-specific integrations without creating three separate products.

# Tamishra Workspace Mobile

The mobile application wraps the same production web build used by the website and desktop application.

## Android

From the repository root:

1. npm install
2. npm run build:web
3. npm run mobile:add:android
4. npm run mobile:sync
5. npm run android --workspace @tamishra/mobile

The generated Android project can be opened in Android Studio and packaged as APK/AAB.

## iOS

On macOS with Xcode:

1. npm install
2. npm run build:web
3. npm run mobile:add:ios
4. npm run mobile:sync
5. npm run ios --workspace @tamishra/mobile

## Shared product rule

Do not fork the Workspace UI unless a native platform behavior requires it. Cross-platform visual and interaction improvements belong in apps/web or a shared package.

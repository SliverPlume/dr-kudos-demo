#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Override these environment variables when using another SDK/JDK installation.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ -z "${JAVA_HOME:-}" && -d '/Applications/Android Studio.app/Contents/jbr/Contents/Home' ]]; then
  export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
npx expo prebuild --platform android --no-install
cd android
# Finish JS/Hermes before native compilation; avoid concurrent heavy tasks.
./gradlew :app:createBundleReleaseJsAndAssets -PreactNativeArchitectures=arm64-v8a --max-workers=1 --no-parallel
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=1 --no-parallel

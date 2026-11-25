#!/bin/sh
# Erzeugt die App-Icons (PNG) aus icon-ios.svg und icon-mac.svg. Braucht: brew install librsvg
set -e
cd "$(dirname "$0")"
IOS=../iOS/Assets.xcassets/AppIcon.appiconset
MAC=../Mac/Assets.xcassets/AppIcon.appiconset
rsvg-convert -w 1024 -h 1024 icon-ios.svg -o "$IOS/icon-1024.png"
for s in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $s -h $s icon-mac.svg -o "$MAC/icon-$s.png"
done

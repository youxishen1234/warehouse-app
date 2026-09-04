#!/bin/bash
set -e

echo "=== 安装 CocoaPods ==="
sudo gem install cocoapods

echo "=== 同步 Capacitor ==="
npx cap sync ios

echo "=== 安装 iOS 依赖 ==="
cd ios/App
pod install

echo "=== 编译 IPA（无签名）==="
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

echo "=== 打包 IPA ==="
mkdir -p Payload
cp -R build/Build/Products/Release-iphoneos/App.app Payload/
zip -r 仓库管理系统.ipa Payload

echo "=== 完成 ==="
ls -lh 仓库管理系统.ipa

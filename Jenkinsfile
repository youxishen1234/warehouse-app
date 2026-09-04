pipeline {
  agent any
  stages {
    stage('Build iOS IPA') {
      agent {
        node {
          label 'macos'
        }
      }
      steps {
        sh 'sudo gem install cocoapods'
        sh 'npx cap sync ios'
        sh 'cd ios/App && pod install'
        sh '''cd ios/App && \
          xcodebuild \
          -workspace App.xcworkspace \
          -scheme App \
          -configuration Release \
          -sdk iphoneos \
          -derivedDataPath build \
          CODE_SIGNING_ALLOWED=NO \
          CODE_SIGNING_REQUIRED=NO \
          CODE_SIGN_IDENTITY="" \
          build && \
          mkdir -p Payload && \
          cp -R build/Build/Products/Release-iphoneos/App.app Payload/ && \
          zip -r 仓库管理系统.ipa Payload'''
        archiveArtifacts artifacts: 'ios/App/仓库管理系统.ipa', fingerprint: true
      }
    }
  }
}

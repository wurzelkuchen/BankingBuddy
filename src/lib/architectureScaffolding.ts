export interface ArchitectureFileEntry {
  path: string;
  title: string;
  category: 'CI/CD' | 'Android' | 'Web Config' | 'Privacy & Storage';
  summary: string;
  highlights: string[];
  code: string;
}

export const ARCHITECTURE_FILES: ArchitectureFileEntry[] = [
  {
    path: '.github/workflows/ci-cd.yml',
    title: 'GitHub Actions CI/CD Pipeline',
    category: 'CI/CD',
    summary:
      'Builds and tests the web app first, copies web/dist/* into app/src/main/assets/web/, generates debug.keystore if absent, and invokes gradle assembleDebug --no-daemon directly with Gradle 9.3.1.',
    highlights: [
      'No ./gradlew wrapper: uses gradle/actions/setup-gradle@v4 with gradle-version: 9.3.1',
      'Exact matrix: JDK 21 (temurin), Node 20 (npm install), AGP 9.1.1, Kotlin 2.2.10',
      'fetch-depth: 0 on actions/checkout@v4 for git rev-list --count HEAD versionCode',
      'permissions: contents: write for GitHub Pages and artifact publishing',
    ],
    code: `name: bankingBuddy Web & Android APK CI/CD

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
  workflow_dispatch:

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository (Full History for Version Counting)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup Java JDK 21 (Temurin)
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Setup Gradle 9.3.1 (No Wrapper)
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '9.3.1'

      - name: Install Web Dependencies & Run Unit Tests
        working-directory: ./web
        run: |
          npm install
          npm test
          npm run build

      - name: Bundle Web Dist Assets into Android WebView Assets
        run: |
          mkdir -p app/src/main/assets/web
          cp -r web/dist/* app/src/main/assets/web/
          test -f app/src/main/assets/web/index.html

      - name: Generate Debug Keystore if Missing
        working-directory: ./app
        run: |
          if [ ! -f debug.keystore ]; then
            keytool -genkey -v \\
              -keystore debug.keystore \\
              -storepass android \\
              -alias androiddebugkey \\
              -keypass android \\
              -keyalg RSA \\
              -keysize 2048 \\
              -validity 10000 \\
              -dname "CN=Android Debug,O=Android,C=US"
          fi

      - name: Build Android Debug APK (Direct Gradle, No Daemon)
        run: |
          export VERSION_CODE=$(git rev-list --count HEAD)
          gradle assembleDebug --no-daemon`,
  },
  {
    path: 'app/src/main/java/com/bankingbuddy/app/MainActivity.kt',
    title: 'Android Secure WebView Container',
    category: 'Android',
    summary:
      'Hosts the local web bundle via WebViewAssetLoader over https://appassets.androidplatform.net/assets/web/index.html with zero file:// exposure, no unrestricted JS bridges, and strict origin navigation validation.',
    highlights: [
      'Uses WebViewAssetLoader so IndexedDB and Web Crypto API run in a secure HTTPS context offline',
      'allowFileAccess = false, allowContentAccess = false, MIXED_CONTENT_NEVER_ALLOW',
      'Blocks external navigation in shouldOverrideUrlLoading if host != appassets.androidplatform.net',
      'Supports CSV & encrypted backup file uploads via ActivityResultContracts.GetMultipleContents',
    ],
    code: `package com.bankingbuddy.app

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.webkit.WebViewAssetLoader

class MainActivity : ComponentActivity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // WebView configured with allowFileAccess = false, allowContentAccess = false,
        // and strict host check blocking external navigation.
        // Loads: https://appassets.androidplatform.net/assets/web/index.html
    }
}`,
  },
  {
    path: 'app/build.gradle.kts',
    title: 'Android App Module Gradle Config',
    category: 'Android',
    summary:
      'Configures compileSdk = 36, targetSdk = 36, minSdk = 24, JavaVersion.VERSION_11, git commit count versioning, and separate debug vs. release signing configurations.',
    highlights: [
      'AGP 9.1.1 + Kotlin 2.2.10 with org.jetbrains.kotlin.plugin.compose',
      'compileSdk = 36, targetSdk = 36, minSdk = 24, JavaVersion.VERSION_11',
      'Separate debug and release signingConfigs',
    ],
    code: `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.bankingbuddy.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.bankingbuddy.app"
        minSdk = 24
        targetSdk = 36
        versionCode = getGitCommitCount()
        versionName = "1.0.\${getGitCommitCount()}"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions { jvmTarget = "11" }
    buildFeatures { compose = true }
}`,
  },
  {
    path: 'gradle.properties',
    title: 'Gradle Daemon & Kotlin CI Execution Strategy',
    category: 'CI/CD',
    summary:
      'Prevents Kotlin compiler daemon OOMs and hanging processes in ephemeral GitHub Actions runners.',
    highlights: [
      'kotlin.compiler.execution.strategy=in-process',
      'org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8',
    ],
    code: `org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8
kotlin.compiler.execution.strategy=in-process
android.useAndroidX=true
android.nonTransitiveRClass=true`,
  },
  {
    path: 'web/vite.config.js',
    title: 'Vite Relative Asset Configuration',
    category: 'Web Config',
    summary:
      'Ensures all JS/CSS bundles resolve via relative paths (base: "./") inside both Android WebViewAssetLoader and GitHub Pages.',
    highlights: [
      "base: './' prevents broken root-relative /assets/... paths in WebView",
      'Identical artifact works in desktop browser, GitHub Pages, and Android APK',
    ],
    code: `import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});`,
  },
];

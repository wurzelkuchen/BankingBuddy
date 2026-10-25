package com.bankingbuddy.app

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader

/**
 * Secure Android WebView container for bankingBuddy.
 *
 * Security & Privacy Architecture:
 * 1. Serves bundled web assets over HTTPS virtual origin (`https://appassets.androidplatform.net/assets/web/index.html`)
 *    via `WebViewAssetLoader` so IndexedDB and Web Crypto API (`crypto.subtle`) operate in a secure origin offline.
 * 2. Disables `allowFileAccess`, `allowContentAccess`, mixed content, and unrestricted JS bridges.
 * 3. Blocks all external navigation (`shouldOverrideUrlLoading`) unless validated against the local asset host.
 * 4. Distinguishes browser storage (IndexedDB inside WebView sandbox) from Android Keystore-backed native storage.
 */
class MainActivity : ComponentActivity() {

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var webViewInstance: WebView? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri> ->
        filePathCallback?.onReceiveValue(uris.toTypedArray())
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(LOCAL_ASSET_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webViewInstance
                if (wv != null && wv.canGoBack()) {
                    wv.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        setContent {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    WebView(context).apply {
                        webViewInstance = this

                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            databaseEnabled = true
                            // Strict file & content isolation
                            allowFileAccess = false
                            allowContentAccess = false
                            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            setSupportMultipleWindows(false)
                            javaScriptCanOpenWindowsAutomatically = false
                            cacheMode = WebSettings.LOAD_DEFAULT
                        }

                        webViewClient = object : WebViewClient() {
                            override fun shouldInterceptRequest(
                                view: WebView?,
                                request: WebResourceRequest
                            ): WebResourceResponse? {
                                return assetLoader.shouldInterceptRequest(request.url)
                            }

                            override fun shouldOverrideUrlLoading(
                                view: WebView?,
                                request: WebResourceRequest
                            ): Boolean {
                                val url = request.url
                                // Strictly block navigation away from the local WebViewAssetLoader origin
                                return url.host != LOCAL_ASSET_DOMAIN
                            }
                        }

                        webChromeClient = object : WebChromeClient() {
                            override fun onShowFileChooser(
                                webView: WebView?,
                                filePathCallback: ValueCallback<Array<Uri>>?,
                                fileChooserParams: FileChooserParams?
                            ): Boolean {
                                this@MainActivity.filePathCallback?.onReceiveValue(null)
                                this@MainActivity.filePathCallback = filePathCallback
                                fileChooserLauncher.launch("*/*")
                                return true
                            }
                        }

                        loadUrl("https://$LOCAL_ASSET_DOMAIN/assets/web/index.html")
                    }
                }
            )
        }
    }

    companion object {
        const val LOCAL_ASSET_DOMAIN = "appassets.androidplatform.net"
    }
}

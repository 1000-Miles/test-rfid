# Keep the Chainway SDK (JNI-backed) intact under R8/ProGuard.
-keep class com.rscja.** { *; }
-dontwarn com.rscja.**

# Keep the WebView JS bridge entry points.
-keepclassmembers class biz.thousandmiles.wolf.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}

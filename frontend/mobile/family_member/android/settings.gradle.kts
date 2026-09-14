pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}

// Gradle defaults the root project's name to its containing folder's name, which for every
// Flutter app in this repo is literally "android" (frontend/mobile/<app>/android). That collides
// when both this project and frontend/mobile/caregiver/android are open/built together in the
// same IDE/Gradle session ("A project with the name 'android' already exists" / "Duplicate root
// element android") - explicit, unique name avoids it without touching the caregiver app at all.
rootProject.name = "family_member_android"

include(":app")

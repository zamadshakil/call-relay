import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val googleServicesFile = file("google-services.json")

if (googleServicesFile.exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "dev.zamad.callrelay"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.zamad.callrelay"
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "0.3.0-webrtc-alpha"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "FCM_CONFIGURED", googleServicesFile.exists().toString())
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_API_BASE_URL", "\"https://call-relay-staging.zamadshakil.workers.dev\"")
        }
        release {
            buildConfigField("String", "DEFAULT_API_BASE_URL", "\"https://call-relay.zamadshakil.workers.dev\"")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        buildConfig = true
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(googleServicesFile.exists()) {
            "app/google-services.json is required for a functional release build"
        }
    }
}

dependencies {
    implementation("io.github.webrtc-sdk:android-prefixed:144.7559.09")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-messaging")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}

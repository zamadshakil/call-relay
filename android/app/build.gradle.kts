import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
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
        versionCode = 4
        versionName = "0.4.1-echo-control-alpha"
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
        compose = true
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(googleServicesFile.exists()) {
            "app/google-services.json is required for a functional release build"
        }
        val firebase = JsonSlurper().parse(googleServicesFile) as Map<*, *>
        val clients = firebase["client"] as? List<*> ?: emptyList<Any>()
        val hasWebOAuthClient = clients.any { client ->
            val oauthClients = (client as? Map<*, *>)?.get("oauth_client") as? List<*> ?: emptyList<Any>()
            oauthClients.any { oauth -> ((oauth as? Map<*, *>)?.get("client_type") as? Number)?.toInt() == 3 }
        }
        check(hasWebOAuthClient) {
            "app/google-services.json has no Web OAuth client. Add signing fingerprints and a Web client in Firebase, then download it again."
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.navigation:navigation-compose:2.9.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("androidx.browser:browser:1.9.0")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("com.googlecode.libphonenumber:libphonenumber:9.0.15")
    implementation("com.google.zxing:core:3.5.3")
    implementation("io.github.webrtc-sdk:android-prefixed:144.7559.09")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-installations")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

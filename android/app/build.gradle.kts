plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.beayy.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.beayy.android"
        minSdk = 26          // UsageStatsManager.queryEvents 需要 21+；前台 Service 语义 26+ 更稳
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.24"
    }

    buildTypes {
        release {
            isMinifyEnabled = false   // Rust 符号要被 JNI 找到，先不混淆
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Rust 产物（beayy_mobile 的 cdylib）由 cargo ndk 放到这里
    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")

    // ui/ 是仓库根目录下的那份，三端共用；打包时当成 assets
    sourceSets["main"].assets.srcDirs("../../ui")

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}

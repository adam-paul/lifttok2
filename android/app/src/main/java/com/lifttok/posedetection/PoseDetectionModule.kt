package com.lifttok.posedetection

import com.facebook.react.bridge.*
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseDetector
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import com.google.mlkit.vision.pose.PoseLandmark
import java.io.File
import java.lang.ref.WeakReference

class PoseDetectionModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private val detector: PoseDetector by lazy {
        val options = PoseDetectorOptions.Builder()
            .setDetectorMode(PoseDetectorOptions.STREAM_MODE)
            .build()
        PoseDetection.getClient(options)
    }

    private var lastCleanupTime = 0L
    private var lastProcessedFile: WeakReference<File>? = null

    // Map MLKit landmark types to our named points
    private val landmarkMapping = mapOf(
        PoseLandmark.LEFT_SHOULDER to "leftShoulder",
        PoseLandmark.RIGHT_SHOULDER to "rightShoulder",
        PoseLandmark.LEFT_ELBOW to "leftElbow",
        PoseLandmark.RIGHT_ELBOW to "rightElbow",
        PoseLandmark.LEFT_WRIST to "leftWrist",
        PoseLandmark.RIGHT_WRIST to "rightWrist",
        PoseLandmark.LEFT_HIP to "leftHip",
        PoseLandmark.RIGHT_HIP to "rightHip",
        PoseLandmark.LEFT_KNEE to "leftKnee",
        PoseLandmark.RIGHT_KNEE to "rightKnee",
        PoseLandmark.LEFT_ANKLE to "leftAnkle",
        PoseLandmark.RIGHT_ANKLE to "rightAnkle"
    )

    override fun getName() = "PoseDetectionModule"

    private fun normalizeCoordinate(value: Float, dimension: Int): Double {
        val floatValue = value.toFloat()
        val floatDimension = dimension.toFloat()
        return (floatValue / floatDimension).coerceIn(0f, 1f).toDouble()
    }

    @ReactMethod
    fun cleanupCache(promise: Promise) {
        try {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastCleanupTime < 1000) {
                promise.resolve(Arguments.createMap().apply {
                    putInt("deletedFiles", 0)
                    putBoolean("skipped", true)
                })
                return
            }

            val cacheDir = reactApplicationContext.cacheDir
            var deletedCount = 0
            val maxAge = 3 * 1000 // 3 seconds max age

            cacheDir.listFiles()?.forEach { file ->
                if (file.name.startsWith("mrousavy") && file.name.endsWith(".jpg")) {
                    if (currentTime - file.lastModified() > maxAge) {
                        if (file.delete()) {
                            deletedCount++
                        }
                    }
                }
            }

            lastCleanupTime = currentTime
            val result = Arguments.createMap().apply {
                putInt("deletedFiles", deletedCount)
                putBoolean("skipped", false)
            }
            promise.resolve(result)
            
            if (deletedCount > 0) {
                System.gc()
            }
        } catch (e: Exception) {
            promise.reject("CLEANUP_ERROR", e.message)
        }
    }

    @ReactMethod
    fun detectPose(imageData: Dynamic, width: Int, height: Int, promise: Promise) {
        try {
            val image = when {
                imageData.isNull -> {
                    promise.reject("POSE_DETECTION_ERROR", "Image data is null")
                    return
                }
                imageData.type == ReadableType.String -> {
                    val path = imageData.asString()
                    val file = File(path)
                    
                    lastProcessedFile?.get()?.delete()
                    lastProcessedFile = WeakReference(file)
                    
                    InputImage.fromFilePath(reactApplicationContext, android.net.Uri.fromFile(file))
                }
                else -> {
                    promise.reject("POSE_DETECTION_ERROR", "Unsupported image data type: ${imageData.type}")
                    return
                }
            }

            detector.process(image)
                .addOnSuccessListener { pose ->
                    val result = Arguments.createMap()
                    val landmarks = Arguments.createMap()
                    
                    // Add image dimensions to result
                    result.putInt("imageWidth", width)
                    result.putInt("imageHeight", height)
                    
                    pose.allPoseLandmarks.forEach { landmark ->
                        landmarkMapping[landmark.landmarkType]?.let { name ->
                            landmarks.putMap(name, Arguments.createMap().apply {
                                // Return raw coordinates directly
                                putDouble("x", landmark.position.x.toDouble())
                                putDouble("y", landmark.position.y.toDouble())
                                putDouble("visibility", landmark.inFrameLikelihood.toDouble())
                            })
                        }
                    }

                    result.putMap("landmarks", landmarks)
                    result.putBoolean("poseDetected", pose.allPoseLandmarks.isNotEmpty())
                    promise.resolve(result)
                }
                .addOnFailureListener { e ->
                    promise.reject("POSE_DETECTION_ERROR", e.message)
                }
        } catch (e: Exception) {
            promise.reject("POSE_DETECTION_ERROR", e.message)
        }
    }
} 
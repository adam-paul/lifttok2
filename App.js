// App.js
import React, {useState, useEffect, useRef, useCallback} from 'react';
import {View, Text, TouchableOpacity, FlatList, StyleSheet, Dimensions, ActivityIndicator, NativeModules, BackHandler, Image} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Camera, useCameraPermission, useMicrophonePermission, useCameraDevice} from 'react-native-vision-camera';
import Video from 'react-native-video';
import Svg, {Line, Circle} from 'react-native-svg';
import {db, storage} from './firebase';
import {collection, addDoc, getDocs, query, orderBy, startAfter} from 'firebase/firestore';
import {ref, uploadBytes, getDownloadURL} from 'firebase/storage';
import Ionicons from 'react-native-vector-icons/Ionicons';

const {PoseDetectionModule} = NativeModules;

// Constants for pose connections
const POSE_CONNECTIONS = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle']
];

// Visibility thresholds
const VISIBILITY_THRESHOLD = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

// Memoized line component for better performance
const PoseLine = React.memo(({ startPoint, endPoint }) => {
  if (!startPoint || !endPoint || 
      startPoint.visibility < VISIBILITY_THRESHOLD || 
      endPoint.visibility < VISIBILITY_THRESHOLD) return null;
  
  // Calculate average visibility for the line
  const avgVisibility = (startPoint.visibility + endPoint.visibility) / 2;
  
  // Scale opacity based on confidence
  const opacity = Math.max(0.3, avgVisibility);
  
  // Determine stroke color based on confidence
  const strokeColor = avgVisibility > HIGH_CONFIDENCE_THRESHOLD ? '#4CAF50' : '#FFA726';
  
  return (
    <Line
      x1={startPoint.x}
      y1={startPoint.y}
      x2={endPoint.x}
      y2={endPoint.y}
      stroke={strokeColor}
      strokeWidth="2"
      strokeOpacity={opacity}
    />
  );
});

// Memoized point component for better performance
const PosePoint = React.memo(({ point }) => {
  if (!point || point.visibility < VISIBILITY_THRESHOLD) return null;
  
  // Scale point size based on visibility
  const radius = point.visibility > HIGH_CONFIDENCE_THRESHOLD ? 4 : 3;
  
  // Scale opacity based on confidence
  const opacity = Math.max(0.3, point.visibility);
  
  // Determine fill color based on confidence
  const fillColor = point.visibility > HIGH_CONFIDENCE_THRESHOLD ? '#4CAF50' : '#FFA726';
  
  return (
    <Circle
      cx={point.x}
      cy={point.y}
      r={radius}
      fill={fillColor}
      fillOpacity={opacity}
    />
  );
});

// Dynamic wireframe overlay based on pose data
const WireframeOverlay = React.memo(({poseData}) => {
  if (!poseData) return null;
  
  // Calculate overall pose confidence
  const avgConfidence = Object.values(poseData)
    .reduce((sum, point) => sum + (point.visibility || 0), 0) / Object.keys(poseData).length;
  
  return (
    <Svg style={StyleSheet.absoluteFill}>
      {/* Render confidence indicator */}
      {avgConfidence < HIGH_CONFIDENCE_THRESHOLD && (
        <Text
          x="10"
          y="30"
          fill="#FFA726"
          opacity={0.8}
          fontSize="12"
        >
          Low Confidence Detection
        </Text>
      )}
      
      {POSE_CONNECTIONS.map(([start, end], index) => (
        <PoseLine
          key={`${start}-${end}`}
          startPoint={poseData[start]}
          endPoint={poseData[end]}
        />
      ))}
      {Object.entries(poseData).map(([key, point]) => (
        <PosePoint key={key} point={point} />
      ))}
    </Svg>
  );
});

const viewabilityConfig = {
  itemVisiblePercentThreshold: 50
};

// Video Item Component
const VideoItem = React.memo(({ item, isActive, height, onPress, videoRef }) => {
  const [isBuffering, setIsBuffering] = useState(true);
  const [videoDimensions, setVideoDimensions] = useState(null);
  const [currentPoseData, setCurrentPoseData] = useState(null);
  const screenDimensions = Dimensions.get('window');
  const videoProgress = useRef(0);

  const transformPoseData = (poseData, videoDims) => {
    if (!poseData) return null;
    
    const xFactor = screenDimensions.width / poseData.dimensions.width;
    const yFactor = screenDimensions.height / poseData.dimensions.height;
    
    const transformedLandmarks = {};
    Object.entries(poseData.landmarks).forEach(([key, point]) => {
      transformedLandmarks[key] = {
        x: point.x * xFactor,
        y: point.y * yFactor,
        visibility: point.visibility
      };
    });
    
    return transformedLandmarks;
  };

  // Update pose data based on video progress
  const updatePoseData = (currentTimeMillis) => {
    if (!isActive || !item.poseData) return;
    
    const currentFrame = item.poseData.find((frame, index) => {
      const nextFrame = item.poseData[index + 1];
      return frame.timestamp <= currentTimeMillis && (!nextFrame || nextFrame.timestamp > currentTimeMillis);
    });

    if (currentFrame) {
      setCurrentPoseData(transformPoseData(currentFrame, videoDimensions));
    }
  };

  return (
    <TouchableOpacity 
      activeOpacity={1}
      onPress={onPress}
      style={{height}}
    >
      <Video 
        ref={videoRef}
        source={{uri: item.videoUrl}} 
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        repeat
        paused={!isActive}
        poster={item.thumbnailUrl}
        posterResizeMode="cover"
        bufferConfig={{
          minBufferMs: 3000,
          maxBufferMs: 5000,
          bufferForPlaybackMs: 500,
          bufferForPlaybackAfterRebufferMs: 2000
        }}
        maxBitRate={2000000}
        ignoreSilentSwitch="ignore"
        onError={(error) => console.log('Video error:', error)}
        onBuffer={({isBuffering: buffering}) => {
          setIsBuffering(buffering);
          // If buffering, keep the last pose data visible
        }}
        onLoad={(data) => {
          setIsBuffering(false);
          setVideoDimensions({
            width: data.naturalSize.width,
            height: data.naturalSize.height
          });
        }}
        onProgress={({currentTime}) => {
          // Convert to milliseconds to match our timestamp format
          const currentTimeMillis = currentTime * 1000;
          videoProgress.current = currentTimeMillis;
          updatePoseData(currentTimeMillis % (item.poseData?.[item.poseData.length - 1]?.timestamp || 0));
        }}
        progressUpdateInterval={30}  // Update more frequently for smoother animation
        playInBackground={false}
        controls={false}
        muted={!isActive}
        reportBandwidth={true}
      />
      {currentPoseData && isActive && (
        <WireframeOverlay poseData={currentPoseData} />
      )}
      {isBuffering && (
        <View style={styles.bufferingOverlay}>
          <ActivityIndicator size="large" color="white" />
        </View>
      )}
    </TouchableOpacity>
  );
});

/* Feed Screen: Fetches video docs from Firestore and plays each video with an overlaid wireframe */
const FeedScreen = ({ navigation, initialVideo, videos: initialVideos, onClose }) => {
  const [videos, setVideos] = useState(initialVideos || []);
  const [activeVideoId, setActiveVideoId] = useState(initialVideo?.id || null);
  const [isLoading, setIsLoading] = useState(!initialVideos);
  const [refreshing, setRefreshing] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const screenHeight = Dimensions.get('window').height;
  const bottomTabHeight = 49;
  const videoRefs = useRef({});

  // Get initial index for scrolling
  const initialScrollIndex = initialVideo ? videos.findIndex(v => v.id === initialVideo.id) : 0;

  // Required for initialScrollIndex to work
  const getItemLayout = (data, index) => ({
    length: screenHeight - bottomTabHeight,
    offset: (screenHeight - bottomTabHeight) * index,
    index,
  });

  // Handle hardware back button
  useEffect(() => {
    if (!initialVideo) return;

    const backAction = () => {
      if (onClose) {
        onClose();
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, [initialVideo, onClose]);

  const fetchVideos = async (lastDocument = null) => {
    if (initialVideos) return initialVideos;
    
    try {
      const queryConstraints = [
        orderBy("createdAt", "desc"),
      ];
      
      if (lastDocument) {
        queryConstraints.push(startAfter(lastDocument));
      }

      const videosQuery = query(
        collection(db, "videos"),
        ...queryConstraints
      );

      const querySnapshot = await getDocs(videosQuery);
      const vids = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      if (vids.length > 0) {
        setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1]);
      }
      
      return vids;
    } catch (error) {
      console.error('Error fetching videos:', error);
      return [];
    }
  };

  const loadInitial = async () => {
    if (initialVideos) {
      setVideos(initialVideos);
      if (initialVideo) setActiveVideoId(initialVideo.id);
      setIsLoading(false);
      return;
    }

    const vids = await fetchVideos();
    setVideos(vids);
    if (vids.length > 0) setActiveVideoId(vids[0].id);
    setIsLoading(false);
  };

  const loadMore = async () => {
    if (initialVideos || !lastDoc) return;
    const newVids = await fetchVideos(lastDoc);
    if (newVids.length > 0) {
      setVideos(prev => [...prev, ...newVids]);
    }
  };

  const cleanupFeed = () => {
    setActiveVideoId(null);
    Object.values(videoRefs.current).forEach(ref => {
      if (ref?.current?.seek) {
        ref.current.seek(0);
      }
    });
  };

  useEffect(() => {
    loadInitial();
    return () => cleanupFeed();
  }, []);

  useEffect(() => {
    if (!navigation) return;
    const unsubscribe = navigation.addListener('blur', () => {
      cleanupFeed();
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    if (!navigation) return;
    const unsubscribeFocus = navigation.addListener('focus', () => {
      if (videos.length > 0) setActiveVideoId(videos[0].id);
    });
    const unsubscribeBlur = navigation.addListener('blur', cleanupFeed);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation, videos]);

  const onViewableItemsChanged = useRef(({viewableItems}) => {
    if (viewableItems.length > 0) {
      const activeItem = viewableItems[0].item;
      setActiveVideoId(activeItem.id);
      
      // Preload next video
      const currentIndex = videos.findIndex(v => v.id === activeItem.id);
      const nextVideo = videos[currentIndex + 1];
      if (nextVideo && videoRefs.current[nextVideo.id]?.current) {
        videoRefs.current[nextVideo.id].current.seek(0);
      }
    }
  }).current;

  if (isLoading) {
    return (
      <View style={[styles.center, {backgroundColor: 'black'}]}>
        <ActivityIndicator size="large" color="white" />
      </View>
    );
  }

  const renderVideo = ({item, index}) => {
    const isActive = activeVideoId === item.id;
    videoRefs.current[item.id] = videoRefs.current[item.id] || React.createRef();

    return (
      <VideoItem
        item={item}
        isActive={isActive}
        height={screenHeight - bottomTabHeight}
        onPress={() => setActiveVideoId(isActive ? null : item.id)}
        videoRef={videoRefs.current[item.id]}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      {initialVideo && (
        <TouchableOpacity 
          style={styles.backButton}
          onPress={onClose}
        >
          <Ionicons name="close" size={24} color="white" />
        </TouchableOpacity>
      )}
      <FlatList
        data={videos}
        keyExtractor={item => item.id}
        renderItem={renderVideo}
        pagingEnabled
        snapToInterval={screenHeight - bottomTabHeight}
        decelerationRate="fast"
        disableIntervalMomentum
        snapToAlignment="start"
        refreshing={refreshing}
        onRefresh={loadInitial}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        removeClippedSubviews={true}
        maxToRenderPerBatch={2}
        windowSize={3}
        initialNumToRender={1}
        updateCellsBatchingPeriod={100}
        getItemLayout={getItemLayout}
        initialScrollIndex={initialScrollIndex >= 0 ? initialScrollIndex : undefined}
      />
    </View>
  );
};

/* Record Screen: Displays the camera preview with a wireframe overlay and a record button */
const RecordScreen = ({ navigation }) => {
  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } = useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } = useMicrophonePermission();
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isFront, setIsFront] = useState(false);
  const [poseData, setPoseData] = useState(null);
  const [isPoseDetected, setIsPoseDetected] = useState(false);
  const device = useCameraDevice(isFront ? 'front' : 'back');
  const cameraRef = useRef(null);
  const cleanupInterval = useRef(null);
  const lastProcessedTime = useRef(0);
  const processingFrame = useRef(false);
  const dimensions = Dimensions.get('window');
  
  // Add memory pressure tracking
  const memoryPressureRef = useRef(false);
  const skippedFramesRef = useRef(0);
  const maxSkippedFrames = 3;
  const recordedPoseData = useRef([]);  // Store all pose data during recording
  const recordingStartTime = useRef(null);

  // Optimize cache cleanup with memory pressure handling
  const cleanupCache = async () => {
    try {
      const response = await NativeModules.PoseDetectionModule.cleanupCache();
      if (memoryPressureRef.current && response.success) {
        memoryPressureRef.current = false;
        skippedFramesRef.current = 0;
      }
    } catch (error) {
      console.log('Cache cleanup error:', error);
      memoryPressureRef.current = true;
    }
  };

  const cleanupRecord = async () => {
    if (recording && cameraRef.current) {
      try {
        await cameraRef.current.stopRecording();
      } catch (error) {
        console.log('Error stopping recording:', error);
      }
    }
    setRecording(false);
    setPoseData(null);
    setIsPoseDetected(false);
    if (cleanupInterval.current) {
      clearInterval(cleanupInterval.current);
      cleanupInterval.current = null;
    }
    // Force cleanup and reset memory pressure state
    memoryPressureRef.current = false;
    skippedFramesRef.current = 0;
    await cleanupCache();
  };

  useEffect(() => {
    // Start periodic cache cleanup
    cleanupInterval.current = setInterval(cleanupCache, 5000); // Cleanup every 5 seconds
    
    return () => {
      if (cleanupInterval.current) {
        clearInterval(cleanupInterval.current);
      }
      // Final cleanup when component unmounts
      cleanupCache();
    };
  }, []);

  useEffect(() => {
    console.log(`Pose detection: ${isPoseDetected ? 'DETECTED' : 'NOT DETECTED'}`);
  }, [isPoseDetected]);
  
  useEffect(() => {    
    if (!device || !cameraRef.current) return;

    const frameInterval = setInterval(async () => {
      const now = Date.now();
      if (processingFrame.current || now - lastProcessedTime.current < 200) {
        return;
      }

      // Skip frames under memory pressure
      if (memoryPressureRef.current) {
        skippedFramesRef.current++;
        if (skippedFramesRef.current >= maxSkippedFrames) {
          await cleanupCache();
        }
        return;
      }

      processingFrame.current = true;
      try {
        const frame = await cameraRef.current.takePhoto({
          qualityPrioritization: 'balanced',
          skipMetadata: true,
          flash: 'off',
          enableAutoStabilization: false,
          enableShutterSound: false,
          quality: 0.8,
          width: 720,
          height: 1280,
          format: 'jpeg'
        });
        
        if (!frame.path) return;

        // Log every 10th frame
        if (skippedFramesRef.current % 10 === 0) {
          console.log(`Frame dimensions: ${frame.width}x${frame.height}`);
          console.log(`Screen dimensions: ${dimensions.width}x${dimensions.height}`);
          console.log(`Memory pressure: ${memoryPressureRef.current ? 'YES' : 'NO'}`);
          console.log('---');
        }

        const result = await NativeModules.PoseDetectionModule.detectPose(
          frame.path,
          frame.width,
          frame.height
        );
        
        lastProcessedTime.current = now;
        setIsPoseDetected(!!result.poseDetected);

        if (result.landmarks) {
          const xFactor = dimensions.width / result.imageWidth;
          const yFactor = dimensions.height / result.imageHeight;

          const transformedLandmarks = {};
          Object.entries(result.landmarks).forEach(([key, point]) => {
            transformedLandmarks[key] = {
              x: (point.x * xFactor) + 50,
              y: (point.y * yFactor) - 100,
              visibility: point.visibility
            };
          });
          
          setPoseData(transformedLandmarks);
          
          // Store pose data if recording
          if (recording) {
            const timestamp = now - (recordingStartTime.current || now);
            recordedPoseData.current.push({
              timestamp,
              landmarks: transformedLandmarks,
              dimensions: {
                width: dimensions.width,
                height: dimensions.height
              }
            });
          }
        } else {
          setPoseData(null);
        }
        
        if (result.memoryWarning) {
          memoryPressureRef.current = true;
          await cleanupCache();
        }
      } catch (error) {
        console.log('Frame processing error:', error);
        setIsPoseDetected(false);
        setPoseData(null);
        memoryPressureRef.current = true;
      } finally {
        processingFrame.current = false;
      }
    }, 200);

    return () => {
      clearInterval(frameInterval);
      cleanupCache();
    };
  }, [device, cameraRef.current, recording]);

  useEffect(() => {
    (async () => {
      if (!hasCameraPermission) {
        const granted = await requestCameraPermission();
        console.log('Camera permission result:', granted);
      }
      if (!hasMicPermission) {
        const granted = await requestMicPermission();
        console.log('Microphone permission result:', granted);
      }
    })();
  }, []); // Only run on mount
  
  const toggleCamera = () => {
    cleanupCache();  // Cleanup when switching camera
    setIsFront(!isFront);
  };
  
  const toggleRecording = async () => {
    if (!device || !cameraRef.current) return;
    
    try {
      if (recording) {
        setRecording(false);
        await cameraRef.current.stopRecording();
        await cleanupCache();
      } else {
        recordedPoseData.current = [];  // Clear previous recording data
        recordingStartTime.current = Date.now();  // Set start time
        await cleanupCache();
        setRecording(true);

        // Start recording
        await cameraRef.current.startRecording({
          onRecordingFinished: async (video) => {
            try {
              setUploading(true);
              setUploadSuccess(false);

              // Upload video first
              const filename = `videos/${Date.now()}.mp4`;
              const storageRef = ref(storage, filename);
              const response = await fetch(`file://${video.path}`);
              const blob = await response.blob();
              await uploadBytes(storageRef, blob);
              const videoUrl = await getDownloadURL(storageRef);
              
              // Upload the thumbnail we captured during recording
              const thumbnailUrl = await uploadThumbnail.current;
              
              // Store video with thumbnail URL and pose data
              await addDoc(collection(db, "videos"), { 
                videoUrl,
                thumbnailUrl,
                createdAt: Date.now(),
                poseData: recordedPoseData.current.length > 0 ? recordedPoseData.current : null
              });
              
              setUploadSuccess(true);
              setTimeout(() => {
                setUploading(false);
                setUploadSuccess(false);
              }, 1500);
            } catch (error) {
              console.error('Upload error:', error);
              setUploading(false);
            }
          },
          onRecordingError: () => setRecording(false),
          fileType: 'mp4',
          videoCodec: 'h264',
          videoBitRate: 2000000,
          fps: 30
        });

        // Capture thumbnail after a short delay to ensure camera is stable
        setTimeout(async () => {
          try {
            const thumbnailPhoto = await cameraRef.current.takePhoto({
              quality: 0.7,
              skipMetadata: true
            });
            
            const thumbnailFilename = `thumbnails/${Date.now()}.jpg`;
            const thumbnailRef = ref(storage, thumbnailFilename);
            const thumbnailResponse = await fetch(`file://${thumbnailPhoto.path}`);
            const thumbnailBlob = await thumbnailResponse.blob();
            await uploadBytes(thumbnailRef, thumbnailBlob);
            uploadThumbnail.current = getDownloadURL(thumbnailRef);
          } catch (error) {
            console.error('Thumbnail capture error:', error);
          }
        }, 500); // Wait 500ms after recording starts
      }
    } catch {
      setRecording(false);
    }
  };
  
  // Add ref for storing thumbnail URL promise
  const uploadThumbnail = useRef(null);

  useEffect(() => {
    return () => {
      uploadThumbnail.current = null;
    };
  }, []);

  useEffect(() => {
    const unsubscribeBlur = navigation.addListener('blur', cleanupRecord);
    return () => {
      unsubscribeBlur();
      cleanupRecord();
    };
  }, [navigation]);
  
  if (!hasCameraPermission || !hasMicPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera and microphone access is required.</Text>
      </View>
    );
  }
  
  if (!device) return <View style={styles.center}><Text style={styles.text}>Loading camera...</Text></View>;
  
  return (
    <View style={{flex:1}}>
      <View style={StyleSheet.absoluteFill}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={!uploading}
          photo
          video
          audio
        />
        {poseData && <WireframeOverlay poseData={poseData} />}
      </View>
      
      {/* Pose Detection Indicator */}
      <View style={styles.poseIndicator}>
        <Ionicons 
          name="person" 
          size={24} 
          color={isPoseDetected ? '#4CAF50' : '#666'} 
        />
      </View>

      {uploading && (
        <View style={styles.uploadingOverlay}>
          {!uploadSuccess ? (
            <>
              <ActivityIndicator size="large" color="white" />
              <Text style={[styles.text, {marginTop: 10}]}>Uploading video...</Text>
            </>
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={50} color="#4CAF50" />
              <Text style={[styles.text, {marginTop: 10}]}>Success!</Text>
            </>
          )}
        </View>
      )}
      <TouchableOpacity onPress={toggleCamera} style={styles.flipButton}>
        <Ionicons name="camera-reverse" size={30} color="white" />
      </TouchableOpacity>
      <TouchableOpacity onPress={toggleRecording} style={styles.recordButton} disabled={uploading}>
        <View style={[styles.recordIndicator, recording && styles.recording]} />
      </TouchableOpacity>
    </View>
  );
};

/* Profile Screen: Displays user profile and video grid */
const ProfileScreen = ({ navigation }) => {
  const [videos, setVideos] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const dimensions = Dimensions.get('window');
  const numColumns = 3;
  const tileSize = dimensions.width / numColumns;
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 300,
  });

  const fetchVideos = async () => {
    try {
      const videosQuery = query(
        collection(db, "videos"),
        orderBy("createdAt", "desc")
      );
      const querySnapshot = await getDocs(videosQuery);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error fetching videos:', error);
      return [];
    }
  };

  const loadVideos = async () => {
    const vids = await fetchVideos();
    setVideos(vids);
    setIsLoading(false);
  };

  // Initial load
  useEffect(() => {
    loadVideos();
  }, []);

  // Refresh on focus
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      loadVideos();
    });

    return unsubscribe;
  }, [navigation]);

  // Memoized tile component for better performance
  const VideoTile = React.memo(({ item }) => {
    const [thumbnailError, setThumbnailError] = useState(false);
    
    return (
      <TouchableOpacity 
        onPress={() => setSelectedVideo(item)}
        style={{
          width: tileSize,
          height: tileSize,
          padding: 1
        }}
      >
        {item.thumbnailUrl && !thumbnailError ? (
          <Image
            source={{ uri: item.thumbnailUrl }}
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: '#222'
            }}
            onError={() => setThumbnailError(true)}
          />
        ) : (
          <View style={{
            width: '100%',
            height: '100%',
            backgroundColor: '#222',
            justifyContent: 'center',
            alignItems: 'center'
          }}>
            <Ionicons name="play-circle-outline" size={30} color="#666" />
          </View>
        )}
      </TouchableOpacity>
    );
  });

  const renderVideoTile = useCallback(({ item }) => (
    <VideoTile item={item} />
  ), []);

  const getItemLayout = useCallback((data, index) => ({
    length: tileSize,
    offset: tileSize * Math.floor(index / numColumns),
    index,
  }), [tileSize, numColumns]);

  if (selectedVideo) {
    return (
      <View style={{ flex: 1, backgroundColor: 'black' }}>
        <FeedScreen 
          navigation={navigation}
          initialVideo={selectedVideo}
          videos={videos}
          onClose={() => setSelectedVideo(null)}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: 'black' }]}>
      {/* Profile Header */}
      <View style={styles.profileHeader}>
        <View style={styles.profileImageContainer}>
          <View style={styles.profileImage}>
            <Ionicons name="barbell-outline" size={40} color="white" />
          </View>
        </View>
        <Text style={styles.username}>Weightlifter</Text>
        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{videos.length}</Text>
            <Text style={styles.statLabel}>Videos</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>0</Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>0</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
        </View>
      </View>

      {/* Video Grid */}
      {isLoading ? (
        <ActivityIndicator size="large" color="white" style={{ marginTop: 20 }} />
      ) : (
        <FlatList
          data={videos}
          renderItem={renderVideoTile}
          keyExtractor={item => item.id}
          numColumns={numColumns}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 49 }}
          removeClippedSubviews={true}
          maxToRenderPerBatch={9}
          windowSize={5}
          initialNumToRender={9}
          getItemLayout={getItemLayout}
          viewabilityConfig={viewabilityConfig.current}
        />
      )}
    </View>
  );
};

const Tab = createBottomTabNavigator();
const App = () => {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {backgroundColor: 'black'},
          tabBarActiveTintColor: 'white',
          tabBarInactiveTintColor: 'gray'
        }}
      >
        <Tab.Screen 
          name="Feed" 
          component={FeedScreen}
          options={{
            tabBarIcon: ({focused, color}) => (
              <Ionicons name="play-circle-outline" size={24} color={color} />
            )
          }}
        />
        <Tab.Screen 
          name="Record" 
          component={RecordScreen}
          options={{
            tabBarIcon: ({focused, color}) => (
              <Ionicons name="radio-button-on-outline" size={24} color={color} />
            )
          }}
        />
        <Tab.Screen 
          name="Profile" 
          component={ProfileScreen}
          options={{
            tabBarIcon: ({focused, color}) => (
              <Ionicons name="person-outline" size={24} color={color} />
            )
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
};

export default App;

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black'
  },
  text: {
    color: 'white'
  },
  flipButton: {
    position: 'absolute',
    top: 10,
    right: 20,
    padding: 10
  },
  recordButton: {
    position: 'absolute',
    bottom: 50,
    alignSelf: 'center',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  recordIndicator: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'red'
  },
  recording: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'red'
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  permissionButton: {
    marginTop: 20,
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  poseIndicator: {
    position: 'absolute',
    top: 20,
    left: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 8,
    borderRadius: 20,
  },
  bufferingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
  },
  profileHeader: {
    padding: 20,
    alignItems: 'center',
    borderBottomWidth: 0.5,
    borderBottomColor: '#333',
  },
  profileImageContainer: {
    marginBottom: 15,
  },
  profileImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: {
    color: 'white',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginBottom: 15,
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  statLabel: {
    color: '#999',
    fontSize: 14,
  },
  backButton: {
    position: 'absolute',
    top: 10,
    left: 10,
    zIndex: 1,
    padding: 10,
  },
});


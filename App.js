// App.js
import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, FlatList, StyleSheet, Dimensions, ActivityIndicator, NativeModules} from 'react-native';
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
  const playbackStartTime = useRef(null);
  const animationFrame = useRef(null);

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
  const updatePoseData = () => {
    if (!isActive || !item.poseData || !playbackStartTime.current) return;
    
    const currentTime = Date.now() - playbackStartTime.current;
    const currentFrame = item.poseData.find((frame, index) => {
      const nextFrame = item.poseData[index + 1];
      return frame.timestamp <= currentTime && (!nextFrame || nextFrame.timestamp > currentTime);
    });

    if (currentFrame) {
      setCurrentPoseData(transformPoseData(currentFrame, videoDimensions));
    }

    animationFrame.current = requestAnimationFrame(updatePoseData);
  };

  useEffect(() => {
    if (isActive && item.poseData) {
      playbackStartTime.current = Date.now();
      updatePoseData();
    } else {
      if (animationFrame.current) {
        cancelAnimationFrame(animationFrame.current);
      }
      setCurrentPoseData(null);
    }

    return () => {
      if (animationFrame.current) {
        cancelAnimationFrame(animationFrame.current);
      }
    };
  }, [isActive, item.poseData]);

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
        onBuffer={({isBuffering: buffering}) => setIsBuffering(buffering)}
        onLoad={(data) => {
          setIsBuffering(false);
          setVideoDimensions({
            width: data.naturalSize.width,
            height: data.naturalSize.height
          });
          if (isActive && item.poseData) {
            playbackStartTime.current = Date.now();
          }
        }}
        onEnd={() => {
          if (isActive && item.poseData) {
            playbackStartTime.current = Date.now();
          }
        }}
        progressUpdateInterval={1000}
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
const FeedScreen = ({ navigation }) => {
  const [videos, setVideos] = useState([]);
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const screenHeight = Dimensions.get('window').height;
  const bottomTabHeight = 49;
  const videoRefs = useRef({});

  const fetchVideos = async (lastDocument = null) => {
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
    const vids = await fetchVideos();
    setVideos(vids);
    if (vids.length > 0) setActiveVideoId(vids[0].id);
    setIsLoading(false);
  };

  const loadMore = async () => {
    if (!lastDoc) return;
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
    const unsubscribe = navigation.addListener('blur', () => {
      cleanupFeed();
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
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
    />
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
        await cameraRef.current.startRecording({
          onRecordingFinished: async (video) => {
            try {
              setUploading(true);
              setUploadSuccess(false);
              const filename = `videos/${Date.now()}.mp4`;
              const storageRef = ref(storage, filename);
              const response = await fetch(`file://${video.path}`);
              const blob = await response.blob();
              await uploadBytes(storageRef, blob);
              const videoUrl = await getDownloadURL(storageRef);
              
              // Store video with all recorded pose data
              await addDoc(collection(db, "videos"), { 
                videoUrl, 
                createdAt: Date.now(),
                poseData: recordedPoseData.current.length > 0 ? recordedPoseData.current : null
              });
              
              setUploadSuccess(true);
              setTimeout(() => {
                setUploading(false);
                setUploadSuccess(false);
              }, 1500);
            } catch {
              setUploading(false);
            }
          },
          onRecordingError: () => setRecording(false),
          fileType: 'mp4',
          videoCodec: 'h264',
          videoBitRate: 2000000,
          fps: 30
        });
      }
    } catch {
      setRecording(false);
    }
  };
  
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

/* Profile Screen: A simple placeholder */
const ProfileScreen = () => (
  <View style={{flex:1, alignItems:'center', justifyContent:'center'}}>
    <Text>Profile Screen</Text>
  </View>
);

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
});


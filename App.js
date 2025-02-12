// App.js
import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, FlatList, StyleSheet, Dimensions, ActivityIndicator, NativeModules} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Camera, useCameraPermission, useMicrophonePermission, useCameraDevice} from 'react-native-vision-camera';
import Video from 'react-native-video';
import Svg, {Line, Circle} from 'react-native-svg';
import {db, storage} from './firebase';
import {collection, addDoc, getDocs, query, orderBy, where} from 'firebase/firestore';
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

// Memoized line component for better performance
const PoseLine = React.memo(({ startPoint, endPoint }) => {
  if (!startPoint || !endPoint || 
      startPoint.visibility < 0.5 || 
      endPoint.visibility < 0.5) return null;
  
  return (
    <Line
      x1={startPoint.x}
      y1={startPoint.y}
      x2={endPoint.x}
      y2={endPoint.y}
      stroke="#4CAF50"
      strokeWidth="2"
    />
  );
});

// Memoized point component for better performance
const PosePoint = React.memo(({ point }) => {
  if (!point || point.visibility < 0.5) return null;
  
  return (
    <Circle
      cx={point.x}
      cy={point.y}
      r="3"
      fill="#4CAF50"
    />
  );
});

// Dynamic wireframe overlay based on pose data
const WireframeOverlay = React.memo(({poseData}) => {
  if (!poseData) return null;
  
  return (
    <Svg style={StyleSheet.absoluteFill}>
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

/* Feed Screen: Fetches video docs from Firestore and plays each video with an overlaid wireframe */
const FeedScreen = ({ navigation }) => {
  const [videos, setVideos] = useState([]);
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const screenHeight = Dimensions.get('window').height;
  const bottomTabHeight = 49;

  const fetchNewVideos = async () => {
    const lastVideoTime = videos[0]?.createdAt || Date.now();
    const videosQuery = query(
      collection(db, "videos"),
      orderBy("createdAt", "desc"),
      where("createdAt", ">", lastVideoTime)
    );
    const querySnapshot = await getDocs(videosQuery);
    const newVids = [];
    querySnapshot.forEach(doc => newVids.push({ id: doc.id, ...doc.data() }));
    if (newVids.length) setVideos(prev => [...newVids, ...prev]);
    return newVids.length;
  };

  const loadInitial = async () => {
    const videosQuery = query(collection(db, "videos"), orderBy("createdAt", "desc"));
    const querySnapshot = await getDocs(videosQuery);
    const vids = [];
    querySnapshot.forEach(doc => vids.push({ id: doc.id, ...doc.data() }));
    setVideos(vids);
    if (vids.length > 0) setActiveVideoId(vids[0].id);
    setIsLoading(false);
  };

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', fetchNewVideos);
    return unsubscribe;
  }, [navigation, videos]);

  if (isLoading) {
    return (
      <View style={[styles.center, {backgroundColor: 'black'}]}>
        <ActivityIndicator size="large" color="white" />
      </View>
    );
  }

  return (
    <FlatList
      data={videos}
      keyExtractor={item => item.id}
      pagingEnabled
      snapToInterval={screenHeight - bottomTabHeight}
      decelerationRate="fast"
      disableIntervalMomentum
      snapToAlignment="start"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await fetchNewVideos();
        setRefreshing(false);
      }}
      onViewableItemsChanged={({viewableItems}) => {
        if (viewableItems.length > 0) {
          setActiveVideoId(viewableItems[0].item.id);
        }
      }}
      viewabilityConfig={viewabilityConfig}
      renderItem={({item}) => (
        <TouchableOpacity 
          activeOpacity={1}
          onPress={() => setActiveVideoId(activeVideoId === item.id ? null : item.id)}
          style={{height: screenHeight - bottomTabHeight}}
        >
          <Video 
            source={{uri: item.videoUrl}} 
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            repeat
            paused={activeVideoId !== item.id}
          />
        </TouchableOpacity>
      )}
    />
  );
};

/* Record Screen: Displays the camera preview with a wireframe overlay and a record button */
const RecordScreen = () => {
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
  
  // Add cache cleanup function
  const cleanupCache = async () => {
    try {
      const response = await NativeModules.PoseDetectionModule.cleanupCache();
      console.log('Cache cleanup completed:', response);
    } catch (error) {
      console.log('Cache cleanup error:', error);
    }
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
      // Skip if we're still processing the last frame or if not enough time has passed
      const now = Date.now();
      if (processingFrame.current || now - lastProcessedTime.current < 300) {
        return;
      }

      processingFrame.current = true;
      try {
        const frame = await cameraRef.current.takePhoto({
          qualityPrioritization: 'speed',
          skipMetadata: true,
          flash: 'off',
          enableAutoStabilization: false,
          enableShutterSound: false,
          width: 480,
          height: 360
        });
        
        if (!frame.path) return;

        const result = await NativeModules.PoseDetectionModule.detectPose(
          frame.path,
          frame.width,
          frame.height
        );
        
        lastProcessedTime.current = now;
        setIsPoseDetected(!!result.poseDetected);
        setPoseData(result.landmarks || null);
        
        // Cleanup immediately after processing
        try {
          await cleanupCache();
        } catch (error) {
          // Ignore cleanup errors
        }
      } catch (error) {
        setIsPoseDetected(false);
        setPoseData(null);
      } finally {
        processingFrame.current = false;
      }
    }, 300);  // Increased interval to 300ms

    return () => {
      clearInterval(frameInterval);
      cleanupCache();
    };
  }, [device, cameraRef.current]);

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
        await cleanupCache();  // Cleanup after stopping recording
      } else {
        await cleanupCache();  // Cleanup before starting recording
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
              await addDoc(collection(db, "videos"), { videoUrl, createdAt: Date.now() });
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
        });
      }
    } catch {
      setRecording(false);
    }
  };
  
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
});


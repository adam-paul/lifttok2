// App.js
import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, FlatList, StyleSheet, Dimensions, ActivityIndicator} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Camera, useCameraPermission, useMicrophonePermission, useCameraDevice} from 'react-native-vision-camera';
import Video from 'react-native-video';
import Svg, {Line} from 'react-native-svg';
import {db, storage} from './firebase';
import {collection, addDoc, getDocs, query, orderBy, where} from 'firebase/firestore';
import {ref, uploadBytes, getDownloadURL} from 'firebase/storage';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {runOnJS} from 'react-native-reanimated';

// Frame processor worklet
const frameProcessor = (frame) => {
  'worklet';
  // Skip frames for performance (process every 3rd frame)
  if (frame.frameNumber % 3 !== 0) return;
  
  try {
    // Convert frame to proper format if needed
    // This will be expanded in Phase 2 when we add MediaPipe
    
    // For now, just log frame info for debugging
    runOnJS(console.log)(`Processing frame: ${frame.frameNumber}`);
    
  } catch (error) {
    // Error handling
    runOnJS(console.error)(`Frame processing error: ${error.message}`);
  }
};

/* A dummy "comprehensive" wireframe overlay – in a real app this would be driven by pose-detection */
const WireframeOverlay = () => (
  <Svg style={StyleSheet.absoluteFill}>
    {/* Spine */}
    <Line x1="50%" y1="10%" x2="50%" y2="90%" stroke="lime" strokeWidth="2"/>
    {/* Shoulders */}
    <Line x1="50%" y1="30%" x2="30%" y2="50%" stroke="lime" strokeWidth="2"/>
    <Line x1="50%" y1="30%" x2="70%" y2="50%" stroke="lime" strokeWidth="2"/>
    {/* Arms */}
    <Line x1="50%" y1="50%" x2="35%" y2="70%" stroke="lime" strokeWidth="2"/>
    <Line x1="50%" y1="50%" x2="65%" y2="70%" stroke="lime" strokeWidth="2"/>
  </Svg>
);

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

/* Record Screen: Displays the VisionCamera preview with a wireframe overlay and a record button.
   When pressed, it records a video, uploads it to Firebase Storage, and adds a Firestore doc. */
const RecordScreen = () => {
  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } = useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } = useMicrophonePermission();
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isFront, setIsFront] = useState(false);
  const device = useCameraDevice(isFront ? 'front' : 'back');
  const cameraRef = useRef(null);
  
  useEffect(() => {
    (async () => {
      if (!hasCameraPermission) await requestCameraPermission();
      if (!hasMicPermission) await requestMicPermission();
    })();
  }, [hasCameraPermission, hasMicPermission]);

  const toggleCamera = () => setIsFront(!isFront);
  
  const toggleRecording = async () => {
    if (!device || !cameraRef.current) return;
    
    try {
      if (recording) {
        setRecording(false);
        await cameraRef.current.stopRecording();
      } else {
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
        <Text style={styles.text}>
          {`${!hasCameraPermission ? 'Camera' : ''}${!hasCameraPermission && !hasMicPermission ? ' and ' : ''}${!hasMicPermission ? 'Microphone' : ''} access is required.`}
        </Text>
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
        video
        audio
        frameProcessor={frameProcessor}
        frameProcessorFps={30}
      />
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
export default function App() {
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
}

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
});


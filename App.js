// App.js
import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, FlatList, StyleSheet, Dimensions} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {Camera, useCameraDevices} from 'react-native-vision-camera';
import Video from 'react-native-video';
import Svg, {Line} from 'react-native-svg';
import {db, storage} from './firebase';
import {collection, addDoc, getDocs} from 'firebase/firestore';
import {ref, uploadBytes, getDownloadURL} from 'firebase/storage';
import Ionicons from 'react-native-vector-icons/Ionicons';

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

/* Feed Screen: Fetches video docs from Firestore and plays each video with an overlaid wireframe */
const FeedScreen = () => {
  const [videos, setVideos] = useState([]);
  const [pausedStates, setPausedStates] = useState({});
  const screenHeight = Dimensions.get('window').height;
  const bottomTabHeight = 49;

  useEffect(() => {
    (async () => {
      const querySnapshot = await getDocs(collection(db, "videos"));
      const vids = [];
      querySnapshot.forEach(doc => vids.push({ id: doc.id, ...doc.data() }));
      setVideos(vids);
      // Initialize first video as playing, rest as paused
      const initialPausedStates = {};
      vids.forEach((vid, index) => initialPausedStates[vid.id] = index !== 0);
      setPausedStates(initialPausedStates);
    })();
  }, []);

  return (
    <FlatList
      data={videos}
      keyExtractor={item => item.id}
      pagingEnabled
      showsVerticalScrollIndicator={false}
      snapToInterval={screenHeight - bottomTabHeight}
      decelerationRate="fast"
      onLayout={() => {
        if (videos.length > 0) {
          setPausedStates(prev => ({...prev, [videos[0].id]: false}));
        }
      }}
      onViewableItemsChanged={({viewableItems}) => {
        if (viewableItems.length > 0) {
          const newPausedStates = {...pausedStates};
          videos.forEach(video => {
            newPausedStates[video.id] = !viewableItems.some(item => item.item.id === video.id);
          });
          setPausedStates(newPausedStates);
        }
      }}
      viewabilityConfig={{
        itemVisiblePercentThreshold: 50
      }}
      renderItem={({item}) => (
        <TouchableOpacity 
          activeOpacity={1}
          onPress={() => setPausedStates(prev => ({
            ...prev,
            [item.id]: !prev[item.id]
          }))}
          style={{height: screenHeight - bottomTabHeight}}
        >
          <Video 
            source={{uri: item.videoUrl}} 
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            repeat
            playInBackground={false}
            paused={pausedStates[item.id] ?? false}
            muted
          />
        </TouchableOpacity>
      )}
    />
  );
};

/* Record Screen: Displays the VisionCamera preview with a wireframe overlay and a record button.
   When pressed, it records a video, uploads it to Firebase Storage, and adds a Firestore doc. */
const RecordScreen = () => {
  const [hasPermission, setHasPermission] = useState(false);
  const [recording, setRecording] = useState(false);
  const devices = useCameraDevices();
  const device = devices.back;
  const cameraRef = useRef(null);
  
  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'authorized');
    })();
  }, []);
  
  const recordVideo = async () => {
    if (cameraRef.current && !recording) {
      setRecording(true);
      // recordAsync resolves when recording stops (for simplicity we record until user stops)
      const video = await cameraRef.current.recordAsync();
      setRecording(false);
      // Upload video file (convert local uri to blob)
      const response = await fetch(video.uri);
      const blob = await response.blob();
      const filename = `videos/${Date.now()}.mp4`;
      const storageRef = ref(storage, filename);
      await uploadBytes(storageRef, blob);
      const videoUrl = await getDownloadURL(storageRef);
      await addDoc(collection(db, "videos"), { url: videoUrl, createdAt: Date.now() });
    }
  };
  
  if (!device || !hasPermission) return <Text>Loading Camera...</Text>;
  
  return (
    <View style={{flex:1}}>
      <Camera style={{flex:1}} device={device} isActive ref={cameraRef} />
      <WireframeOverlay />
      <TouchableOpacity onPress={recordVideo} style={styles.recordButton}>
        <Text style={{color:'#fff'}}>{recording ? 'Recording...' : 'Record'}</Text>
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
  recordButton: {
    position: 'absolute', bottom: 50, alignSelf: 'center',
    backgroundColor: 'red', padding: 20, borderRadius: 50,
  },
});


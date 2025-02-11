// firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAqtLe0DCHLE9VNy0U-AoDTvctMgICLukY",
  authDomain: "lifttok-55106.firebaseapp.com",
  projectId: "lifttok-55106",
  storageBucket: "lifttok-55106.firebasestorage.app",
  messagingSenderId: "179706769757",
  appId: "1:179706769757:web:30d90a02116dc7636eb8b4",
  measurementId: "G-4ZY1JFJZLY"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

export { db, storage };


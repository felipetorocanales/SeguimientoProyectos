import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBTVsB8fvJQH8DTMdqBmqIaaK3W-vHyNIs",
  authDomain: "nexus-tracker-b7a75.firebaseapp.com",
  projectId: "nexus-tracker-b7a75",
  storageBucket: "nexus-tracker-b7a75.firebasestorage.app",
  messagingSenderId: "995993042822",
  appId: "1:995993042822:web:f29136b7e844063324f607",
  measurementId: "G-Z2L4T8CLZ5"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

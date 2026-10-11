// js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD7e7oJwKnwpYVO4v-13P-_KCw83nttRDI",
  authDomain: "toska-f3d1e.firebaseapp.com",
  projectId: "toska-f3d1e",
  storageBucket: "toska-f3d1e.firebasestorage.app",
  messagingSenderId: "716783941201",
  appId: "1:716783941201:web:0ea1212e35cb8d058a2a70",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

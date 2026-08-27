import type { FirebaseOptions } from "firebase/app";

export const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "call-relay-3dec7.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "call-relay-3dec7",
  appId: import.meta.env.VITE_FIREBASE_WEB_APP_ID ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "90866288123",
};

export function assertFirebaseWebConfigured(): void {
  if (!firebaseConfig.apiKey || !firebaseConfig.appId?.includes(":web:")) {
    throw new Error("Firebase web sign-in is not configured on this deployment");
  }
}

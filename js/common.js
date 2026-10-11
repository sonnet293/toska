// js/common.js — 인증, 공용 상수, 채팅 포맷
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const ROOMS = ["battleroom1", "battleroom2", "battleroom3"];
export const ROOM_NAMES = {
  battleroom1: "배틀룸 1",
  battleroom2: "배틀룸 2",
  battleroom3: "배틀룸 3",
};

// rooms/{roomId} 기본 형태
export const EMPTY_ROOM = {
  player1: null,
  player2: null,
  p1Ready: false,
  p2Ready: false,
  status: "waiting", // waiting | playing
  session: null,     // 진행 중인 games/{session}
  spectators: {},    // { uid: nickname }
};

// 로그인 안 되어 있으면 loginPath로 보냄. 로그인 되어 있으면 users/{uid} 프로필 반환
export function requireUser(loginPath) {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (!user) {
        location.href = loginPath;
        return;
      }
      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.exists() ? snap.data() : {};
      resolve({
        uid: user.uid,
        nickname: data.nickname || user.email,
        stats: data.stats || {},
        role: data.role || "player",
      });
    });
  });
}

export function logout(redirect) {
  return signOut(auth).then(() => (location.href = redirect));
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// 일반 지문 / (행동 지문) → 회색 이탤릭 / @마법 지문 → 볼드
export function formatChat(text) {
  return String(text)
    .split(/(\([^)]*\))/)
    .map((part) => {
      if (!part) return "";
      if (/^\(.*\)$/s.test(part)) return `<span class="chat-action">${esc(part)}</span>`;
      return esc(part).replace(/@([^@]+)/g, '<strong class="chat-magic">$1</strong>');
    })
    .join("");
}

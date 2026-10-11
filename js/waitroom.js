// js/waitroom.js — 대기실 (pages/battleroom1~3.html)
import { db } from "./firebase.js";
import { requireUser, esc, ROOM_NAMES, EMPTY_ROOM } from "./common.js";
import {
  doc, runTransaction, onSnapshot, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

export async function initWaitRoom(roomId) {
  const me = await requireUser("../index.html");
  const ref = doc(db, "rooms", roomId);
  let moving = false;
  let room = { ...EMPTY_ROOM };

  $("room-name").textContent = `${ROOM_NAMES[roomId]} 대기실`;

  const goGame = () => {
    if (moving) return;
    moving = true;
    location.href = `../games/${roomId}.html`;
  };

  const mySlot = (r) =>
    r.player1?.uid === me.uid ? "player1" : r.player2?.uid === me.uid ? "player2" : r.spectators?.[me.uid] ? "spectator" : null;

  // 입장: 먼저 온 사람 player1, 다음 player2, 그 외 관전자
  async function join() {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const r = { ...EMPTY_ROOM, ...(snap.exists() ? snap.data() : {}) };
      if (r.status === "playing") return;
      if (snap.exists() && mySlot(r)) return;
      const meObj = { uid: me.uid, nickname: me.nickname };
      if (!r.player1) r.player1 = meObj;
      else if (!r.player2) r.player2 = meObj;
      else r.spectators = { ...r.spectators, [me.uid]: me.nickname };
      tx.set(ref, r);
    });
  }

  async function leave() {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const r = { ...EMPTY_ROOM, ...snap.data() };
      if (r.status === "playing") return;
      if (r.player1?.uid === me.uid) {
        // player2가 있으면 player1로 승격
        tx.update(ref, {
          player1: r.player2,
          p1Ready: r.player2 ? r.p2Ready : false,
          player2: null,
          p2Ready: false,
        });
      } else if (r.player2?.uid === me.uid) {
        tx.update(ref, { player2: null, p2Ready: false });
      } else if (r.spectators?.[me.uid]) {
        tx.update(ref, { [`spectators.${me.uid}`]: deleteField() });
      }
    });
  }

  async function toggleReady() {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const r = { ...EMPTY_ROOM, ...snap.data() };
      if (r.status !== "waiting") return;
      const slot = mySlot(r);
      if (slot !== "player1" && slot !== "player2") return;
      const key = slot === "player1" ? "p1Ready" : "p2Ready";
      const update = { [key]: !r[key] };
      r[key] = !r[key];
      // 둘 다 준비 완료 → 게임 시작 (GM이 games/{session} 생성)
      if (r.player1 && r.player2 && r.p1Ready && r.p2Ready) {
        update.status = "playing";
        update.session = `${roomId}_${Date.now()}`;
      }
      tx.update(ref, update);
    });
  }

  function render() {
    const slot = mySlot(room);
    const roleText = {
      player1: "당신은 Player 1 입니다.",
      player2: "당신은 Player 2 입니다.",
      spectator: "당신은 관전자입니다.",
    }[slot] || "방에 들어와 있지 않습니다. (새로고침하면 재입장)";
    $("my-role").textContent = roleText;

    for (const [s, readyKey, label] of [["player1", "p1Ready", "Player 1"], ["player2", "p2Ready", "Player 2"]]) {
      const p = room[s];
      $(`slot-${s}`).innerHTML = p
        ? `<b>${label}</b> ${esc(p.nickname)} ${room[readyKey] ? '<span class="ready">READY</span>' : '<span class="muted">준비 중</span>'}`
        : `<b>${label}</b> <span class="muted">대기 중...</span>`;
    }

    const isPlayer = slot === "player1" || slot === "player2";
    const btn = $("ready-btn");
    btn.hidden = !isPlayer;
    btn.textContent = room[slot === "player1" ? "p1Ready" : "p2Ready"] ? "준비 취소" : "준비";

    const specs = Object.values(room.spectators || {});
    $("spectators").innerHTML = specs.length ? specs.map((n) => `<li>${esc(n)}</li>`).join("") : '<li class="muted">없음</li>';
  }

  $("ready-btn").onclick = () => toggleReady().catch((e) => alert(e.message));
  $("leave-btn").onclick = async () => {
    moving = true;
    await leave().catch(() => {});
    location.href = "../main.html";
  };
  // 탭을 닫을 때도 자리 비우기 (최선 노력)
  window.addEventListener("pagehide", () => {
    if (!moving) leave().catch(() => {});
  });

  try {
    await join();
  } catch (e) {
    $("my-role").textContent = "입장 실패: " + e.message;
  }

  onSnapshot(ref, (snap) => {
    room = { ...EMPTY_ROOM, ...(snap.data() || {}) };
    if (room.status === "playing") return goGame();
    render();
  });
}

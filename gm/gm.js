// gm/gm.js — 배틀 서버. role이 gm인 사용자의 브라우저가 모든 판정을 대표로 계산한다.
import { db } from "../js/firebase.js";
import { requireUser, logout, esc, ROOMS, ROOM_NAMES, EMPTY_ROOM } from "../js/common.js";
import { ACTIONS, ACTION_LABEL, createPlayerState, resolveRound, dynamicState } from "../js/battle.js";
import {
  doc, collection, onSnapshot, runTransaction, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

const me = await requireUser("../index.html");
$("logout").onclick = () => logout("../index.html");

if (me.role !== "gm") {
  $("gm-status").textContent = "GM 권한이 없습니다.";
  throw new Error("not gm");
}
$("gm-status").textContent = `GM: ${me.nickname} — 서버 동작 중 (이 탭을 닫으면 판정이 멈춥니다)`;

const rooms = {};    // roomId -> room doc
const games = {};    // roomId -> game doc
const watched = new Set();
const busy = new Map();

function log(msg) {
  const li = document.createElement("li");
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $("gm-log").prepend(li);
}

function render() {
  $("rooms").innerHTML = ROOMS.map((id) => {
    const r = { ...EMPTY_ROOM, ...rooms[id] };
    const g = games[id];
    const players = [r.player1, r.player2].filter(Boolean).map((p) => esc(p.nickname)).join(" vs ") || "-";
    let info = r.status === "playing" ? "전투 중" : "대기 중";
    if (g && r.status === "playing") {
      info += ` · R${g.round} · ${g.p1.nickname} HP ${g.p1.hp} / ${g.p2.nickname} HP ${g.p2.hp}`;
      info += ` · 제출 ${g.submitted?.p1 ? "●" : "○"}${g.submitted?.p2 ? "●" : "○"}`;
    }
    return `<tr><td>${ROOM_NAMES[id]}</td><td>${players}</td><td>${esc(info)}</td>
      <td><button data-reset="${id}">방 초기화</button></td></tr>`;
  }).join("");
}

$("rooms").addEventListener("click", async (e) => {
  const id = e.target.dataset?.reset;
  if (!id || !confirm(`${ROOM_NAMES[id]}을(를) 초기화할까요? 진행 중인 게임은 중단됩니다.`)) return;
  const r = rooms[id] || {};
  if (r.session) await updateDoc(doc(db, "games", r.session), { status: "aborted" }).catch(() => {});
  await setDoc(doc(db, "rooms", id), { ...EMPTY_ROOM, lastSession: r.session || r.lastSession || null });
  log(`${ROOM_NAMES[id]} 초기화`);
});

/* ---------- 게임 생성 & 감시 ---------- */
async function startGame(roomId, sid) {
  if (watched.has(sid)) return;
  watched.add(sid);
  const gameRef = doc(db, "games", sid);

  try {
    const created = await runTransaction(db, async (tx) => {
      const g = await tx.get(gameRef);
      if (g.exists()) return false;
      const room = (await tx.get(doc(db, "rooms", roomId))).data();
      const u1 = (await tx.get(doc(db, "users", room.player1.uid))).data() || {};
      const u2 = (await tx.get(doc(db, "users", room.player2.uid))).data() || {};
      tx.set(gameRef, {
        roomId,
        session: sid,
        status: "active",
        round: 1,
        winner: null,
        submitted: { p1: false, p2: false },
        p1: createPlayerState(room.player1.uid, u1.nickname || room.player1.nickname, u1.stats),
        p2: createPlayerState(room.player2.uid, u2.nickname || room.player2.nickname, u2.stats),
        createdAt: serverTimestamp(),
      });
      return true;
    });
    log(`${ROOM_NAMES[roomId]} ${created ? "게임 생성" : "게임 감시 재개"} (${sid})`);
  } catch (e) {
    log(`${ROOM_NAMES[roomId]} 게임 생성 실패: ${e.message}`);
    watched.delete(sid);
    return;
  }

  let unsubGame = null;
  let unsubActs = null;
  const stop = () => {
    unsubGame?.();
    unsubActs?.();
  };
  unsubGame = onSnapshot(gameRef, (s) => {
    games[roomId] = s.data();
    render();
    if (s.data()?.status !== "active") stop();
  });
  unsubActs = onSnapshot(collection(db, "games", sid, "actions"), () => tryResolve(roomId, sid));
}

/* ---------- 라운드 판정 ---------- */
async function tryResolve(roomId, sid) {
  if (busy.get(sid)) {
    busy.set(sid, "again");
    return;
  }
  busy.set(sid, true);
  try {
    const result = await runTransaction(db, async (tx) => {
      const gameRef = doc(db, "games", sid);
      const aRef = { p1: doc(db, "games", sid, "actions", "p1"), p2: doc(db, "games", sid, "actions", "p2") };
      const g = await tx.get(gameRef);
      if (!g.exists()) return null;
      const game = g.data();
      if (game.status !== "active") return null;
      const snaps = { p1: await tx.get(aRef.p1), p2: await tx.get(aRef.p2) };

      const act = {};
      for (const k of ["p1", "p2"]) {
        const d = snaps[k].exists() ? snaps[k].data() : null;
        act[k] = d && d.round === game.round && d.uid === game[k].uid && ACTIONS.includes(d.action) ? d.action : null;
      }

      // 아직 한쪽만 제출 → 제출 여부만 공개 (어떤 행동인지는 비공개)
      if (!act.p1 || !act.p2) {
        const submitted = { p1: !!act.p1, p2: !!act.p2 };
        if (submitted.p1 !== !!game.submitted?.p1 || submitted.p2 !== !!game.submitted?.p2) {
          tx.update(gameRef, { submitted });
        }
        return null;
      }

      // 양측 동시 공개 → 판정
      const res = resolveRound(game, act);
      const dead1 = res.p1.hp <= 0;
      const dead2 = res.p2.hp <= 0;
      const over = dead1 || dead2;
      const winner = over ? (dead1 && dead2 ? "draw" : dead1 ? "p2" : "p1") : null;
      if (over) res.logs.push(winner === "draw" ? "양측 쓰러짐 — 무승부!" : `${res[winner].nickname} 승리!`);

      tx.set(doc(db, "games", sid, "rounds", String(game.round).padStart(4, "0")), {
        round: game.round,
        actions: act,
        rolls: res.rolls,
        extras: res.extras,
        logs: res.logs,
        after: { p1: dynamicState(res.p1), p2: dynamicState(res.p2) },
        createdAt: serverTimestamp(),
      });
      tx.update(gameRef, {
        p1: res.p1,
        p2: res.p2,
        round: game.round + 1,
        submitted: { p1: false, p2: false },
        status: over ? "finished" : "active",
        winner,
      });
      tx.delete(aRef.p1);
      tx.delete(aRef.p2);
      // 게임 종료 → 대기실 비우기 (결과 열람용으로 lastSession 유지)
      if (over) tx.set(doc(db, "rooms", roomId), { ...EMPTY_ROOM, lastSession: sid });

      return { round: game.round, act, logs: res.logs };
    });

    if (result) {
      log(`${ROOM_NAMES[roomId]} R${result.round}: ${ACTION_LABEL[result.act.p1]} vs ${ACTION_LABEL[result.act.p2]} — ${result.logs.join(" / ")}`);
    }
  } catch (e) {
    log(`${ROOM_NAMES[roomId]} 판정 오류: ${e.message}`);
  } finally {
    const again = busy.get(sid) === "again";
    busy.delete(sid);
    if (again) tryResolve(roomId, sid);
  }
}

/* ---------- 방 감시 ---------- */
render();
onSnapshot(collection(db, "rooms"), (snap) => {
  snap.forEach((d) => (rooms[d.id] = d.data()));
  render();
  for (const [id, room] of Object.entries(rooms)) {
    if (room.status === "playing" && room.session) startGame(id, room.session);
  }
});

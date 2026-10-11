// js/game.js — 전투 화면 (games/battleroom1~3.html)
// 플레이어는 행동만 제출하고, 계산은 GM 브라우저(gm/gm.js)가 한다.
import { db } from "./firebase.js";
import { requireUser, esc, formatChat, ROOM_NAMES } from "./common.js";
import { ACTIONS, ACTION_LABEL, STAT_LABEL, fatigueLimit, dynamicState } from "./battle.js";
import { ICONS, ACTION_COLOR } from "./icons.js";
import {
  doc, getDoc, onSnapshot, setDoc, addDoc, collection, query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const SLOTS = ["p1", "p2"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 주사위 연출 ---------- */
let audioCtx = null;
function ding() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 1320;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

function pop(el) {
  el.classList.remove("pop");
  void el.offsetWidth; // 애니메이션 재시작
  el.classList.add("pop");
}

// 숫자가 빠르게 돌다가 점점 느려지고 최종값에서 "띵" 멈춤
function spin(el, final, sides, duration = 1400) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const t = performance.now() - start;
      if (t >= duration) {
        el.textContent = final;
        pop(el);
        ding();
        resolve();
        return;
      }
      el.textContent = 1 + Math.floor(Math.random() * sides);
      setTimeout(tick, 40 + (t / duration) ** 2 * 220);
    };
    tick();
  });
}

const fmtMods = (roll) =>
  roll.mods
    .filter((m) => m.value)
    .map((m) => `${m.value < 0 ? "−" : "+"} ${esc(m.label)} ${Math.abs(m.value)}`)
    .join(" ");

/* ---------- 메인 ---------- */
export async function initGame(roomId) {
  const me = await requireUser("../index.html");
  $("room-name").textContent = ROOM_NAMES[roomId];

  const room = (await getDoc(doc(db, "rooms", roomId))).data() || {};
  const sid = room.session || room.lastSession;
  if (!sid) {
    $("status").textContent = "진행 중인 게임이 없습니다.";
    return;
  }

  const gameRef = doc(db, "games", sid);
  let game = null;
  let mySlot = null;
  let picked = null;       // { round, action } 이번 라운드 내가 고른 것
  let seenRound = null;    // 화면에 결과 연출까지 끝난 마지막 라운드
  let display = null;      // 패널에 표시 중인 { p1, p2 } 변동 상태
  const queue = [];        // 연출 대기 중인 라운드 결과
  let animating = false;

  // 결과 연출이 아직 남아 있으면 최신 상태를 먼저 보여주지 않는다
  const caughtUp = () => !!game && seenRound !== null && game.round - 1 === seenRound;

  /* ----- 행동 버튼 ----- */
  $("actions").innerHTML = ACTIONS.map(
    (a) => `<button class="act-btn" data-action="${a}" style="color:${ACTION_COLOR[a]}">${ICONS[a]}<span>${ACTION_LABEL[a]}</span></button>`
  ).join("");

  $("actions").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled || !game || !mySlot) return;
    const action = btn.dataset.action;
    const round = game.round;
    picked = { round, action };
    renderControls();
    try {
      await setDoc(doc(db, "games", sid, "actions", mySlot), {
        uid: me.uid, action, round, at: serverTimestamp(),
      });
    } catch (err) {
      picked = null;
      alert("행동 전송 실패: " + err.message);
      renderControls();
    }
  });

  /* ----- 렌더링 ----- */
  function renderPanels() {
    if (!game) return;
    for (const k of SLOTS) {
      const p = game[k];
      const d = display?.[k] ?? p;
      const pct = Math.max(0, Math.round((d.hp / p.maxHp) * 100));
      const tags = [];
      if (d.broken) tags.push('<span class="tag broken">자세 붕괴</span>');
      if (d.exhausted) tags.push('<span class="tag exhausted">탈진</span>');
      if (d.counterBonus) tags.push('<span class="tag bonus">반격 +2</span>');
      const choosing =
        game.status === "active" && caughtUp() ? (game.submitted?.[k] ? "✔ 선택 완료" : "… 선택 중") : "";
      $(`panel-${k}`).innerHTML = `
        <h3>${k.toUpperCase()} · ${esc(p.nickname)}${k === mySlot ? " (나)" : ""}</h3>
        <div class="hpbar"><div style="width:${pct}%"></div></div>
        <div>HP <b>${d.hp}</b> / ${p.maxHp} · 피로 <b>${d.fatigue}</b> / ${fatigueLimit(p)}</div>
        <div class="muted">${Object.entries(STAT_LABEL).map(([s, l]) => `${l} ${p.stats[s]}`).join(" · ")}</div>
        <div>${tags.join(" ")}</div>
        <div class="muted">${choosing}</div>`;
    }
  }

  function renderStatus() {
    if (!game) return;
    if (!caughtUp()) return;
    if (game.status === "active") $("status").textContent = `ROUND ${game.round}`;
    else if (game.status === "aborted") $("status").textContent = "GM이 게임을 중단했습니다.";
    else if (game.status === "finished") {
      const text = game.winner === "draw" ? "무승부!" : `${game[game.winner].nickname} 승리!`;
      $("status").innerHTML = `<b>${esc(text)}</b>`;
    }
  }

  function renderControls() {
    if (!game) return;
    if (!mySlot) {
      $("actions").hidden = true;
      $("my-status").textContent = "관전 중입니다.";
      return;
    }
    const thisRoundPick = picked?.round === game.round ? picked.action : null;
    const locked = game.status !== "active" || !caughtUp() || game.submitted?.[mySlot] || !!thisRoundPick;
    for (const b of $("actions").querySelectorAll("button")) {
      b.disabled = locked;
      b.classList.toggle("picked", b.dataset.action === thisRoundPick);
    }
    const other = mySlot === "p1" ? "p2" : "p1";
    if (game.status !== "active") $("my-status").textContent = "게임이 끝났습니다.";
    else if (!caughtUp()) $("my-status").textContent = "판정 중...";
    else if (thisRoundPick || game.submitted?.[mySlot])
      $("my-status").textContent =
        `${thisRoundPick ? `[${ACTION_LABEL[thisRoundPick]}] ` : ""}선택 완료 — ` +
        (game.submitted?.[other] ? "판정을 기다리는 중..." : "상대의 선택을 기다리는 중...");
    else $("my-status").textContent = "행동을 선택하세요.";
  }

  function renderAll() {
    if (caughtUp()) display = { p1: dynamicState(game.p1), p2: dynamicState(game.p2) };
    renderPanels();
    renderStatus();
    renderControls();
  }

  function appendLog(r) {
    const line = SLOTS.map((k) => {
      const roll = r.rolls?.[k];
      return `${esc(game?.[k]?.nickname ?? k)} [${ACTION_LABEL[r.actions[k]]}]${roll ? ` (${roll.total})` : ""}`;
    }).join(" vs ");
    const el = document.createElement("div");
    el.className = "log-entry";
    el.innerHTML = `<b>R${r.round}</b> ${line}<ul>${r.logs.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
    $("battle-log").append(el);
    $("battle-log").scrollTop = $("battle-log").scrollHeight;
  }

  /* ----- 라운드 결과 연출 (큐) ----- */
  async function rollInto(el, roll) {
    el.innerHTML = `1D${roll.sides} <span class="dice-number">?</span> <span class="breakdown"></span>`;
    await spin(el.querySelector(".dice-number"), roll.die, roll.sides);
    el.querySelector(".breakdown").innerHTML = `${fmtMods(roll)} = <b>${roll.total}</b>`;
  }

  async function playRound(r) {
    const stage = $("stage");
    stage.innerHTML = `
      <div class="round-title">ROUND ${r.round}</div>
      <div class="reveal">
        ${SLOTS.map((k) => `
          <div class="side">
            <div>${esc(game[k].nickname)}</div>
            <div class="side-act" style="color:${ACTION_COLOR[r.actions[k]]}">${ICONS[r.actions[k]]} ${ACTION_LABEL[r.actions[k]]}</div>
            <div class="side-roll" id="roll-${k}"></div>
          </div>`).join('<div class="vs">VS</div>')}
      </div>
      <div id="stage-extras"></div>
      <div id="stage-logs"></div>`;
    for (const k of SLOTS) pop(stage.querySelectorAll(".side-act")[SLOTS.indexOf(k)]);
    await wait(700);

    await Promise.all(SLOTS.map((k) => {
      if (r.rolls?.[k]) return rollInto($(`roll-${k}`), r.rolls[k]);
      $(`roll-${k}`).innerHTML = '<span class="muted">판정 없음</span>';
    }));

    for (const ex of r.extras || []) {
      const el = document.createElement("div");
      el.innerHTML = `${esc(game[ex.who].nickname)} · ${esc(ex.label)} 1D${ex.sides} <span class="dice-number">?</span>`;
      $("stage-extras").append(el);
      await spin(el.querySelector(".dice-number"), ex.die, ex.sides, 900);
    }

    await wait(300);
    $("stage-logs").innerHTML = r.logs.map((l) => `<div>${esc(l)}</div>`).join("");
    appendLog(r);

    seenRound = r.round;
    display = r.after;
    renderPanels();
    await wait(500);
  }

  async function pump() {
    if (animating || !game) return;
    animating = true;
    while (queue.length) {
      const r = queue.shift();
      if (r.round <= seenRound) continue;
      await playRound(r);
    }
    animating = false;
    renderAll();
  }

  /* ----- 구독 ----- */
  let firstRounds = true;
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      $("status").textContent = "GM이 게임을 준비하는 중입니다...";
      return;
    }
    const firstGame = !game;
    game = snap.data();
    mySlot = game.p1.uid === me.uid ? "p1" : game.p2.uid === me.uid ? "p2" : null;
    if (firstGame) {
      seenRound = Math.max(seenRound ?? 0, game.round - 1);
      setupChats();
    }
    if (!animating) renderAll();
    else renderControls();
    pump();
  });

  onSnapshot(query(collection(db, "games", sid, "rounds"), orderBy("round")), (snap) => {
    if (firstRounds) {
      // 이미 지나간 라운드는 기록만 보여줌
      firstRounds = false;
      snap.docs.forEach((d) => appendLog(d.data()));
      const last = snap.docs.at(-1)?.data();
      if (last) seenRound = Math.max(seenRound ?? 0, last.round);
      if (game && !animating) renderAll();
      return;
    }
    snap.docChanges().forEach((c) => {
      if (c.type === "added") queue.push(c.doc.data());
    });
    pump();
  });

  /* ----- 채팅 ----- */
  function setupChats() {
    setupChat("chat", "chat-player", "form-player", !!mySlot, "플레이어만 입력할 수 있습니다.");
    setupChat("spectatorChat", "chat-spectator", "form-spectator", !mySlot, "관전자만 입력할 수 있습니다.");
  }

  function setupChat(coll, listId, formId, canWrite, lockedText) {
    const list = $(listId);
    const form = $(formId);
    const input = form.querySelector("input");
    input.disabled = !canWrite;
    form.querySelector("button").disabled = !canWrite;
    if (!canWrite) input.placeholder = lockedText;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !canWrite) return;
      input.value = "";
      try {
        await addDoc(collection(db, "games", sid, coll), {
          uid: me.uid, nickname: me.nickname, slot: mySlot, text, createdAt: serverTimestamp(),
        });
      } catch (err) {
        alert("채팅 전송 실패: " + err.message);
      }
    });

    onSnapshot(query(collection(db, "games", sid, coll), orderBy("createdAt")), (snap) => {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      list.innerHTML = snap.docs.map((d) => {
        const m = d.data();
        return `<div class="msg"><span class="who ${m.slot || "spec"}">${esc(m.nickname)}</span> ${formatChat(m.text)}</div>`;
      }).join("");
      if (atBottom) list.scrollTop = list.scrollHeight;
    });
  }
}

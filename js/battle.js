// js/battle.js — 전투 규칙 (GM 브라우저에서만 계산에 사용)

export const ACTIONS = ["attack", "defend", "feint", "counter", "refit"];
export const ACTION_LABEL = {
  attack: "공격",
  defend: "방어",
  feint: "견제",
  counter: "반격",
  refit: "재정비",
};
export const STAT_LABEL = { str: "완력", dex: "기교", ref: "반응", end: "체력", ins: "통찰" };

const FATIGUE_COST = { attack: 1, defend: 0, feint: 1, counter: 1, refit: 0 };
const BROKEN_PENALTY = { attack: -1, defend: -2, feint: 0, counter: -2 };
const HIT_TARGET = 9;       // 독립 판정 목표값
const REFIT_RECOVER = 3;
const REFIT_HIT_RECOVER = 1;

export const fatigueLimit = (p) => (p.stats.end || 0) + 4;

export function createPlayerState(uid, nickname, stats = {}) {
  const s = {
    str: Number(stats.str) || 0,
    dex: Number(stats.dex) || 0,
    ref: Number(stats.ref) || 0,
    end: Number(stats.end) || 0,
    ins: Number(stats.ins) || 0,
  };
  const maxHp = Number(stats.hp) || 20;
  return {
    uid, nickname, stats: s,
    hp: maxHp, maxHp,
    fatigue: 0,
    broken: false,       // 자세 붕괴
    exhausted: false,    // 탈진
    counterBonus: false, // 방어 성공 → 다음 라운드 반격 +2
  };
}

// 라운드 결과 연출용으로 저장하는 변동 값
export const dynamicState = (p) => ({
  hp: p.hp,
  fatigue: p.fatigue,
  broken: p.broken,
  exhausted: p.exhausted,
  counterBonus: p.counterBonus,
});

const die = (sides, rng) => 1 + Math.floor(rng() * sides);

function roll(p, action, extraMods, rng) {
  const s = p.stats;
  const mods = [];
  if (action === "attack") mods.push({ label: "기교", value: s.dex });
  if (action === "defend") mods.push({ label: "반응", value: s.ref }, { label: "방어", value: 2 });
  if (action === "feint") mods.push({ label: "기교", value: s.dex }, { label: "통찰/2", value: Math.floor(s.ins / 2) });
  if (action === "counter") {
    mods.push({ label: "반응", value: s.ref }, { label: "통찰/2", value: Math.floor(s.ins / 2) });
    if (p.counterBonus) mods.push({ label: "반격 보너스", value: 2 });
  }
  if (p.broken && BROKEN_PENALTY[action]) mods.push({ label: "자세 붕괴", value: BROKEN_PENALTY[action] });
  if (p.exhausted) mods.push({ label: "탈진", value: -2 });
  mods.push(...extraMods);
  const d = die(10, rng);
  return { die: d, sides: 10, mods, total: d + mods.reduce((a, m) => a + m.value, 0) };
}

/**
 * game: { p1, p2 } 플레이어 상태, act: { p1: action, p2: action }
 * 반환: { p1, p2 (새 상태), rolls, extras, logs }
 */
export function resolveRound(game, act, rng = Math.random) {
  const P = { p1: structuredClone(game.p1), p2: structuredClone(game.p2) };
  const rolls = { p1: null, p2: null };
  const extras = [];
  const logs = [];
  const gainedBonus = { p1: false, p2: false };
  const refitHit = { p1: false, p2: false };

  const nm = (k) => P[k].nickname;
  const R = (k, extra = []) => (rolls[k] = roll(P[k], act[k], extra, rng)).total;
  const hurt = (k, amount, why) => {
    P[k].hp = Math.max(0, P[k].hp - amount);
    logs.push(`${why} → ${nm(k)}에게 ${amount} 피해`);
  };
  const breakPosture = (k) => {
    P[k].broken = true;
    logs.push(`${nm(k)} 자세 붕괴!`);
  };
  const atkDmg = (k) => 3 + P[k].stats.str;
  const tie = () => logs.push("동점 — 무효");

  // x가 ACTIONS 순서상 앞선 행동을 가진 쪽
  const [x, y] = ACTIONS.indexOf(act.p1) <= ACTIONS.indexOf(act.p2) ? ["p1", "p2"] : ["p2", "p1"];

  switch (`${act[x]}-${act[y]}`) {
    case "attack-attack": {
      // 독립 판정: 각각 목표값 이상이면 명중
      for (const [k, o] of [[x, y], [y, x]]) {
        const t = R(k);
        if (t >= HIT_TARGET) hurt(o, atkDmg(k), `${nm(k)}의 공격 명중(${t})`);
        else logs.push(`${nm(k)}의 공격 빗나감 (${t} < ${HIT_TARGET})`);
      }
      break;
    }
    case "attack-defend": {
      const a = R(x), d = R(y);
      if (a > d) hurt(y, atkDmg(x), `${nm(x)}의 공격이 방어를 뚫음`);
      else {
        // 동점은 방어 우선
        logs.push(`${nm(y)}의 방어 성공! 피해 0`);
        logs.push(`${nm(y)}: 다음 라운드 반격 시 판정 +2`);
        gainedBonus[y] = true;
      }
      break;
    }
    case "attack-feint": {
      const a = R(x, [{ label: "견제 상대", value: 2 }]), f = R(y);
      if (a > f) hurt(y, atkDmg(x), `${nm(x)}의 공격이 견제를 뚫음`);
      else if (f > a) {
        logs.push(`${nm(y)}의 견제 성공`);
        breakPosture(x);
      } else tie();
      break;
    }
    case "attack-counter": {
      const a = R(x), c = R(y);
      if (a > c) hurt(y, atkDmg(x), `${nm(x)}의 공격이 반격보다 빠름`);
      else if (c > a) hurt(x, 5 + P[y].stats.str, `${nm(y)}의 반격 성공`);
      else tie();
      break;
    }
    case "attack-refit": {
      const bonus = die(5, rng);
      extras.push({ who: x, label: "재정비 노출 추가 피해", die: bonus, sides: 5 });
      refitHit[y] = true;
      hurt(y, atkDmg(x) + bonus, `재정비 중 공격 자동 명중 (+1D5=${bonus})`);
      break;
    }
    case "defend-defend": {
      P[x].fatigue += 1;
      P[y].fatigue += 1;
      logs.push("양측 방어 — 피해 없음, 양측 피로 +1");
      break;
    }
    case "defend-feint": {
      const d = R(x), f = R(y);
      if (f > d) {
        logs.push(`${nm(y)}의 견제가 방어를 흔듦`);
        breakPosture(x);
      } else logs.push(`${nm(x)}의 방어가 견제를 막아냄`);
      break;
    }
    case "defend-counter": {
      logs.push("서로 기다림 — 피해 없음");
      break;
    }
    case "feint-feint": {
      const a = R(x), b = R(y);
      if (a > b) breakPosture(y);
      else if (b > a) breakPosture(x);
      else tie();
      break;
    }
    case "feint-counter": {
      const f = R(x, [{ label: "반격 상대", value: 2 }]), c = R(y);
      if (f > c) {
        logs.push(`${nm(x)}의 견제 성공`);
        breakPosture(y);
      } else if (c > f) logs.push(`${nm(y)}가 견제를 버텨냄`);
      else tie();
      break;
    }
    case "counter-counter": {
      logs.push("양측 반격 실패 — 피해 없음");
      break;
    }
    case "defend-refit":
      logs.push(`${nm(x)}의 방어 무효`);
      break;
    case "feint-refit":
      logs.push(`${nm(x)}의 견제 효과 없음`);
      break;
    case "counter-refit":
      logs.push(`${nm(x)}의 반격 실패`);
      break;
    case "refit-refit":
      break;
  }

  for (const k of ["p1", "p2"]) {
    const p = P[k];
    if (act[k] === "refit") {
      if (refitHit[k]) {
        p.fatigue -= REFIT_HIT_RECOVER;
        logs.push(`${nm(k)} 재정비 방해 — 피로 ${REFIT_HIT_RECOVER}만 회복${p.broken ? ", 자세 붕괴 해제 실패" : ""}`);
      } else {
        p.fatigue -= REFIT_RECOVER;
        logs.push(`${nm(k)} 재정비 성공 — 피로 ${REFIT_RECOVER} 회복${p.broken ? ", 자세 붕괴 해제" : ""}`);
        p.broken = false;
      }
    } else {
      p.fatigue += FATIGUE_COST[act[k]];
    }
    p.fatigue = Math.max(0, p.fatigue);
    p.counterBonus = gainedBonus[k]; // 바로 다음 라운드에만 유효

    const wasExhausted = p.exhausted;
    p.exhausted = p.fatigue >= fatigueLimit(p);
    if (p.exhausted && !wasExhausted) logs.push(`${nm(k)} 탈진! (재정비 외 모든 판정 -2)`);
    if (!p.exhausted && wasExhausted) logs.push(`${nm(k)} 탈진에서 회복`);
  }

  return { p1: P.p1, p2: P.p2, rolls, extras, logs };
}

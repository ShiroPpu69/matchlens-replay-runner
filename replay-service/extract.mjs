import { enhanceKills } from "./enhance.mjs";

const heroPrefix = "CDOTA_Unit_Hero_";

const retainedCombatLogTypes = new Set([
  "DOTA_COMBATLOG_DEATH", "DOTA_ABILITY_LEVEL", "DOTA_COMBATLOG_PURCHASE",
  "DOTA_COMBATLOG_DAMAGE", "DOTA_COMBATLOG_HEAL", "DOTA_COMBATLOG_BUYBACK",
  "DOTA_COMBATLOG_TEAM_BUILDING_KILL", "DOTA_COMBATLOG_ABILITY", "DOTA_COMBATLOG_ITEM",
]);

export function shouldRetainReplayEntry(entry) {
  const type = String(entry?.type ?? "");
  return type === "interval" || type === "player_slot" || retainedCombatLogTypes.has(type)
    || ["obs", "sen", "obs_left", "sen_left"].includes(type)
    || type.startsWith("CHAT_MESSAGE_");
}

function heroKeys(unit) {
  if (typeof unit !== "string" || !unit.startsWith(heroPrefix)) return [];
  const ending = unit.slice(heroPrefix.length);
  return [`npc_dota_hero_${ending.toLowerCase()}`, `npc_dota_hero${ending.replace(/([A-Z])/g, "_$1").toLowerCase()}`];
}

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

function ratio(part, total) {
  return total > 0 ? Number((part / total).toFixed(4)) : 0;
}

function actionTarget(entry, indexes) {
  const heroKey = typeof entry.targetname === "string" && entry.targetname.startsWith("npc_dota_hero_") ? entry.targetname : null;
  return { targetHeroKey: heroKey, targetPlayerSlot: heroKey ? indexes.playerSlotForHero(heroKey) : null };
}

function normalizeActionKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return key && key !== "unknown" ? key.replace(/^item_/, "") : null;
}

function buildIndexes(entries) {
  const heroToSlot = new Map();
  const slotToPlayerSlot = new Map();
  for (const entry of entries) {
    if (entry.type === "player_slot") slotToPlayerSlot.set(Number(entry.key), Number(entry.value));
    if (entry.type === "interval" && Number.isInteger(entry.slot)) for (const key of heroKeys(entry.unit)) heroToSlot.set(key, entry.slot);
  }
  const playerSlotForHero = (hero) => {
    const slot = heroToSlot.get(hero);
    return slot === undefined ? null : slotToPlayerSlot.get(slot) ?? null;
  };
  return { slotToPlayerSlot, playerSlotForHero };
}

function compactEvent(entry, indexes) {
  return {
    gameTime: finite(entry.time),
    playerSlot: Number.isInteger(entry.slot) ? indexes.slotToPlayerSlot.get(entry.slot) ?? null : indexes.playerSlotForHero(entry.targetname),
    heroKey: typeof entry.targetname === "string" && entry.targetname.startsWith("npc_dota_hero_") ? entry.targetname : null,
  };
}

function aggregateCombat(entries, type, indexes) {
  const rows = new Map();
  for (const entry of entries) {
    if (entry.type !== type || !entry.attackerhero || !entry.targethero || entry.attackerillusion || entry.targetillusion) continue;
    const value = finite(entry.value);
    if (value === null || value <= 0) continue;
    const source = String(entry.sourcename ?? entry.attackername ?? "unknown");
    const target = String(entry.targetname ?? "unknown");
    const inflictor = String(entry.inflictor ?? "unknown");
    const key = `${source}|${target}|${inflictor}`;
    const row = rows.get(key) ?? {
      sourcePlayerSlot: indexes.playerSlotForHero(source), targetPlayerSlot: indexes.playerSlotForHero(target),
      sourceHeroKey: source, targetHeroKey: target, inflictor, total: 0, instances: 0, firstGameTime: finite(entry.time), lastGameTime: finite(entry.time),
    };
    row.total += value;
    row.instances += 1;
    row.lastGameTime = finite(entry.time);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export function extractReplayData(entries) {
  const indexes = buildIndexes(entries);
  const positions = [];
  const minuteSamples = [];
  const lastPositionBucket = new Map();
  const lastMinuteBucket = new Map();
  const abilityUpgrades = [];
  const purchases = [];
  const wards = [];
  const objectives = [];
  const buybacks = [];
  const runeEvents = [];
  const abilityCasts = [];
  const itemUses = [];
  const lifeStateTransitions = [];
  const seenActions = new Set();
  const lastLifeState = new Map();
  let positionSamplesWithHealth = 0;
  let positionSamplesWithMana = 0;
  let positionSamplesWithLifeState = 0;
  let actionEntriesSeen = 0;
  let actionEntriesWithResolvedActor = 0;

  for (const entry of entries) {
    if (entry.type === "interval" && Number.isInteger(entry.slot)) {
      const playerSlot = indexes.slotToPlayerSlot.get(entry.slot) ?? null;
      const gameTime = finite(entry.time);
      if (playerSlot === null || gameTime === null) continue;
      const x = finite(entry.x); const y = finite(entry.y);
      const lifeState = finite(entry.life_state);
      const previousLifeState = lastLifeState.get(entry.slot);
      if (gameTime >= 0 && lifeState !== null && previousLifeState !== undefined && previousLifeState !== lifeState) {
        lifeStateTransitions.push({
          gameTime,
          playerSlot,
          fromLifeState: previousLifeState,
          toLifeState: lifeState,
          transition: previousLifeState === 0 && lifeState !== 0 ? "death" : previousLifeState !== 0 && lifeState === 0 ? "respawn" : "state_change",
          source: "replay_entity_state",
        });
      }
      if (lifeState !== null) lastLifeState.set(entry.slot, lifeState);
      const positionBucket = Math.floor(gameTime / 5);
      if (gameTime >= 0 && x !== null && y !== null && lastPositionBucket.get(entry.slot) !== positionBucket) {
        lastPositionBucket.set(entry.slot, positionBucket);
        const health = finite(entry.health); const maxHealth = finite(entry.max_health);
        const mana = finite(entry.mana); const maxMana = finite(entry.max_mana);
        if (health !== null && maxHealth !== null && maxHealth > 0) positionSamplesWithHealth += 1;
        if (mana !== null && maxMana !== null && maxMana > 0) positionSamplesWithMana += 1;
        if (lifeState !== null) positionSamplesWithLifeState += 1;
        positions.push({ gameTime, playerSlot, x, y, lifeState, level: finite(entry.level), health, maxHealth, mana, maxMana });
      }
      const minuteBucket = Math.floor(Math.max(0, gameTime) / 60);
      if (gameTime >= 0 && lastMinuteBucket.get(entry.slot) !== minuteBucket) {
        lastMinuteBucket.set(entry.slot, minuteBucket);
        minuteSamples.push({ gameTime, playerSlot, gold: finite(entry.gold), netWorth: finite(entry.networth), xp: finite(entry.xp), level: finite(entry.level), lastHits: finite(entry.lh), denies: finite(entry.denies), kills: finite(entry.kills), deaths: finite(entry.deaths), assists: finite(entry.assists) });
      }
      continue;
    }
    if (entry.type === "DOTA_ABILITY_LEVEL" && finite(entry.abilitylevel) !== null && Number(entry.abilitylevel) > 0) {
      abilityUpgrades.push({ ...compactEvent(entry, indexes), abilityKey: String(entry.valuename ?? "unknown"), abilityLevel: Number(entry.abilitylevel), source: "replay_combat_log" });
    } else if (entry.type === "DOTA_COMBATLOG_PURCHASE") {
      purchases.push({ ...compactEvent(entry, indexes), itemKey: String(entry.valuename ?? "unknown").replace(/^item_/, ""), charges: finite(entry.charges), source: "replay_combat_log" });
    } else if (["obs", "sen", "obs_left", "sen_left"].includes(entry.type)) {
      wards.push({ gameTime: finite(entry.time), playerSlot: Number.isInteger(entry.slot) ? indexes.slotToPlayerSlot.get(entry.slot) ?? null : null, kind: entry.type, x: finite(entry.x), y: finite(entry.y), entityHandle: finite(entry.ehandle) });
    } else if (entry.type === "DOTA_COMBATLOG_BUYBACK") {
      buybacks.push({ gameTime: finite(entry.time), playerSlot: finite(entry.value), source: "replay_combat_log" });
    } else if (entry.type === "DOTA_COMBATLOG_ABILITY" || entry.type === "DOTA_COMBATLOG_ITEM") {
      const sourceHeroKey = [entry.attackername, entry.sourcename]
        .find((value) => typeof value === "string" && value.startsWith("npc_dota_hero_")) ?? null;
      if (sourceHeroKey) actionEntriesSeen += 1;
      const playerSlot = sourceHeroKey ? indexes.playerSlotForHero(sourceHeroKey) : null;
      const rawActionKey = entry.inflictor ?? entry.inflictorname ?? entry.valuename;
      const actionKey = normalizeActionKey(rawActionKey);
      if (playerSlot === null || actionKey === null) continue;
      actionEntriesWithResolvedActor += 1;
      const gameTime = finite(entry.time);
      const target = actionTarget(entry, indexes);
      const dedupeKey = `${entry.type}|${gameTime ?? -1}|${playerSlot}|${actionKey}|${target.targetHeroKey ?? ""}|${finite(entry.value) ?? ""}`;
      if (seenActions.has(dedupeKey)) continue;
      seenActions.add(dedupeKey);
      const action = { gameTime, playerSlot, heroKey: sourceHeroKey, ...target, actionKey, value: finite(entry.value), source: "replay_combat_log" };
      if (entry.type === "DOTA_COMBATLOG_ITEM" || String(rawActionKey ?? "").startsWith("item_")) itemUses.push(action);
      else abilityCasts.push(action);
    } else if (String(entry.type).startsWith("CHAT_MESSAGE_") || entry.type === "DOTA_COMBATLOG_TEAM_BUILDING_KILL") {
      if (["CHAT_MESSAGE_TOWER_KILL", "CHAT_MESSAGE_BARRACKS_KILL", "CHAT_MESSAGE_ROSHAN_KILL", "CHAT_MESSAGE_AEGIS", "CHAT_MESSAGE_GLYPH_USED", "CHAT_MESSAGE_SCAN_USED", "CHAT_MESSAGE_COURIER_LOST", "DOTA_COMBATLOG_TEAM_BUILDING_KILL"].includes(entry.type)) {
        objectives.push({ gameTime: finite(entry.time), type: entry.type, player1: finite(entry.player1), player2: finite(entry.player2), value: finite(entry.value), target: typeof entry.targetname === "string" ? entry.targetname : null });
      }
      if (entry.type === "CHAT_MESSAGE_RUNE_PICKUP") runeEvents.push({ gameTime: finite(entry.time), playerSlot: finite(entry.player1), rune: finite(entry.value) });
    }
  }

  return {
    kills: enhanceKills(entries),
    abilityUpgrades,
    purchases,
    positionSamples: positions,
    minuteSamples,
    wards,
    objectives,
    buybacks,
    runeEvents,
    damageBySourceTarget: aggregateCombat(entries, "DOTA_COMBATLOG_DAMAGE", indexes),
    healingBySourceTarget: aggregateCombat(entries, "DOTA_COMBATLOG_HEAL", indexes),
    abilityCasts,
    itemUses,
    lifeStateTransitions,
    coverage: {
      positionIntervalSeconds: 5,
      economyIntervalSeconds: 60,
      lowLevelActionsOmitted: true,
      actionEventsCaptured: true,
      actionEventFilterVersion: 4,
      decisionStateFields: ["health", "maxHealth", "mana", "maxMana", "lifeState", "position"],
      positionSamples: positions.length,
      positionSamplesWithHealth,
      positionSamplesWithMana,
      positionSamplesWithLifeState,
      healthStateCoverage: ratio(positionSamplesWithHealth, positions.length),
      manaStateCoverage: ratio(positionSamplesWithMana, positions.length),
      lifeStateCoverage: ratio(positionSamplesWithLifeState, positions.length),
      actionEntriesSeen,
      actionEntriesWithResolvedActor,
      actionActorResolutionRate: ratio(actionEntriesWithResolvedActor, actionEntriesSeen),
      observedAbilityCasts: abilityCasts.length,
      observedItemUses: itemUses.length,
      observedLifeStateTransitions: lifeStateTransitions.length,
      source: "Valve replay parsed by odota/parser",
    },
  };
}

function combatNames(unit) {
  if (typeof unit !== "string" || !unit.startsWith("CDOTA_Unit_Hero_")) return [];
  const ending = unit.slice("CDOTA_Unit_Hero_".length);
  return [
    `npc_dota_hero_${ending.toLowerCase()}`,
    `npc_dota_hero${ending.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
  ];
}

function beforeAndAfter(samples, time) {
  let before = null;
  let after = null;
  for (const sample of samples) {
    if (sample.time < time) before = sample;
    if (sample.time >= time) { after = sample; break; }
  }
  return { before, after };
}

function beforeAndAfterSequence(samples, sequence) {
  let before = null;
  let after = null;
  for (const sample of samples) {
    if (sample.sequence < sequence) before = sample;
    if (sample.sequence > sequence) { after = sample; break; }
  }
  return { before, after };
}

function sideForSlot(slot) {
  if (!Number.isInteger(slot)) return null;
  return slot < 5 ? "radiant" : "dire";
}

function creditedSide(death, killerSlot, victimSlot) {
  const heroSide = sideForSlot(killerSlot);
  if (heroSide) return heroSide;
  const source = String(death.killer ?? "").toLowerCase();
  if (source.includes("goodguys")) return "radiant";
  if (source.includes("badguys")) return "dire";
  return victimSlot === undefined ? null : sideForSlot(victimSlot) === "radiant" ? "dire" : "radiant";
}

function resolveSameCounterWindow(group, snapshots, heroToSlot) {
  const firstSequence = group[0].sequence;
  const lastSequence = group[group.length - 1].sequence;
  const resolutions = new Map(group.map((death) => [death.sequence, { assisters: new Set(), ambiguous: false }]));
  const deathsBySide = new Map();

  for (const death of group) {
    const killerSlot = heroToSlot.get(death.killer);
    const victimSlot = heroToSlot.get(death.victim);
    const side = creditedSide(death, killerSlot, victimSlot);
    if (!side) {
      resolutions.get(death.sequence).ambiguous = true;
      continue;
    }
    const list = deathsBySide.get(side) ?? [];
    list.push({ death, killerSlot, victimSlot });
    deathsBySide.set(side, list);
  }

  for (const [side, sideDeaths] of deathsBySide) {
    for (const [slot, samples] of snapshots) {
      if (sideForSlot(slot) !== side) continue;
      const candidates = sideDeaths.filter(({ killerSlot, victimSlot }) => slot !== killerSlot && slot !== victimSlot);
      if (candidates.length === 0) continue;
      const before = beforeAndAfterSequence(samples, firstSequence).before;
      const after = beforeAndAfterSequence(samples, lastSequence).after;
      const delta = before?.assists === null || before?.assists === undefined || after?.assists === null || after?.assists === undefined
        ? null
        : after.assists - before.assists;
      if (delta === 0) continue;
      if (delta === candidates.length) {
        for (const { death } of candidates) resolutions.get(death.sequence).assisters.add(slot);
        continue;
      }
      for (const { death } of candidates) resolutions.get(death.sequence).ambiguous = true;
    }
  }
  return resolutions;
}

export function enhanceKills(entries) {
  const heroToSlot = new Map();
  const slotToPlayerSlot = new Map();
  const snapshots = new Map();
  const deaths = [];

  for (const [sequence, entry] of entries.entries()) {
    if (entry.type === "player_slot") slotToPlayerSlot.set(Number(entry.key), Number(entry.value));
    if (entry.type === "interval" && Number.isInteger(entry.slot)) {
      for (const name of combatNames(entry.unit)) heroToSlot.set(name, entry.slot);
      const list = snapshots.get(entry.slot) ?? [];
      list.push({ sequence, time: Number(entry.time), x: Number.isFinite(entry.x) ? entry.x : null, y: Number.isFinite(entry.y) ? entry.y : null, assists: Number.isFinite(entry.assists) ? entry.assists : null });
      snapshots.set(entry.slot, list);
    }
    if (entry.type === "DOTA_COMBATLOG_DEATH" && entry.targethero === true && entry.targetillusion !== true && entry.attackername !== entry.targetname) {
      deaths.push({ sequence, time: Number(entry.time), killer: entry.sourcename, victim: entry.targetname });
    }
  }

  const deathsAtTime = new Map();
  for (const death of deaths) {
    const group = deathsAtTime.get(death.time) ?? [];
    group.push(death);
    deathsAtTime.set(death.time, group);
  }
  const resolutions = new Map();
  for (const group of deathsAtTime.values()) {
    const groupResolutions = resolveSameCounterWindow(group, snapshots, heroToSlot);
    for (const [sequence, resolution] of groupResolutions) resolutions.set(sequence, resolution);
  }

  return deaths.map((death, index) => {
    const killerSlot = heroToSlot.get(death.killer);
    const victimSlot = heroToSlot.get(death.victim);
    const victimSamples = snapshots.get(victimSlot) ?? [];
    const victimState = beforeAndAfter(victimSamples, death.time);
    const positionSample = victimState.after?.time - death.time <= 1 ? victimState.after : death.time - (victimState.before?.time ?? -Infinity) <= 1 ? victimState.before : null;
    const resolution = resolutions.get(death.sequence) ?? { assisters: new Set(), ambiguous: true };
    const ambiguous = resolution.ambiguous;
    const assisterSlots = [...resolution.assisters];
    const sameSecondDeathCount = deathsAtTime.get(death.time)?.length ?? 1;
    return {
      id: `replay-kill-${death.time}-${index}`,
      gameTime: death.time,
      killerPlayerSlot: killerSlot === undefined ? null : slotToPlayerSlot.get(killerSlot) ?? null,
      victimPlayerSlot: victimSlot === undefined ? null : slotToPlayerSlot.get(victimSlot) ?? null,
      assisterPlayerSlots: ambiguous ? null : assisterSlots.map((slot) => slotToPlayerSlot.get(slot)).filter(Number.isInteger),
      assistsStatus: ambiguous ? "ambiguous_same_second" : sameSecondDeathCount > 1 ? "counter_delta_disambiguated" : "counter_delta",
      position: positionSample && positionSample.x !== null && positionSample.y !== null ? { x: positionSample.x, y: positionSample.y, sampleTime: positionSample.time } : null,
      positionStatus: positionSample ? "one_second_entity_sample" : "not_available",
    };
  });
}

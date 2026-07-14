// ============================================================
// BOT BRAIN — server-side port of the original learning system
// ============================================================
// The original client had genuinely smart bots: each named bot
// (Charlie, Koshy, Johny...) had a persistent "brain" stored in the
// browser's localStorage — experience, a level that climbed as they
// played, learned weights that adjusted their bidding/play tendencies,
// and a memory of which hands led to successful vs failed bids and
// plays. The server rewrite's bots were a simple static heuristic with
// none of that — a real regression, not just a missing nice-to-have.
//
// This ports the same data model and the same core mechanics server-
// side, with one necessary change: since there's no per-browser
// localStorage on a server, brains persist to a JSON file on disk
// instead, saved periodically so learning survives a server restart.
// ============================================================

const fs = require('fs');
const path = require('path');

const BRAINS_FILE = path.join(__dirname, 'bot-brains-data.json');

let botBrains = {};
let dirty = false;

function loadBrains() {
  try {
    if (fs.existsSync(BRAINS_FILE)) {
      botBrains = JSON.parse(fs.readFileSync(BRAINS_FILE, 'utf8'));
      console.log(`[bot-brain] Loaded ${Object.keys(botBrains).length} existing brain(s) from disk.`);
    }
  } catch (e) {
    console.error('[bot-brain] Failed to load brains file, starting fresh:', e.message);
    botBrains = {};
  }
}

function saveBrains() {
  if (!dirty) return;
  try {
    fs.writeFileSync(BRAINS_FILE, JSON.stringify(botBrains));
    dirty = false;
  } catch (e) {
    console.error('[bot-brain] Failed to save brains file:', e.message);
  }
}
// Periodic save rather than on every single change — bidding/play
// happens fast (bots act via setImmediate), so writing to disk on every
// tiny update would be wasteful. Every 10s is plenty for learning that
// only needs to survive a restart, not every individual decision.
setInterval(saveBrains, 10000);
// Also save on process exit (e.g. a deploy restarting the service) --
// exiting itself is left to server.js's consolidated shutdown handler,
// so every module (this one, the visitor log, anything else added
// later) actually gets to save before the process actually terminates.
process.on('SIGTERM', () => { saveBrains(); });
process.on('SIGINT', () => { saveBrains(); });

function createDefaultBrain(botName) {
  return {
    name: botName,
    version: 3,
    created: Date.now(),
    lastPlayed: Date.now(),
    totalGames: 0,
    totalRounds: 0,
    totalTricks: 0,
    totalBids: 0,
    championshipsWon: 0,
    championshipsLost: 0,
    level: 1,
    experience: 0,
    bidWeights: {
      handStrength: 1.0,
      trumpPotential: 1.0,
      pointCards: 1.0,
      highCards: 1.0,
      partnerSupport: 0.5,
      aggression: 0.5
    },
    playWeights: {
      trickWinning: 1.0,
      pointConservation: 1.0,
      trumpManagement: 1.0,
      suitControl: 1.0,
      riskTaking: 0.3,
      bluffing: 0.1
    },
    patterns: {
      successfulBids: [],
      successfulPlays: [],
      failedBids: [],
      failedPlays: [],
      trumpExposures: []
    },
    stats: {
      bidsWon: 0, bidsLost: 0,
      tricksWon: 0, tricksLost: 0,
      pointsCaptured: 0, pointsGiven: 0,
      trumpCallsGood: 0, trumpCallsBad: 0
    },
    championshipHistory: [],
    // Per-human tendencies, keyed by playerId (stable across name changes/
    // reconnects). Separate from everything above, which is the bot's own
    // generic outcome history regardless of who it played with.
    humanProfiles: {}
  };
}

function defaultHumanProfile() {
  return {
    gamesWith: 0,
    lastPlayed: Date.now(),
    partnerBidsTotal: 0, partnerBidsWon: 0, // this human bid, and THIS bot was their partner
    opponentBidSum: 0, opponentBidCount: 0   // this human bid while opposing this bot
  };
}

// Fills in any fields a brain saved by an older version of this file is
// missing, without touching a single field it already has. Called on
// every getBrain() so this is automatic and invisible -- an existing
// save like the one already sitting in bot-brains-data.json just quietly
// gains humanProfiles: {} the next time it's loaded, XP/level/patterns/
// everything else exactly as they were.
function ensureBrainShape(brain) {
  const defaults = createDefaultBrain(brain.name);
  if (!brain.humanProfiles) brain.humanProfiles = {};
  if (!brain.playWeights) brain.playWeights = defaults.playWeights;
  else for (const k of Object.keys(defaults.playWeights)) if (brain.playWeights[k] === undefined) brain.playWeights[k] = defaults.playWeights[k];
  if (!brain.bidWeights) brain.bidWeights = defaults.bidWeights;
  else for (const k of Object.keys(defaults.bidWeights)) if (brain.bidWeights[k] === undefined) brain.bidWeights[k] = defaults.bidWeights[k];
  brain.version = defaults.version;
  return brain;
}

function getHumanProfile(brain, playerId) {
  if (!playerId) return null;
  if (!brain.humanProfiles[playerId]) brain.humanProfiles[playerId] = defaultHumanProfile();
  return brain.humanProfiles[playerId];
}

function getBrain(botName) {
  if (!botBrains[botName]) {
    botBrains[botName] = createDefaultBrain(botName);
  }
  return ensureBrainShape(botBrains[botName]);
}

// Called whenever a bid closes: if the bidder had a human partner, that
// human's "as partner" track record updates; if the bidder was a human
// opposing this bot, that human's "as opponent" bid average updates.
// Both are per (bot, human) pair -- Neha's read on a specific person is
// her own, independent of what Koshy has learned about that same person.
function recordHumanBidObservation(botName, humanPlayerId, wasPartner, bidValue, madeIt) {
  if (!humanPlayerId) return;
  const brain = getBrain(botName);
  const hp = getHumanProfile(brain, humanPlayerId);
  hp.gamesWith++;
  hp.lastPlayed = Date.now();
  if (wasPartner) {
    hp.partnerBidsTotal++;
    if (madeIt) hp.partnerBidsWon++;
  } else {
    hp.opponentBidSum += bidValue;
    hp.opponentBidCount++;
  }
  dirty = true;
}

// A trust multiplier for how much to lean into supporting THIS specific
// human partner's bidding, derived from their actual track record with
// this bot. No data yet -> neutral (1.0, i.e. don't change behavior).
// Comfortably proven partner -> lean in further. Repeatedly-missed
// partner -> pull back a little. Deliberately mild (0.75-1.25) so a
// short losing/winning streak can't swing behavior wildly.
function partnerTrustMultiplier(brain, humanPlayerId) {
  if (!humanPlayerId) return 1.0;
  const hp = brain.humanProfiles[humanPlayerId];
  if (!hp || hp.partnerBidsTotal < 3) return 1.0; // not enough history to trust yet
  const rate = hp.partnerBidsWon / hp.partnerBidsTotal;
  return 0.75 + rate * 0.5; // 0% success -> 0.75x, 100% success -> 1.25x
}

function calculateLevel(brain) {
  const exp = brain.experience;
  if (exp >= 5000) return 5;
  if (exp >= 3000) return 4;
  if (exp >= 1500) return 3;
  if (exp >= 500) return 2;
  return 1;
}

function updateBrainLevel(brain) {
  const newLevel = calculateLevel(brain);
  if (newLevel > brain.level) {
    brain.level = newLevel;
    brain.bidWeights.aggression = Math.min(1.5, brain.bidWeights.aggression + 0.1);
    brain.playWeights.riskTaking = Math.min(1.0, brain.playWeights.riskTaking + 0.1);
    brain.playWeights.bluffing = Math.min(0.5, brain.playWeights.bluffing + 0.05);
    return true;
  }
  return false;
}

function addExperience(brain, amount) {
  brain.experience += amount;
  brain.lastPlayed = Date.now();
  dirty = true;
  return updateBrainLevel(brain);
}

function getHandProfile(hand) {
  const profile = { totalPoints: 0, suitCounts: {}, hasJ: false, has9: false, highCardCount: 0 };
  for (const s of ['♥', '♠', '♦', '♣']) profile.suitCounts[s] = 0;
  for (const c of hand) {
    profile.totalPoints += c.points;
    profile.suitCounts[c.suit]++;
    if (c.rank === 'J') profile.hasJ = true;
    if (c.rank === '9') profile.has9 = true;
    if (['J', '9', 'A', '10'].includes(c.rank)) profile.highCardCount++;
  }
  return profile;
}

function recordBidOutcome(botName, handProfile, bid, won, roundWon) {
  const brain = getBrain(botName);
  brain.totalBids++;
  if (won) {
    brain.stats.bidsWon++;
    brain.patterns.successfulBids.push({ handProfile, bid, roundWon, timestamp: Date.now() });
    if (brain.patterns.successfulBids.length > 50) brain.patterns.successfulBids.shift();
    addExperience(brain, 50);
  } else {
    brain.stats.bidsLost++;
    brain.patterns.failedBids.push({ handProfile, bid, timestamp: Date.now() });
    if (brain.patterns.failedBids.length > 50) brain.patterns.failedBids.shift();
    addExperience(brain, 10);
  }
  dirty = true;
}

function recordTrickOutcome(botName, situation, cardPlayed, won, points) {
  const brain = getBrain(botName);
  brain.totalTricks++;
  if (won) {
    brain.stats.tricksWon++;
    brain.stats.pointsCaptured += points;
    brain.patterns.successfulPlays.push({ situation, cardPlayed, points, timestamp: Date.now() });
    if (brain.patterns.successfulPlays.length > 100) brain.patterns.successfulPlays.shift();
    addExperience(brain, 20 + points * 5);
    brain.playWeights.trickWinning = Math.min(1.4, brain.playWeights.trickWinning + 0.01);
  } else {
    brain.stats.tricksLost++;
    brain.stats.pointsGiven += points;
    brain.patterns.failedPlays.push({ situation, cardPlayed, timestamp: Date.now() });
    if (brain.patterns.failedPlays.length > 100) brain.patterns.failedPlays.shift();
    addExperience(brain, 5);
    brain.playWeights.trickWinning = Math.max(0.7, brain.playWeights.trickWinning - 0.005);
  }
  dirty = true;
}

function recordTrumpExposure(botName, situation, exposed, goodOutcome) {
  const brain = getBrain(botName);
  brain.patterns.trumpExposures.push({ situation, exposed, goodOutcome, timestamp: Date.now() });
  if (brain.patterns.trumpExposures.length > 50) brain.patterns.trumpExposures.shift();
  if (goodOutcome) {
    brain.stats.trumpCallsGood++;
    addExperience(brain, 30);
    brain.playWeights.trumpManagement = Math.min(1.4, brain.playWeights.trumpManagement + 0.015);
  } else {
    brain.stats.trumpCallsBad++;
    addExperience(brain, 10);
    brain.playWeights.trumpManagement = Math.max(0.7, brain.playWeights.trumpManagement - 0.01);
  }
  dirty = true;
}

function recordRound(botName, won) {
  const brain = getBrain(botName);
  brain.totalRounds++;
  addExperience(brain, won ? 100 : 25);
  dirty = true;
}

module.exports = {
  loadBrains, saveBrains, getBrain, getHandProfile,
  recordBidOutcome, recordTrickOutcome, recordTrumpExposure, recordRound,
  recordHumanBidObservation, partnerTrustMultiplier, getHumanProfile
};

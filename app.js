/* ============================================================
   BEATFORGE — AI Beat Saber Auto-Mapper Engine v2
   Complete rewrite: Musical patterns, spectral lighting,
   section detection, streams, jumps, doubles, stacks
   Schema 3.3.0 | Beat Saber 1.40+
   ============================================================ */

(() => {
  "use strict";

  // ---- STATE ----
  const state = {
    audioFile: null,
    coverFile: null,
    coverBlob: null,
    coverReady: false,
    audioBuffer: null,
    audioDuration: 0,
    bpm: 0,
    bpmRegions: [], // Array of {startTime, endTime, bpm} for variable BPM songs
    onsets: [],
    energyCurve: [],
    spectralFlux: [],
    bassCurve: [],
    midCurve: [],
    highCurve: [],
    phrases: [],
    sections: [],
    generatedMap: null,
    rankScores: null,
    genSeed: 0, // Increments each generation for variety
    // Audio playback
    audioCtx: null,
    audioSource: null,
    isPlaying: false,
    playStartTime: 0,
    playOffset: 0,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    zoneAudio: $("#zone-audio"),
    zoneCover: $("#zone-cover"),
    inputAudio: $("#input-audio"),
    inputCover: $("#input-cover"),
    fileStatus: $("#file-status"),
    btnGenerate: $("#btn-generate"),
    btnExport: $("#btn-export"),
    btnPlay: $("#btn-play"),
    audioTime: $("#audio-time"),
    progressArea: $("#progress-area"),
    progressFill: $("#progress-fill"),
    progressText: $("#progress-text"),
    panelResults: $("#panel-results"),
    panelViz: $("#panel-viz"),
    panelDiffStats: $("#panel-diff-stats"),
    panelGrid: $("#panel-grid"),
    panelLog: $("#panel-log"),
    resultsGrid: $("#results-grid"),
    rankDisplay: $("#rank-display"),
    diffStatsTable: $("#diff-stats-table"),
    gridCanvas: $("#grid-canvas"),
    gridStats: $("#grid-stats"),
    genLog: $("#gen-log"),
    waveformCanvas: $("#waveform-canvas"),
    vizStats: $("#viz-stats"),
    sectionTimeline: $("#viz-section-list"),
    bandBass: $("#band-bass"),
    bandMid: $("#band-mid"),
    bandHigh: $("#band-high"),
    bgCanvas: $("#bg-canvas"),
  };

  // ---- CONSTANTS ----
  const SCHEMA_VERSION = "3.3.0";
  const MIN_LIGHTING_EVENTS = 200;
  const RANKED_THRESHOLD = 8.2;

  // BPM-adaptive difficulty settings — nps scales with BPM
  function getDiffSettings(diffName, bpm, style, complexity, density) {
    const cf = complexity / 100; // 0-1
    const df = density / 100;    // 0-1

    // Base NPS scaled by BPM (slower songs get proportionally fewer notes)
    const bpmFactor = Math.max(0.5, Math.min(1.5, bpm / 130));

    const BASE = {
      Easy:       { njs: 10, baseNps: 1.8,  wallDens: 0.03, bombRate: 0.008, arcRate: 0.0,  chainRate: 0.0,  doubleRate: 0.0,  jumpRate: 0.0,  streamLen: 0,  windowRate: 0.0,  burstRate: 0.0,  gallopRate: 0.0,  spiralRate: 0.0,  crossRate: 0.0,  towerRate: 0.0,  zigzagRate: 0.0,  inoutRate: 0.0  },
      Normal:     { njs: 12, baseNps: 3.0,  wallDens: 0.05, bombRate: 0.015, arcRate: 0.02, chainRate: 0.0,  doubleRate: 0.04, jumpRate: 0.0,  streamLen: 0,  windowRate: 0.0,  burstRate: 0.0,  gallopRate: 0.0,  spiralRate: 0.0,  crossRate: 0.0,  towerRate: 0.02, zigzagRate: 0.0,  inoutRate: 0.0  },
      Hard:       { njs: 14, baseNps: 4.8,  wallDens: 0.07, bombRate: 0.025, arcRate: 0.05, chainRate: 0.02, doubleRate: 0.08, jumpRate: 0.04, streamLen: 4,  windowRate: 0.02, burstRate: 0.05, gallopRate: 0.03, spiralRate: 0.02, crossRate: 0.02, towerRate: 0.04, zigzagRate: 0.03, inoutRate: 0.02 },
      Expert:     { njs: 16, baseNps: 6.5,  wallDens: 0.09, bombRate: 0.035, arcRate: 0.08, chainRate: 0.04, doubleRate: 0.15, jumpRate: 0.08, streamLen: 8,  windowRate: 0.04, burstRate: 0.08, gallopRate: 0.06, spiralRate: 0.04, crossRate: 0.04, towerRate: 0.06, zigzagRate: 0.05, inoutRate: 0.04 },
      ExpertPlus: { njs: 18, baseNps: 9.0,  wallDens: 0.11, bombRate: 0.045, arcRate: 0.12, chainRate: 0.06, doubleRate: 0.22, jumpRate: 0.12, streamLen: 16, windowRate: 0.06, burstRate: 0.12, gallopRate: 0.10, spiralRate: 0.06, crossRate: 0.06, towerRate: 0.08, zigzagRate: 0.07, inoutRate: 0.06 },
    };

    const b = { ...BASE[diffName] };

    // Apply BPM scaling
    b.nps = b.baseNps * bpmFactor;

    // Apply density slider
    b.nps *= 0.7 + df * 0.6; // 0.7x to 1.3x

    // Apply complexity slider
    b.doubleRate *= 0.5 + cf;
    b.jumpRate *= 0.3 + cf * 1.4;
    b.streamLen = Math.round(b.streamLen * (0.5 + cf));
    b.windowRate *= 0.3 + cf * 1.4;
    b.burstRate *= 0.3 + cf * 1.4;
    b.gallopRate *= 0.3 + cf * 1.4;
    b.spiralRate *= 0.3 + cf * 1.4;
    b.crossRate *= 0.2 + cf * 1.6;  // Crossovers scale strongly with complexity
    b.towerRate *= 0.4 + cf * 1.2;
    b.zigzagRate *= 0.3 + cf * 1.4;
    b.inoutRate *= 0.3 + cf * 1.4;

    // Apply style modifiers — each dramatically shapes the map per BSMG mapping styles
    switch (style) {
      case "dance":
        // BSMG: Flow-focused, big arm movements, doubles for emphasis, arcs connecting motions
        // Avoid streams/bursts, favor wide symmetric motions and inward/outward patterns
        b.doubleRate *= 1.6; b.jumpRate *= 0.3; b.streamLen = 0;
        b.arcRate *= 2.5; b.spiralRate *= 1.8; b.inoutRate *= 2.5;
        b.towerRate *= 1.5; b.crossRate *= 0.1; b.burstRate *= 0.2;
        b.gallopRate *= 0.3; b.zigzagRate *= 0.5; b.bombRate *= 0.3;
        b.windowRate *= 1.5; b.wallDens *= 0.5; // Few walls, dancers need space
        b.nps *= 0.85; // Slightly slower — feel the music
        break;
      case "tech":
        // BSMG ranked style: precise angles, varied patterns, windows, controlled crossovers
        // Clean parity, good flow, complex but readable. No spam, every note intentional
        b.windowRate *= 3; b.spiralRate *= 2; b.crossRate *= 2;
        b.zigzagRate *= 2.5; b.towerRate *= 1.5; b.inoutRate *= 1.5;
        b.jumpRate *= 0.5; b.streamLen = Math.round(b.streamLen * 0.6);
        b.burstRate *= 0.5; b.gallopRate *= 0.8; b.doubleRate *= 0.8;
        b.bombRate *= 2; // Bombs for precision/reset patterns
        b.wallDens *= 0.8; b.arcRate *= 1.5;
        b.chainRate *= 1.5; // Chains add tech variety
        break;
      case "speed":
        // BSMG: High NPS, long streams, bursts, gallops. Linear patterns for readability at speed
        // Minimize complex patterns that are hard to read fast — focus on alternating streams
        b.nps *= 1.3; b.streamLen = Math.round(b.streamLen * 2.5);
        b.burstRate *= 2.5; b.gallopRate *= 2;
        b.doubleRate *= 0.5; b.windowRate *= 0.3; b.crossRate *= 0.2;
        b.spiralRate *= 0.3; b.zigzagRate *= 0.3; b.towerRate *= 0.3;
        b.inoutRate *= 0.3; b.bombRate *= 0.3; b.wallDens *= 0.4;
        b.arcRate *= 0.5; // Arcs slow down speed feel
        break;
      case "fitness":
        // BSMG: Full body workout — LOTS of walls for dodging, big jumps, wide doubles
        // Crouch walls, side dodge walls, inward/outward patterns for full body motion
        b.wallDens *= 5; // 5x more walls — the defining feature of fitness
        b.jumpRate *= 3; b.doubleRate *= 1.8; b.inoutRate *= 3;
        b.towerRate *= 2; b.nps *= 0.8; // Lower NPS — fitness is about movement not speed
        b.streamLen = 0; b.burstRate *= 0.2; b.gallopRate *= 0.3;
        b.spiralRate *= 0.5; b.crossRate *= 0.2; b.zigzagRate *= 0.5;
        b.windowRate *= 1.5; b.bombRate *= 0.5; b.arcRate *= 1.5;
        b.chainRate *= 0.3;
        break;
      case "chill":
        // BSMG: Relaxed, ambient, slow. Mostly singles with occasional doubles. Arcs everywhere
        // No streams, no bursts, no complex patterns. Maximum breathing room
        b.nps *= 0.6; b.doubleRate *= 0.2; b.jumpRate *= 0.1;
        b.streamLen = 0; b.burstRate = 0; b.gallopRate = 0;
        b.spiralRate = 0; b.crossRate = 0; b.zigzagRate = 0;
        b.towerRate *= 0.3; b.inoutRate *= 0.3; b.windowRate *= 0.2;
        b.bombRate *= 0.1; b.wallDens *= 0.15;
        b.arcRate *= 3; b.chainRate *= 0.2;
        break;
      case "spam":
        // NOTE SPAM — note on every single beat, dense streams, doubles everywhere
        // Not for ranked/BeatSaver — this is a fun/challenge mode
        b.nps *= 2.0; b.streamLen = Math.round(b.streamLen * 4);
        b.burstRate *= 3; b.gallopRate *= 2.5;
        b.doubleRate *= 2; b.windowRate *= 2;
        b.jumpRate *= 1.5; b.crossRate *= 1.5;
        b.spiralRate *= 2; b.zigzagRate *= 2;
        b.towerRate *= 2; b.inoutRate *= 2;
        b.bombRate = 0; b.wallDens = 0; // No distractions, pure notes
        b.arcRate = 0; b.chainRate = 0; // Clean note field
        break;
      case "vibro":
        // VIBRO — extremely fast alternating notes for vibro players
        // 16th note streams, minimal doubles, maximum speed
        b.nps *= 2.5; b.streamLen = 32;
        b.burstRate *= 4; b.gallopRate = 0;
        b.doubleRate *= 0.3; b.windowRate = 0;
        b.jumpRate = 0; b.crossRate = 0;
        b.spiralRate = 0; b.zigzagRate = 0;
        b.towerRate = 0; b.inoutRate = 0;
        b.bombRate = 0; b.wallDens = 0;
        b.arcRate = 0; b.chainRate = 0;
        break;
    }

    // Store style for downstream use
    b.style = style;
    b.diffName = diffName;
    return b;
  }

  const D = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, UP_LEFT: 4, UP_RIGHT: 5, DOWN_LEFT: 6, DOWN_RIGHT: 7, ANY: 8 };
  const C = { RED: 0, BLUE: 1, BOMB: 3 };

  const IS_UP    = [D.UP, D.UP_LEFT, D.UP_RIGHT];
  const IS_DOWN  = [D.DOWN, D.DOWN_LEFT, D.DOWN_RIGHT];
  const IS_LEFT  = [D.LEFT, D.UP_LEFT, D.DOWN_LEFT];
  const IS_RIGHT = [D.RIGHT, D.UP_RIGHT, D.DOWN_RIGHT];

  // Direction angles in degrees (for swing angle tracking)
  const DIR_ANGLE = { [D.UP]: 180, [D.DOWN]: 0, [D.LEFT]: 90, [D.RIGHT]: 270, [D.UP_LEFT]: 135, [D.UP_RIGHT]: 225, [D.DOWN_LEFT]: 45, [D.DOWN_RIGHT]: 315, [D.ANY]: 0 };

  // End position of swing — where the saber ends up after swinging
  const SWING_END_ANGLE = {
    [D.UP]: 180, [D.DOWN]: 0, [D.LEFT]: 90, [D.RIGHT]: 270,
    [D.UP_LEFT]: 135, [D.UP_RIGHT]: 225, [D.DOWN_LEFT]: 45, [D.DOWN_RIGHT]: 315, [D.ANY]: 0,
  };

  // Parity-correct follow-up directions with comfort weighting
  // First direction in array is most comfortable, last is least
  const PARITY_FOLLOWUP = {
    [D.DOWN]:       [D.UP, D.UP_LEFT, D.UP_RIGHT],
    [D.DOWN_LEFT]:  [D.UP_RIGHT, D.UP, D.RIGHT],
    [D.DOWN_RIGHT]: [D.UP_LEFT, D.UP, D.LEFT],
    [D.UP]:         [D.DOWN, D.DOWN_LEFT, D.DOWN_RIGHT],
    [D.UP_LEFT]:    [D.DOWN_RIGHT, D.DOWN, D.RIGHT],
    [D.UP_RIGHT]:   [D.DOWN_LEFT, D.DOWN, D.LEFT],
    [D.LEFT]:       [D.RIGHT, D.DOWN_RIGHT, D.UP_RIGHT],
    [D.RIGHT]:      [D.LEFT, D.DOWN_LEFT, D.UP_LEFT],
    [D.ANY]:        [D.DOWN, D.UP, D.DOWN_LEFT, D.DOWN_RIGHT],
  };

  // Angle difference helper (for comfort scoring)
  // Audio fingerprint — creates a unique hash from spectral features
  // Used to seed pattern choices so each song generates different maps
  function computeAudioFingerprint() {
    const curve = state.energyCurve;
    if (!curve || curve.length < 100) return Math.random() * 1000;
    // Sample 16 evenly-spaced points from energy curve
    let hash = 0;
    const step = Math.floor(curve.length / 16);
    for (let i = 0; i < 16; i++) {
      hash = ((hash << 5) - hash + Math.floor(curve[i * step] * 1000)) | 0;
    }
    // Mix in BPM and onset count
    hash = ((hash << 5) - hash + (state.bpm || 120)) | 0;
    hash = ((hash << 5) - hash + (state.onsets ? state.onsets.length : 0)) | 0;
    return Math.abs(hash);
  }

  // Seeded random using audio fingerprint — same song = same seed
  function seededChoice(arr, beat) {
    if (!arr || arr.length === 0) return null;
    const fp = state.audioFingerprint || 0;
    const idx = Math.abs((fp * 31 + Math.floor(beat * 7)) % arr.length);
    return arr[idx];
  }

  function angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Check if a direction is "natural" follow-up considering wrist reset
  function isComfortableTransition(prevDir, nextDir, hand) {
    // Red hand (left) prefers: down, down-left, up-right, up
    // Blue hand (right) prefers: down, down-right, up-left, up
    const diff = angleDiff(SWING_END_ANGLE[prevDir], DIR_ANGLE[nextDir]);
    // Ideal transitions are 120-180 degrees apart (opposite swing)
    return diff >= 100 && diff <= 220;
  }

  // Arm crossing detection — returns true if note placement would cause uncomfortable crossing
  function wouldCrossArms(redX, blueX, redBeat, blueBeat, beat) {
    // Red on right side of blue = crossing
    if (Math.abs(redBeat - beat) < 0.5 && Math.abs(blueBeat - beat) < 0.5) {
      return redX > blueX + 1; // Red shouldn't be more than 1 column right of blue
    }
    return false;
  }

  // ============================================================
  // FLOW-BASED POSITION SYSTEM
  // Replaces random position tables with smooth grid movement
  // ============================================================

  // BSMG-correct row placement:
  // Real maps keep most notes in bottom (y=0) and middle (y=1) rows.
  // Top row (y=2) is used SPARINGLY for emphasis — it requires bigger swings
  // and causes shoulder fatigue per BSMG wiki.
  // The arrow direction tells the player which way to swing — it does NOT
  // require the note to be at a specific row.

  // Home positions — bottom row, natural resting height
  const HOME = {
    [C.RED]:  { x: 1, y: 0 },
    [C.BLUE]: { x: 2, y: 0 },
  };

  const TERRITORY = {
    [C.RED]:  { minX: 0, maxX: 2, preferX: 1 },
    [C.BLUE]: { minX: 1, maxX: 3, preferX: 2 },
  };

  // Row selection — mostly y=0 and y=1, y=2 only for emphasis
  // Row placement — energy-driven, no periodic patterns
  function getTargetRow(dir, energy, section, swingCount) {
    // DROP/CHORUS: energy determines row distribution
    if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
      if (IS_DOWN.includes(dir)) {
        // High energy → occasional top row (15%), mostly mid/bottom
        if (energy > 0.7 && Math.random() < 0.15) return 2;
        return Math.random() < 0.55 ? 1 : 0;  // 55% mid, 30% bottom
      }
      return 0; // Up-swings from bottom
    }

    // BUILDUP: top row emerges as energy rises
    if (section.type === SEC.BUILDUP) {
      if (IS_DOWN.includes(dir) && energy > 0.6 && Math.random() < energy * 0.12) return 2;
      if (IS_DOWN.includes(dir)) return Math.random() < 0.5 ? 1 : 0;
      return 0;
    }

    // VERSE/INTRO/BREAK: mostly bottom two rows
    if (IS_DOWN.includes(dir)) return Math.random() < 0.4 ? 1 : 0;
    if (IS_UP.includes(dir)) return 0;
    return Math.random() < 0.6 ? 1 : 0;
  }

  function getDirColumnBias(dir, hand) {
    if (IS_LEFT.includes(dir))  return hand === C.RED ? 1 : 0;
    if (IS_RIGHT.includes(dir)) return hand === C.RED ? -1 : 0;
    return 0;
  }

  // Core position selection — organic movement, no periodic cycles
  function getFlowPosition(hand, dir, hs, section, energy) {
    const state_h = hs[hand];
    const terr = TERRITORY[hand];
    const home = HOME[hand];
    const idealY = getTargetRow(dir, energy, section, state_h.swingCount);
    const colBias = getDirColumnBias(dir, hand);
    const isReset = state_h.lastBeat < -5;
    const mlBias = getMLPositionBias();

    let prevX = isReset ? home.x : state_h.lastX;
    let prevY = isReset ? home.y : state_h.lastY;

    // Y: move toward ideal, max 1 step
    let targetY = idealY;
    if (Math.abs(targetY - prevY) > 1) targetY = prevY + (targetY > prevY ? 1 : -1);
    if (prevY === 2 && targetY === 2 && energy < 0.7) targetY = 1;

    // X: ORGANIC MOVEMENT — driven by energy + randomness, no fixed cycles
    let targetX = prevX;

    // Movement probability scales with energy and section intensity
    const moveChance = section.type === SEC.DROP || section.type === SEC.CHORUS
      ? 0.25 + energy * 0.35  // 25-60% chance to move in energetic sections
      : section.type === SEC.BUILDUP
        ? 0.15 + energy * 0.25  // 15-40% in buildups
        : 0.08;  // 8% in calm sections — mostly stay put

    if (Math.random() < moveChance) {
      // Decide: move toward edge, move toward home, or follow direction bias
      const roll = Math.random();
      if (roll < 0.4 && energy > 0.5) {
        // EDGE PUSH — move outward from center for wider patterns
        targetX = hand === C.RED ? Math.max(terr.minX, prevX - 1) : Math.min(terr.maxX, prevX + 1);
      } else if (roll < 0.7 || energy < 0.3) {
        // HOME PULL — drift back toward home column
        if (prevX !== home.x) targetX = prevX + (home.x > prevX ? 1 : -1);
      } else {
        // DIRECTION FOLLOW — move where the swing points
        targetX = prevX + colBias;
      }
    } else {
      // STAY — keep current column (reduces jitter, feels more human)
      targetX = prevX;
    }

    // Gentle home gravity in calm sections only
    if ((section.type === SEC.VERSE || section.type === SEC.BREAK) && Math.random() < 0.15) {
      if (prevX !== home.x) targetX = prevX + (home.x > prevX ? 1 : -1);
    }

    // Clamp to territory
    targetX = Math.max(terr.minX, Math.min(terr.maxX, targetX));
    targetY = Math.max(0, Math.min(2, targetY));
    if (Math.abs(targetX - prevX) > 1) targetX = prevX + (targetX > prevX ? 1 : -1);

    return { x: targetX, y: targetY };
  }

  function getMirrorPosition(pos, dir) {
    return { x: 3 - pos.x, y: pos.y };
  }

  // Collision avoidance — prefer staying low
  function resolveCollision(pos, beat, notes, hand, otherHand, hs) {
    const conflict = notes.some(n =>
      n.c === otherHand && Math.abs(n.b - beat) < 0.25 && n.x === pos.x && n.y === pos.y
    );
    if (!conflict) return pos;

    const terr = TERRITORY[hand];
    const alternatives = [
      { x: pos.x + (hand === C.RED ? -1 : 1), y: pos.y },
      { x: pos.x, y: pos.y === 0 ? 1 : 0 },  // Prefer bottom rows
      { x: pos.x + (hand === C.RED ? 1 : -1), y: pos.y },
      { x: terr.preferX, y: 0 },  // Home column, bottom row
    ];

    for (const alt of alternatives) {
      const ax = Math.max(terr.minX, Math.min(terr.maxX, alt.x));
      const ay = Math.max(0, Math.min(2, alt.y));
      const altConflict = notes.some(n =>
        n.c === otherHand && Math.abs(n.b - beat) < 0.25 && n.x === ax && n.y === ay
      );
      if (!altConflict) return { x: ax, y: ay };
    }

    return { x: terr.preferX, y: 0 };
  }

  // Stream lanes — bottom/middle row pumping (not top row)
  const STREAM_LANES = {
    [C.RED]: [
      { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 },
      { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 },
    ],
    [C.BLUE]: [
      { x: 2, y: 1 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 0 },
      { x: 3, y: 1 }, { x: 3, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 0 },
    ],
  };

  // Stream patterns — long parity-correct sequences with more variety
  const STREAM_PATTERNS_RED = [
    [D.DOWN, D.UP, D.DOWN, D.UP, D.DOWN_LEFT, D.UP_RIGHT, D.DOWN, D.UP],
    [D.DOWN_LEFT, D.UP_RIGHT, D.DOWN, D.UP, D.DOWN_LEFT, D.UP, D.DOWN_RIGHT, D.UP_LEFT],
    [D.DOWN, D.UP_LEFT, D.DOWN_RIGHT, D.UP, D.DOWN, D.UP_RIGHT, D.DOWN_LEFT, D.UP],
    [D.DOWN_RIGHT, D.UP, D.DOWN, D.UP_LEFT, D.DOWN_RIGHT, D.UP_LEFT, D.DOWN, D.UP_RIGHT],
    [D.DOWN, D.UP, D.DOWN_LEFT, D.UP_RIGHT, D.DOWN_RIGHT, D.UP_LEFT, D.DOWN, D.UP],
    [D.DOWN_LEFT, D.UP, D.DOWN, D.UP_RIGHT, D.DOWN, D.UP_LEFT, D.DOWN_RIGHT, D.UP],
  ];
  const STREAM_PATTERNS_BLUE = [
    [D.DOWN, D.UP, D.DOWN, D.UP, D.DOWN_RIGHT, D.UP_LEFT, D.DOWN, D.UP],
    [D.DOWN_RIGHT, D.UP_LEFT, D.DOWN, D.UP, D.DOWN_RIGHT, D.UP, D.DOWN_LEFT, D.UP_RIGHT],
    [D.DOWN, D.UP_RIGHT, D.DOWN_LEFT, D.UP, D.DOWN, D.UP_LEFT, D.DOWN_RIGHT, D.UP],
    [D.DOWN_LEFT, D.UP, D.DOWN, D.UP_RIGHT, D.DOWN_LEFT, D.UP_RIGHT, D.DOWN, D.UP_LEFT],
    [D.DOWN, D.UP, D.DOWN_RIGHT, D.UP_LEFT, D.DOWN_LEFT, D.UP_RIGHT, D.DOWN, D.UP],
    [D.DOWN_RIGHT, D.UP, D.DOWN, D.UP_LEFT, D.DOWN, D.UP_RIGHT, D.DOWN_LEFT, D.UP],
  ];

  // Burst patterns — quick 3-4 note clusters (same hand)
  const BURST_PATTERNS = [
    [D.DOWN, D.UP, D.DOWN],
    [D.DOWN_LEFT, D.UP_RIGHT, D.DOWN],
    [D.DOWN_RIGHT, D.UP_LEFT, D.DOWN],
    [D.DOWN, D.UP, D.DOWN, D.UP],
  ];

  // Gallop patterns — alternating hands in quick succession with emphasis
  // Each entry is [hand_offset, dir_red, dir_blue] — hand_offset 0=red first, 1=blue first
  const GALLOP_RHYTHMS = [
    { spacing: [0, 0.25, 0.5], hands: [0, 1, 0] },   // red-blue-red quick
    { spacing: [0, 0.25, 0.75], hands: [1, 0, 1] },   // blue-red-blue with gap
    { spacing: [0, 0.25, 0.5, 1.0], hands: [0, 1, 0, 1] }, // four-hit gallop
  ];

  // Spiral movement patterns — notes move across the grid in arc paths
  const SPIRAL_RED = [
    [{ x: 0, y: 0, d: D.DOWN }, { x: 1, y: 1, d: D.DOWN_RIGHT }, { x: 1, y: 0, d: D.UP }, { x: 0, y: 1, d: D.UP_LEFT }],
    [{ x: 1, y: 1, d: D.DOWN }, { x: 0, y: 0, d: D.UP_LEFT }, { x: 1, y: 0, d: D.UP }, { x: 1, y: 1, d: D.DOWN }],
  ];
  const SPIRAL_BLUE = [
    [{ x: 3, y: 0, d: D.DOWN }, { x: 2, y: 1, d: D.DOWN_LEFT }, { x: 2, y: 0, d: D.UP }, { x: 3, y: 1, d: D.UP_RIGHT }],
    [{ x: 2, y: 1, d: D.DOWN }, { x: 3, y: 0, d: D.UP_RIGHT }, { x: 2, y: 0, d: D.UP }, { x: 2, y: 1, d: D.DOWN }],
  ];

  // Emphasis patterns — strong hit positions for impactful beats
  const EMPHASIS_RED = [
    { x: 1, y: 1, d: D.DOWN },
    { x: 0, y: 1, d: D.DOWN_LEFT },
    { x: 1, y: 0, d: D.UP },
  ];
  const EMPHASIS_BLUE = [
    { x: 2, y: 1, d: D.DOWN },
    { x: 3, y: 1, d: D.DOWN_RIGHT },
    { x: 2, y: 0, d: D.UP },
  ];

  // ---- NEW: Crossover patterns (controlled hand crossing — tech maps) ----
  // Red crosses to blue side briefly then returns; parity-safe
  const CROSSOVER_RED = [
    [{ x: 1, y: 1, d: D.DOWN }, { x: 2, y: 0, d: D.UP_RIGHT }, { x: 1, y: 1, d: D.DOWN_LEFT }, { x: 0, y: 0, d: D.UP }],
    [{ x: 1, y: 1, d: D.DOWN }, { x: 2, y: 0, d: D.UP }, { x: 2, y: 1, d: D.DOWN_RIGHT }, { x: 1, y: 0, d: D.UP_LEFT }],
  ];
  const CROSSOVER_BLUE = [
    [{ x: 2, y: 1, d: D.DOWN }, { x: 1, y: 0, d: D.UP_LEFT }, { x: 2, y: 1, d: D.DOWN_RIGHT }, { x: 3, y: 0, d: D.UP }],
    [{ x: 2, y: 1, d: D.DOWN }, { x: 1, y: 0, d: D.UP }, { x: 1, y: 1, d: D.DOWN_LEFT }, { x: 2, y: 0, d: D.UP_RIGHT }],
  ];

  // ---- NEW: Tower/Stack patterns (both hands vertically aligned) ----
  const TOWER_PATTERNS = [
    { r: { x: 1, y: 0, d: D.UP }, b: { x: 2, y: 0, d: D.UP } },        // Bottom up
    { r: { x: 1, y: 1, d: D.DOWN }, b: { x: 2, y: 1, d: D.DOWN } },    // Middle down
    { r: { x: 0, y: 1, d: D.LEFT }, b: { x: 3, y: 1, d: D.RIGHT } },   // Wide outward
    { r: { x: 1, y: 1, d: D.DOWN_LEFT }, b: { x: 2, y: 1, d: D.DOWN_RIGHT } }, // V-shape
    { r: { x: 1, y: 0, d: D.UP_LEFT }, b: { x: 2, y: 0, d: D.UP_RIGHT } },   // V-shape up
    { r: { x: 0, y: 1, d: D.DOWN }, b: { x: 3, y: 1, d: D.DOWN } },    // Wide down
  ];

  // ---- NEW: Zigzag patterns (alternating left-right movement) ----
  const ZIGZAG_RED = [
    [{ x: 0, y: 1, d: D.DOWN }, { x: 1, y: 0, d: D.UP_RIGHT }, { x: 0, y: 1, d: D.DOWN_LEFT }, { x: 1, y: 0, d: D.UP }],
    [{ x: 1, y: 1, d: D.DOWN }, { x: 0, y: 0, d: D.UP_LEFT }, { x: 1, y: 1, d: D.DOWN_RIGHT }, { x: 0, y: 0, d: D.UP }],
  ];
  const ZIGZAG_BLUE = [
    [{ x: 3, y: 1, d: D.DOWN }, { x: 2, y: 0, d: D.UP_LEFT }, { x: 3, y: 1, d: D.DOWN_RIGHT }, { x: 2, y: 0, d: D.UP }],
    [{ x: 2, y: 1, d: D.DOWN }, { x: 3, y: 0, d: D.UP_RIGHT }, { x: 2, y: 1, d: D.DOWN_LEFT }, { x: 3, y: 0, d: D.UP }],
  ];

  // ---- NEW: Inward/Outward patterns (hands move toward/away from center) ----
  const INWARD_PATTERN = [
    { r: { x: 0, y: 1, d: D.RIGHT }, b: { x: 3, y: 1, d: D.LEFT } },   // Both swing inward
    { r: { x: 1, y: 2, d: D.DOWN_RIGHT }, b: { x: 2, y: 2, d: D.DOWN_LEFT } },
  ];
  const OUTWARD_PATTERN = [
    { r: { x: 1, y: 1, d: D.LEFT }, b: { x: 2, y: 1, d: D.RIGHT } },   // Both swing outward
    { r: { x: 1, y: 0, d: D.UP_LEFT }, b: { x: 2, y: 0, d: D.UP_RIGHT } },
  ];

  // ---- NEW: Momentum direction sequences (flow in a direction before switching) ----
  // Each is a full parity-correct sequence that "feels" like moving in one direction
  const MOMENTUM_DOWN_RED = [D.DOWN, D.UP, D.DOWN_LEFT, D.UP_RIGHT, D.DOWN, D.UP, D.DOWN_RIGHT, D.UP_LEFT];
  const MOMENTUM_UP_RED = [D.UP, D.DOWN, D.UP_RIGHT, D.DOWN_LEFT, D.UP, D.DOWN, D.UP_LEFT, D.DOWN_RIGHT];
  const MOMENTUM_DOWN_BLUE = [D.DOWN, D.UP, D.DOWN_RIGHT, D.UP_LEFT, D.DOWN, D.UP, D.DOWN_LEFT, D.UP_RIGHT];
  const MOMENTUM_UP_BLUE = [D.UP, D.DOWN, D.UP_LEFT, D.DOWN_RIGHT, D.UP, D.DOWN, D.UP_RIGHT, D.DOWN_LEFT];

  // Section types
  const SEC = { INTRO: "intro", VERSE: "verse", BUILDUP: "buildup", CHORUS: "chorus", DROP: "drop", BREAK: "break", OUTRO: "outro" };

  // ============================================================
  // SECTION A — BACKGROUND ANIMATION
  // ============================================================

  function initBackground() {
    const c = dom.bgCanvas;
    const ctx = c.getContext("2d");
    let w, h, time = 0;
    function resize() { w = c.width = window.innerWidth; h = c.height = window.innerHeight; }
    resize();
    window.addEventListener("resize", resize);

    // Perspective grid + floating particles
    const particles = [];
    for (let i = 0; i < 35; i++) {
      particles.push({
        x: Math.random() * 1, y: Math.random() * 1,
        speed: 0.0003 + Math.random() * 0.0006,
        size: Math.random() * 2.5 + 0.5,
        hue: Math.random() > 0.5 ? 190 : 350,
        alpha: Math.random() * 0.35 + 0.05,
      });
    }

    function draw() {
      time += 0.004;
      ctx.fillStyle = "rgba(2, 4, 8, 0.15)";
      ctx.fillRect(0, 0, w, h);

      // Perspective grid floor
      const horizon = h * 0.45;
      const gridLines = 20;
      const scrollOffset = (time * 60) % (h / gridLines);

      ctx.strokeStyle = "rgba(0, 229, 255, 0.06)";
      ctx.lineWidth = 1;

      // Horizontal lines (perspective)
      for (let i = 0; i < gridLines; i++) {
        const rawY = horizon + (i / gridLines) * (h - horizon) + scrollOffset;
        const y = horizon + ((rawY - horizon) % (h - horizon));
        if (y < horizon) continue;
        const depth = (y - horizon) / (h - horizon);
        ctx.globalAlpha = depth * 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Vertical lines (converging to vanishing point)
      const vanishX = w / 2;
      ctx.globalAlpha = 0.4;
      for (let i = -8; i <= 8; i++) {
        const bottomX = vanishX + i * (w / 8);
        ctx.strokeStyle = i === 0 ? "rgba(255, 23, 68, 0.08)" : "rgba(0, 229, 255, 0.04)";
        ctx.beginPath();
        ctx.moveTo(vanishX, horizon);
        ctx.lineTo(bottomX, h);
        ctx.stroke();
      }

      // Floating particles
      ctx.globalAlpha = 1;
      for (const p of particles) {
        p.y -= p.speed;
        if (p.y < 0) { p.y = 1; p.x = Math.random(); }
        const px = p.x * w;
        const py = p.y * h;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 100%, 60%, ${p.alpha})`;
        ctx.fill();
      }

      // Horizon glow
      const grd = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 20);
      grd.addColorStop(0, "transparent");
      grd.addColorStop(0.5, "rgba(0, 229, 255, 0.025)");
      grd.addColorStop(1, "transparent");
      ctx.fillStyle = grd;
      ctx.fillRect(0, horizon - 40, w, 60);

      requestAnimationFrame(draw);
    }
    draw();
  }

  // ============================================================
  // SECTION B — FILE HANDLING
  // ============================================================

  function setupFileInputs() {
    dom.zoneAudio.addEventListener("click", () => dom.inputAudio.click());
    dom.zoneAudio.addEventListener("dragover", (e) => { e.preventDefault(); dom.zoneAudio.style.borderColor = "var(--neon-cyan)"; });
    dom.zoneAudio.addEventListener("dragleave", () => { dom.zoneAudio.style.borderColor = ""; });
    dom.zoneAudio.addEventListener("drop", (e) => {
      e.preventDefault(); dom.zoneAudio.style.borderColor = "";
      if (e.dataTransfer.files[0]) handleAudioFile(e.dataTransfer.files[0]);
    });
    dom.inputAudio.addEventListener("change", (e) => { if (e.target.files[0]) handleAudioFile(e.target.files[0]); });

    dom.zoneCover.addEventListener("click", () => dom.inputCover.click());
    dom.zoneCover.addEventListener("dragover", (e) => { e.preventDefault(); dom.zoneCover.style.borderColor = "var(--neon-cyan)"; });
    dom.zoneCover.addEventListener("dragleave", () => { dom.zoneCover.style.borderColor = ""; });
    dom.zoneCover.addEventListener("drop", (e) => {
      e.preventDefault(); dom.zoneCover.style.borderColor = "";
      if (e.dataTransfer.files[0]) handleCoverFile(e.dataTransfer.files[0]);
    });
    dom.inputCover.addEventListener("change", (e) => { if (e.target.files[0]) handleCoverFile(e.target.files[0]); });
  }

  async function handleAudioFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["ogg", "mp3", "wav", "flac", "m4a", "aac", "wma", "opus", "webm"].includes(ext)) {
      dom.fileStatus.textContent = "Invalid audio format. Use .ogg, .mp3, .wav, .flac, .m4a"; return;
    }
    state.audioFile = file;
    dom.zoneAudio.classList.add("has-file");
    dom.zoneAudio.querySelector(".upload-label").textContent = file.name;

    // Auto-detect song name and artist from filename
    const baseName = file.name.replace(/\.[^.]+$/, ""); // Remove extension
    autoFillMetadata(baseName);

    // Try to read ID3 tags from file binary
    try {
      const tagData = await file.arrayBuffer();
      const id3 = parseID3(new Uint8Array(tagData));
      if (id3.title && !$("#cfg-song-name").dataset.userEdited) {
        $("#cfg-song-name").value = id3.title;
      }
      if (id3.artist && !$("#cfg-song-author").dataset.userEdited) {
        $("#cfg-song-author").value = id3.artist;
      }
    } catch (e) { /* ID3 parsing is best-effort */ }

    updateFileStatus();
    await decodeAudio(file);
  }

  // Parse common filename patterns: "Artist - Title", "Title (Artist)", "01 Title", etc.
  function autoFillMetadata(baseName) {
    const nameEl = $("#cfg-song-name");
    const authorEl = $("#cfg-song-author");

    // Skip if user already typed something
    if (nameEl.value && nameEl.dataset.userEdited) return;

    // Pattern 1: "Artist - Title"
    if (baseName.includes(" - ")) {
      const parts = baseName.split(" - ");
      if (parts.length >= 2) {
        authorEl.value = parts[0].trim();
        nameEl.value = parts.slice(1).join(" - ").trim();
        return;
      }
    }

    // Pattern 2: "Artist — Title" (em dash)
    if (baseName.includes(" \u2014 ")) {
      const parts = baseName.split(" \u2014 ");
      if (parts.length >= 2) {
        authorEl.value = parts[0].trim();
        nameEl.value = parts.slice(1).join(" \u2014 ").trim();
        return;
      }
    }

    // Pattern 3: Strip leading track numbers "01 Title" or "01. Title"
    const stripped = baseName.replace(/^\d+[\.\s\-_]+/, "").trim();

    // Pattern 4: Underscores/dashes as spaces
    const cleaned = stripped.replace(/[_]/g, " ").replace(/\s+/g, " ").trim();

    nameEl.value = cleaned || baseName;
  }

  // Minimal ID3v1/ID3v2 tag parser — extracts title and artist from MP3 files
  function parseID3(bytes) {
    const result = { title: "", artist: "" };

    // Try ID3v2 (beginning of file)
    if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      // ID3v2 header found
      const version = bytes[3];
      const headerSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      const end = Math.min(10 + headerSize, bytes.length);
      let pos = 10;

      while (pos < end - 10) {
        const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
        const frameSize = version >= 4 ?
          ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) | ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f) :
          (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];

        if (frameSize <= 0 || frameSize > end - pos) break;

        if (frameId === "TIT2" || frameId === "TPE1") {
          // Skip encoding byte, read text
          const encoding = bytes[pos + 10];
          let text = "";
          const start = pos + 11;
          const textEnd = pos + 10 + frameSize;
          if (encoding === 0 || encoding === 3) {
            // ISO-8859-1 or UTF-8
            for (let i = start; i < textEnd && i < bytes.length; i++) {
              if (bytes[i] === 0) break;
              text += String.fromCharCode(bytes[i]);
            }
          } else if (encoding === 1) {
            // UTF-16 with BOM
            const bom = (bytes[start] << 8) | bytes[start + 1];
            const le = bom === 0xFFFE;
            for (let i = start + 2; i < textEnd - 1 && i < bytes.length - 1; i += 2) {
              const code = le ? (bytes[i + 1] << 8) | bytes[i] : (bytes[i] << 8) | bytes[i + 1];
              if (code === 0) break;
              text += String.fromCharCode(code);
            }
          }

          if (frameId === "TIT2") result.title = text.trim();
          if (frameId === "TPE1") result.artist = text.trim();
        }

        pos += 10 + frameSize;
      }
    }

    // Try ID3v1 (last 128 bytes)
    if (bytes.length > 128) {
      const tagStart = bytes.length - 128;
      if (bytes[tagStart] === 0x54 && bytes[tagStart + 1] === 0x41 && bytes[tagStart + 2] === 0x47) {
        // "TAG" found
        if (!result.title) {
          result.title = readID3v1String(bytes, tagStart + 3, 30);
        }
        if (!result.artist) {
          result.artist = readID3v1String(bytes, tagStart + 33, 30);
        }
      }
    }

    return result;
  }

  function readID3v1String(bytes, offset, len) {
    let str = "";
    for (let i = 0; i < len; i++) {
      const b = bytes[offset + i];
      if (b === 0) break;
      str += String.fromCharCode(b);
    }
    return str.trim();
  }

  function handleCoverFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "tiff", "tif"].includes(ext)) {
      dom.fileStatus.textContent = "Invalid image. Use .jpg, .png, .webp, .gif, or .bmp"; return;
    }
    state.coverFile = file;

    // Immediately read + convert to JPEG via canvas — this prevents stale File reference issues
    // and ensures Beat Saber gets a valid JPEG regardless of input format
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        // Create a square canvas (Beat Saber requires square cover)
        const size = Math.min(Math.max(img.width, img.height), 512);
        const cvs = document.createElement("canvas");
        cvs.width = size; cvs.height = size;
        const ctx = cvs.getContext("2d");
        // Center-crop to square
        const srcSize = Math.min(img.width, img.height);
        const sx = (img.width - srcSize) / 2;
        const sy = (img.height - srcSize) / 2;
        ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
        // Store as JPEG blob
        cvs.toBlob(function(blob) {
          state.coverBlob = blob;
          state.coverReady = true;
          dom.zoneCover.classList.add("has-file");
          dom.zoneCover.querySelector(".upload-label").textContent = file.name + " (converted)";
          updateFileStatus();
        }, "image/jpeg", 0.92);
      };
      img.onerror = function() {
        dom.fileStatus.textContent = "Failed to load image. Try a different file.";
      };
      img.src = e.target.result;
    };
    reader.onerror = function() {
      dom.fileStatus.textContent = "Failed to read image file.";
    };
    reader.readAsDataURL(file);
  }

  function updateFileStatus() {
    const parts = [];
    if (state.audioFile) parts.push("Audio: " + state.audioFile.name);
    if (state.coverFile) parts.push("Cover: " + state.coverFile.name);
    dom.fileStatus.textContent = parts.join(" \u00B7 ");
    dom.btnGenerate.disabled = !(state.audioFile && state.audioBuffer);
  }

  // ============================================================
  // SECTION C — AUDIO ANALYSIS ENGINE (SPECTRAL BANDS)
  // ============================================================

  async function decodeAudio(file) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    state.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    state.audioDuration = state.audioBuffer.duration;
    state.audioCtx = ctx;
    analyzeAudio(ctx);
    updateFileStatus();
  }

  function analyzeAudio(ctx) {
    const buffer = state.audioBuffer;
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);
    const fftSize = 2048;
    const hopSize = fftSize / 2;

    // Energy curve (windowed RMS)
    const windowSize = Math.floor(sampleRate * 0.02);
    const energyHop = Math.floor(windowSize / 2);
    const energyCurve = [];
    for (let i = 0; i < channelData.length - windowSize; i += energyHop) {
      let sum = 0;
      for (let j = 0; j < windowSize; j++) sum += channelData[i + j] ** 2;
      energyCurve.push(Math.sqrt(sum / windowSize));
    }
    state.energyCurve = energyCurve;

    // Spectral band analysis using FFT
    const subBassCurve = [], bassCurve = [], midCurve = [], highCurve = [];
    const centroidCurve = []; // Spectral centroid for brightness tracking
    const subBassMax = Math.floor(80 * fftSize / sampleRate);   // 0-80 Hz (kick/sub)
    const bassMax = Math.floor(250 * fftSize / sampleRate);     // 80-250 Hz (bass)
    const midMax  = Math.floor(4000 * fftSize / sampleRate);    // 250-4000 Hz (mid)

    for (let start = 0; start < channelData.length - fftSize; start += hopSize) {
      const re = new Float32Array(fftSize);
      const im = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        re[i] = channelData[start + i] * (0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize)));
      }
      fftInPlace(re, im, fftSize);

      let subBassE = 0, bassE = 0, midE = 0, highE = 0;
      let centroidNum = 0, centroidDen = 0;
      for (let k = 1; k < fftSize / 2; k++) {
        const mag = Math.sqrt(re[k] ** 2 + im[k] ** 2);
        centroidNum += k * mag;
        centroidDen += mag;
        if (k <= subBassMax) subBassE += mag;
        else if (k <= bassMax) bassE += mag;
        else if (k <= midMax) midE += mag;
        else highE += mag;
      }
      subBassCurve.push(subBassE / Math.max(1, subBassMax));
      bassCurve.push(bassE / Math.max(1, bassMax - subBassMax));
      midCurve.push(midE / Math.max(1, midMax - bassMax));
      highCurve.push(highE / Math.max(1, fftSize / 2 - midMax));
      centroidCurve.push(centroidDen > 0 ? centroidNum / centroidDen : 0);
    }

    state.subBassCurve = subBassCurve;

    state.bassCurve = bassCurve;
    state.midCurve = midCurve;
    state.highCurve = highCurve;
    state.centroidCurve = centroidCurve;

    // Spectral flux
    const flux = [];
    for (let i = 1; i < energyCurve.length; i++) flux.push(Math.max(0, energyCurve[i] - energyCurve[i - 1]));
    state.spectralFlux = flux;

    // Onset detection
    state.onsets = detectOnsets(flux, energyHop, sampleRate);

    // BPM detection — 4-method weighted voting
    if (!$("#cfg-bpm").value) {
      state.bpm = detectBPM(state.onsets, state.audioDuration);
      state.bpm = Math.max(60, Math.min(200, state.bpm || 120));
      $("#cfg-bpm").value = state.bpm;
      // Show all 5 methods + confidence
      const eBPM = detectBPMFromEnergy();
      const bBPM = detectBPMFromBass();
      const oBPM = detectBPMFromOnsets(state.onsets);
      const tBPM = detectBPMBeatTrack(state.onsets);
      const fBPM = detectBPMFromFlux();
      const all = [eBPM, bBPM, oBPM, tBPM, fBPM].filter(b => b >= 60 && b <= 200);
      // Count how many agree within ±3
      let agreements = 0;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          if (Math.abs(all[i] - all[j]) <= 3) agreements++;
        }
      }
      const confLevel = agreements >= 4 ? "HIGH" : agreements >= 2 ? "MED" : "LOW";
      const confColor = confLevel === "HIGH" ? "#40e080" : confLevel === "MED" ? "#f0a030" : "#ff3898";
      const bpmInfoEl = $("#bpm-info");
      if (bpmInfoEl) {
        const parts = [];
        if (eBPM > 0) parts.push("Energy:" + eBPM);
        if (bBPM > 0) parts.push("Bass:" + bBPM);
        if (oBPM > 0) parts.push("Onset:" + oBPM);
        if (tBPM > 0) parts.push("Grid:" + tBPM);
        if (fBPM > 0) parts.push("Flux:" + fBPM);
        bpmInfoEl.innerHTML = parts.join(" · ") + " → <b>" + state.bpm + "</b> " +
          '<span style="color:' + confColor + ';font-weight:700;">[' + confLevel + ']</span>';
      }
      console.log("BPM — Energy:", eBPM, "Bass:", bBPM, "Onset:", oBPM, "Grid:", tBPM, "Flux:", fBPM, "→", state.bpm, confLevel);
    } else {
      state.bpm = Math.max(60, Math.min(200, parseFloat($("#cfg-bpm").value) || 120));
    }

    // Variable BPM regions
    state.bpmRegions = detectBPMRegions(state.onsets, state.audioDuration, state.bpm);

    // AUDIO FINGERPRINT
    state.audioFingerprint = computeAudioFingerprint();

    // Display BPM region info
    if (state.bpmRegions.length > 1) {
      logGen(0, "pattern", "Variable BPM detected: " + state.bpmRegions.map(r =>
        r.bpm + " BPM (" + r.startTime.toFixed(1) + "s-" + r.endTime.toFixed(1) + "s)"
      ).join(", "));

      // Show BPM regions below BPM info
      const bpmInfoEl = $("#bpm-info");
      if (bpmInfoEl) {
        bpmInfoEl.innerHTML += '<br><span style="font-size:0.65rem;color:#f0a030;">BPM Changes: ' +
          state.bpmRegions.map(r => '<span style="color:#00e5ff">' + r.bpm + '</span> (' +
            r.startTime.toFixed(0) + 's-' + r.endTime.toFixed(0) + 's)'
          ).join(' → ') + '</span>';
      }
    }

    // Phrases & sections
    state.phrases = detectPhrases(energyCurve, energyHop, sampleRate);
    state.sections = detectSections(bassCurve, midCurve, highCurve, hopSize, sampleRate, state.audioDuration);

    // Cache ALL max values for performance
    const maxSubBass = subBassCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    const maxBass = bassCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    const maxMid  = midCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    const maxHigh = highCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    const maxEnergy = energyCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    const maxCentroid = centroidCurve.reduce((a, b) => Math.max(a, b), 0) || 1;
    state.maxSubBass = maxSubBass;
    state.maxBass = maxBass;
    state.maxMid = maxMid;
    state.maxHigh = maxHigh;
    state.maxEnergy = maxEnergy;
    state.maxCentroid = maxCentroid;
    const avgBass = bassCurve.reduce((a, b) => a + b, 0) / bassCurve.length;
    const avgMid  = midCurve.reduce((a, b) => a + b, 0) / midCurve.length;
    const avgHigh = highCurve.reduce((a, b) => a + b, 0) / highCurve.length;
    const bandMax = Math.max(avgBass, avgMid, avgHigh) || 1;
    dom.bandBass.style.width = ((avgBass / bandMax) * 100) + "%";
    dom.bandMid.style.width = ((avgMid / bandMax) * 100) + "%";
    dom.bandHigh.style.width = ((avgHigh / bandMax) * 100) + "%";

    drawWaveform();
    drawSectionTimeline();
    drawEnergyCurve();
  }

  function fftInPlace(re, im, n) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const angle = -2 * Math.PI / len;
      const wRe = Math.cos(angle), wIm = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < halfLen; j++) {
          const a = i + j, b = a + halfLen;
          const tRe = curRe * re[b] - curIm * im[b];
          const tIm = curRe * im[b] + curIm * re[b];
          re[b] = re[a] - tRe; im[b] = im[a] - tIm;
          re[a] += tRe; im[a] += tIm;
          const newCurRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe; curRe = newCurRe;
        }
      }
    }
  }

  function detectOnsets(flux, hopSize, sampleRate) {
    const onsets = [];
    const wl = Math.min(25, Math.max(8, Math.floor(flux.length / 200)));
    const mul = 1.3; // Lower multiplier = more onsets detected (was 1.5)
    const minGap = 0.04; // 40ms minimum gap between onsets (was 50ms)

    for (let i = wl; i < flux.length - wl; i++) {
      let mean = 0;
      for (let j = i - wl; j < i + wl; j++) mean += flux[j];
      mean /= (wl * 2);

      const threshold = Math.max(0.001, mean * mul); // Lower floor (was 0.002)
      if (flux[i] > threshold && flux[i] >= flux[Math.max(0, i - 1)] && flux[i] >= flux[Math.min(flux.length - 1, i + 1)]) {
        const t = (i * hopSize) / sampleRate;
        if (onsets.length === 0 || t - onsets[onsets.length - 1] > minGap) {
          onsets.push(t);
        }
      }
    }

    // If very few onsets, retry with even lower threshold
    if (onsets.length < 30 && flux.length > 100) {
      onsets.length = 0;
      for (let i = wl; i < flux.length - wl; i++) {
        let mean = 0;
        for (let j = i - wl; j < i + wl; j++) mean += flux[j];
        mean /= (wl * 2);
        if (flux[i] > mean * 1.1 && flux[i] > 0.0005) {
          const t = (i * hopSize) / sampleRate;
          if (onsets.length === 0 || t - onsets[onsets.length - 1] > 0.06) onsets.push(t);
        }
      }
    }

    console.log("[BeatForge] Detected " + onsets.length + " onsets in " + (flux.length * hopSize / sampleRate).toFixed(1) + "s");
    return onsets;
  }

  function detectBPM(onsets, duration) {
    const energyBPM = detectBPMFromEnergy();
    const onsetBPM = detectBPMFromOnsets(onsets);
    const bassBPM = detectBPMFromBass();
    const beatTrackBPM = detectBPMBeatTrack(onsets);
    const fluxBPM = detectBPMFromFlux();

    // All candidates with confidence scores
    const results = [
      { bpm: energyBPM, conf: 3, name: "energy" },
      { bpm: bassBPM, conf: 2, name: "bass" },
      { bpm: onsetBPM, conf: 2, name: "onset" },
      { bpm: beatTrackBPM, conf: 1, name: "beattrack" },
      { bpm: fluxBPM, conf: 3, name: "flux" },
    ].filter(r => r.bpm >= 60 && r.bpm <= 200);

    if (results.length === 0) return 120;

    // Show all results in BPM info
    const bpmInfo = $("#bpm-info");
    if (bpmInfo) {
      bpmInfo.textContent = results.map(r => r.name + ": " + r.bpm).join(" | ");
    }

    // Find agreement — pairs within ±3 BPM, weighted by confidence
    let bestPair = null, bestConf = 0;
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        if (Math.abs(results[i].bpm - results[j].bpm) <= 3) {
          const conf = results[i].conf + results[j].conf;
          if (conf > bestConf) {
            bestConf = conf;
            bestPair = Math.round((results[i].bpm * results[i].conf + results[j].bpm * results[j].conf) / conf);
          }
        }
        // Half/double time agreement
        if (Math.abs(results[i].bpm - results[j].bpm * 2) <= 4) {
          const conf = results[i].conf + results[j].conf * 0.5;
          if (conf > bestConf) { bestConf = conf; bestPair = results[i].bpm; }
        }
        if (Math.abs(results[i].bpm * 2 - results[j].bpm) <= 4) {
          const conf = results[i].conf * 0.5 + results[j].conf;
          if (conf > bestConf) { bestConf = conf; bestPair = results[j].bpm; }
        }
      }
    }

    if (bestPair) return Math.max(60, Math.min(200, bestPair));

    // No agreement — prefer highest confidence in common range
    results.sort((a, b) => {
      const aRange = (a.bpm >= 85 && a.bpm <= 165) ? 2 : (a.bpm >= 65 && a.bpm <= 190) ? 1 : 0;
      const bRange = (b.bpm >= 85 && b.bpm <= 165) ? 2 : (b.bpm >= 65 && b.bpm <= 190) ? 1 : 0;
      return (bRange + b.conf) - (aRange + a.conf);
    });
    return Math.max(60, Math.min(200, results[0].bpm));
  }

  // Energy autocorrelation with MULTI-PEAK analysis and harmonic sifting
  function detectBPMFromEnergy() {
    const curve = state.energyCurve;
    if (!curve || curve.length < 200) return 0;

    const max = Math.max(...curve);
    if (max < 0.001) return 0;
    const norm = curve.map(v => v / max);
    const sr = curve.length / state.audioDuration;
    const minLag = Math.floor(sr * 60 / 200);
    const maxLag = Math.floor(sr * 60 / 60);
    const len = norm.length;

    // Compute full autocorrelation
    const corrs = [];
    for (let lag = minLag; lag <= Math.min(maxLag, len / 2); lag++) {
      let corr = 0, count = 0;
      for (let i = 0; i < len - lag; i++) { corr += norm[i] * norm[i + lag]; count++; }
      corrs.push({ lag, corr: corr / count, bpm: Math.round((sr * 60) / lag) });
    }

    if (corrs.length === 0) return 0;

    // Find top 5 peaks (local maxima)
    const peaks = [];
    for (let i = 1; i < corrs.length - 1; i++) {
      if (corrs[i].corr > corrs[i - 1].corr && corrs[i].corr > corrs[i + 1].corr) {
        peaks.push(corrs[i]);
      }
    }
    peaks.sort((a, b) => b.corr - a.corr);
    const topPeaks = peaks.slice(0, 5);

    if (topPeaks.length === 0) return 0;

    // Harmonic sifting: if the top peak is at half the BPM of another strong peak,
    // the faster BPM is likely correct (we're detecting the period, not the beat)
    let bestBPM = topPeaks[0].bpm;
    for (let i = 1; i < topPeaks.length; i++) {
      const ratio = topPeaks[i].bpm / topPeaks[0].bpm;
      // If another peak is at ~2x BPM with decent correlation, prefer it
      if (Math.abs(ratio - 2) < 0.15 && topPeaks[i].corr > topPeaks[0].corr * 0.6) {
        bestBPM = topPeaks[i].bpm;
        break;
      }
    }

    // Range preference
    if (bestBPM >= 85 && bestBPM <= 165) return bestBPM;
    // Check if double/half is in better range
    if (bestBPM < 85 && bestBPM * 2 <= 200) return bestBPM * 2;
    if (bestBPM > 165 && Math.round(bestBPM / 2) >= 60) return Math.round(bestBPM / 2);
    return bestBPM;
  }

  // Bass autocorrelation — great for kick drum detection in EDM
  function detectBPMFromBass() {
    const curve = state.bassCurve;
    if (!curve || curve.length < 200) return 0;

    const max = state.maxBass || Math.max(...curve);
    if (max < 0.001) return 0;
    const norm = curve.map(v => v / max);

    // Onset-style peak detection on bass — find bass drum hits
    const peaks = [];
    for (let i = 2; i < norm.length - 2; i++) {
      if (norm[i] > 0.3 && norm[i] > norm[i - 1] && norm[i] > norm[i + 1] &&
          norm[i] > norm[i - 2] && norm[i] > norm[i + 2]) {
        const t = (i / norm.length) * state.audioDuration;
        if (peaks.length === 0 || t - peaks[peaks.length - 1] > 0.15) {
          peaks.push(t);
        }
      }
    }

    if (peaks.length < 8) return 0;

    // IOI histogram on bass peaks
    const bpmVotes = {};
    for (let i = 1; i < peaks.length; i++) {
      const iv = peaks[i] - peaks[i - 1];
      if (iv < 0.2 || iv > 2.0) continue;
      let b = Math.round(60 / iv);
      while (b < 60) b *= 2;
      while (b > 200) b = Math.round(b / 2);
      bpmVotes[b] = (bpmVotes[b] || 0) + 1;
      // Neighbors get partial votes
      bpmVotes[b - 1] = (bpmVotes[b - 1] || 0) + 0.5;
      bpmVotes[b + 1] = (bpmVotes[b + 1] || 0) + 0.5;
    }

    let bestBPM = 0, bestCount = 0;
    for (const [b, c] of Object.entries(bpmVotes)) {
      if (c > bestCount) { bestCount = c; bestBPM = parseInt(b); }
    }
    return bestBPM;
  }

  // Onset interval histogram — secondary confirmation method
  function detectBPMFromOnsets(onsets) {
    if (onsets.length < 8) return 0;

    // Kernel density estimation over onset intervals
    const intervals = [];
    for (let i = 1; i < onsets.length; i++) {
      const iv = onsets[i] - onsets[i - 1];
      if (iv >= 0.15 && iv <= 2.5) intervals.push(iv);
    }
    if (intervals.length < 4) return 0;

    // Also include intervals between every-other onset (to catch half-time)
    for (let i = 2; i < onsets.length; i++) {
      const iv = (onsets[i] - onsets[i - 2]) / 2;
      if (iv >= 0.15 && iv <= 2.5) intervals.push(iv);
    }

    // Build BPM histogram with ±1 BPM smoothing
    const bpmCounts = {};
    for (const iv of intervals) {
      let bpm = Math.round(60 / iv);
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm = Math.round(bpm / 2);
      for (let offset = -1; offset <= 1; offset++) {
        const k = bpm + offset;
        bpmCounts[k] = (bpmCounts[k] || 0) + (offset === 0 ? 1.0 : 0.3);
      }
    }

    // Find peak with ±2 smoothing
    let bestBPM = 0, bestCount = 0;
    for (const [b, c] of Object.entries(bpmCounts)) {
      const bi = parseInt(b);
      if (bi < 60 || bi > 200) continue;
      const smoothed = (bpmCounts[bi - 2] || 0) * 0.2 + (bpmCounts[bi - 1] || 0) * 0.6 + c +
                       (bpmCounts[bi + 1] || 0) * 0.6 + (bpmCounts[bi + 2] || 0) * 0.2;
      if (smoothed > bestCount) { bestCount = smoothed; bestBPM = bi; }
    }
    return bestBPM;
  }

  // Beat-tracking: find the most regular grid that aligns with onsets
  function detectBPMBeatTrack(onsets) {
    if (!onsets || onsets.length < 10) return 0;

    let bestBPM = 0, bestScore = 0;

    // Test BPMs from 70 to 180 in 0.5 steps
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const beatPeriod = 60 / bpm;
      let score = 0;

      for (const onset of onsets) {
        const beatPos = onset / beatPeriod;
        const dist = Math.abs(beatPos - Math.round(beatPos));
        if (dist * beatPeriod < 0.05) score += 1.0;
        else if (dist * beatPeriod < 0.1) score += 0.5;
      }

      const totalBeats = state.audioDuration / beatPeriod;
      score /= Math.sqrt(totalBeats);

      if (score > bestScore) { bestScore = score; bestBPM = Math.round(bpm); }
    }

    while (bestBPM < 60) bestBPM *= 2;
    while (bestBPM > 200) bestBPM = Math.round(bestBPM / 2);
    return bestBPM;
  }

  // 5th method: Spectral flux peak detection (FFmpeg-like tempo analysis)
  // Detects sharp energy transients in the bass band and measures regularity
  function detectBPMFromFlux() {
    if (!state.bassCurve || state.bassCurve.length < 200) return 0;

    const curve = state.bassCurve;
    const maxB = Math.max(...curve) || 1;
    const norm = curve.map(v => v / maxB);

    // Compute spectral flux (positive difference between consecutive frames)
    const flux = [];
    for (let i = 1; i < norm.length; i++) {
      const diff = norm[i] - norm[i - 1];
      flux.push(diff > 0 ? diff : 0); // Only positive flux (onsets, not offsets)
    }

    // Find peaks in flux (transient attacks — kick drums, snare hits)
    const peakThreshold = 0.05;
    const minPeakDist = 3; // Minimum frames between peaks
    const peaks = [];
    for (let i = 2; i < flux.length - 2; i++) {
      if (flux[i] > peakThreshold && flux[i] > flux[i - 1] && flux[i] > flux[i + 1] &&
          flux[i] > flux[i - 2] && flux[i] > flux[i + 2]) {
        if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minPeakDist) {
          peaks.push(i);
        }
      }
    }

    if (peaks.length < 8) return 0;

    // Convert peak positions to times
    const sr = curve.length / state.audioDuration;
    const peakTimes = peaks.map(p => p / sr);

    // Build interval histogram (like FFmpeg's beat detection)
    const bpmVotes = {};
    for (let i = 1; i < peakTimes.length; i++) {
      const iv = peakTimes[i] - peakTimes[i - 1];
      if (iv < 0.15 || iv > 2.0) continue;
      let bpm = Math.round(60 / iv);
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm = Math.round(bpm / 2);
      bpmVotes[bpm] = (bpmVotes[bpm] || 0) + 1;
      bpmVotes[bpm - 1] = (bpmVotes[bpm - 1] || 0) + 0.3;
      bpmVotes[bpm + 1] = (bpmVotes[bpm + 1] || 0) + 0.3;
    }

    // Also check every-other-peak intervals
    for (let i = 2; i < peakTimes.length; i++) {
      const iv = (peakTimes[i] - peakTimes[i - 2]) / 2;
      if (iv < 0.15 || iv > 2.0) continue;
      let bpm = Math.round(60 / iv);
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm = Math.round(bpm / 2);
      bpmVotes[bpm] = (bpmVotes[bpm] || 0) + 0.5;
    }

    let bestBPM = 0, bestScore = 0;
    for (const [b, score] of Object.entries(bpmVotes)) {
      const bi = parseInt(b);
      if (bi < 60 || bi > 200) continue;
      const smoothed = (bpmVotes[bi - 2] || 0) * 0.2 + (bpmVotes[bi - 1] || 0) * 0.5 + score +
                       (bpmVotes[bi + 1] || 0) * 0.5 + (bpmVotes[bi + 2] || 0) * 0.2;
      if (smoothed > bestScore) { bestScore = smoothed; bestBPM = bi; }
    }

    return bestBPM;
  }

  // ============================================================
  // VARIABLE BPM DETECTION
  // Uses windowed autocorrelation + energy weighting to detect tempo changes
  // Also detects half-time/double-time sections (common in EDM, metal, etc.)
  // ============================================================

  function detectBPMRegions(onsets, duration, primaryBPM) {
    const regions = [];
    if (onsets.length < 8 || duration < 8) {
      regions.push({ startTime: 0, endTime: duration, bpm: primaryBPM });
      return regions;
    }

    const windowSize = 6;  // 6-second windows (tighter for better resolution)
    const hopSize = 3;     // 3-second hop
    const windowBPMs = [];

    for (let start = 0; start < duration - windowSize / 2; start += hopSize) {
      const end = Math.min(start + windowSize, duration);
      const windowOnsets = onsets.filter(t => t >= start && t < end);
      if (windowOnsets.length < 4) {
        windowBPMs.push({ time: start + (end - start) / 2, bpm: primaryBPM, conf: 0 });
        continue;
      }

      // Method 1: IOI histogram
      const intervals = [];
      for (let i = 1; i < windowOnsets.length; i++) {
        const iv = windowOnsets[i] - windowOnsets[i - 1];
        if (iv >= 0.12 && iv <= 3.0) intervals.push(iv);
      }
      // Also add every-other-onset intervals (catches half-time)
      for (let i = 2; i < windowOnsets.length; i++) {
        const iv = (windowOnsets[i] - windowOnsets[i - 2]) / 2;
        if (iv >= 0.12 && iv <= 3.0) intervals.push(iv);
      }

      const bpmVotes = {};
      for (const iv of intervals) {
        let b = Math.round(60 / iv);
        while (b < 50) b *= 2;
        while (b > 220) b = Math.round(b / 2);
        for (let off = -1; off <= 1; off++) {
          bpmVotes[b + off] = (bpmVotes[b + off] || 0) + (off === 0 ? 1.0 : 0.3);
        }
      }

      // Method 2: Energy-weighted autocorrelation for this window
      const windowEnergy = [];
      if (state.energyCurve && state.energyCurve.length > 0) {
        const ecSR = state.energyCurve.length / duration;
        for (let t = start; t < end; t += 0.02) {
          const idx = Math.floor(t * ecSR);
          windowEnergy.push(idx < state.energyCurve.length ? state.energyCurve[idx] : 0);
        }
      }

      if (windowEnergy.length > 50) {
        const maxE = Math.max(...windowEnergy) || 1;
        const norm = windowEnergy.map(v => v / maxE);
        const sr = windowEnergy.length / (end - start);

        for (let testBPM = 60; testBPM <= 200; testBPM += 1) {
          const lag = Math.round(sr * 60 / testBPM);
          if (lag <= 0 || lag >= norm.length / 2) continue;
          let corr = 0, count = 0;
          for (let j = 0; j < norm.length - lag; j++) { corr += norm[j] * norm[j + lag]; count++; }
          corr /= count || 1;
          bpmVotes[testBPM] = (bpmVotes[testBPM] || 0) + corr * 3; // Weight energy autocorrelation
        }
      }

      // Find peak
      let localBPM = primaryBPM, bestScore = 0;
      for (const [bStr, score] of Object.entries(bpmVotes)) {
        const b = parseInt(bStr);
        if (b < 50 || b > 220) continue;
        const smoothed = (bpmVotes[b - 2] || 0) * 0.2 + (bpmVotes[b - 1] || 0) * 0.5 + score +
                         (bpmVotes[b + 1] || 0) * 0.5 + (bpmVotes[b + 2] || 0) * 0.2;
        // Prefer BPMs near primary (±5%) for stability
        const proximityBonus = Math.abs(b - primaryBPM) <= primaryBPM * 0.05 ? 1.2 : 1.0;
        if (smoothed * proximityBonus > bestScore) { bestScore = smoothed * proximityBonus; localBPM = b; }
      }

      // Confidence check
      const conf = bestScore / Math.max(1, intervals.length);
      if (conf < 0.3) localBPM = primaryBPM;

      // Half/double time detection
      const ratio = localBPM / primaryBPM;
      let halfDouble = "";
      if (Math.abs(ratio - 0.5) < 0.08) halfDouble = "half-time";
      else if (Math.abs(ratio - 2.0) < 0.15) halfDouble = "double-time";

      windowBPMs.push({ time: start + (end - start) / 2, bpm: Math.round(localBPM), conf, halfDouble });
    }

    if (windowBPMs.length === 0) {
      regions.push({ startTime: 0, endTime: duration, bpm: primaryBPM });
      return regions;
    }

    // Merge consecutive windows with same BPM (within ±3 tolerance)
    let currentBPM = windowBPMs[0].bpm;
    let regionStart = 0;

    for (let i = 1; i < windowBPMs.length; i++) {
      if (Math.abs(windowBPMs[i].bpm - currentBPM) > 3) {
        regions.push({ startTime: regionStart, endTime: windowBPMs[i].time - hopSize / 2, bpm: currentBPM });
        regionStart = windowBPMs[i].time - hopSize / 2;
        currentBPM = windowBPMs[i].bpm;
      }
    }
    regions.push({ startTime: regionStart, endTime: duration, bpm: currentBPM });

    // Filter tiny regions (< 2s) — merge into neighbors
    const merged = [];
    for (const r of regions) {
      if (r.endTime - r.startTime < 2 && merged.length > 0) {
        merged[merged.length - 1].endTime = r.endTime;
      } else {
        merged.push({ ...r });
      }
    }

    // Log BPM changes
    if (merged.length > 1) {
      console.log("[BeatForge] Variable BPM detected:", merged.map(r =>
        r.bpm + " BPM (" + r.startTime.toFixed(1) + "s-" + r.endTime.toFixed(1) + "s)"
      ).join(", "));

      // Check for half/double time sections
      for (const wb of windowBPMs) {
        if (wb.halfDouble) {
          console.log("[BeatForge] " + wb.halfDouble + " section at " + wb.time.toFixed(1) + "s (" + wb.bpm + " BPM)");
        }
      }
    }

    return merged.length > 0 ? merged : [{ startTime: 0, endTime: duration, bpm: primaryBPM }];
  }

  // Get the BPM at a specific time position
  function getBPMAtTime(t) {
    if (state.bpmRegions.length === 0) return state.bpm;
    for (const r of state.bpmRegions) {
      if (t >= r.startTime && t < r.endTime) return r.bpm;
    }
    return state.bpm; // Fallback
  }

  // Convert beat to time accounting for variable BPM regions
  function beatToTimeVBPM(beat) {
    if (state.bpmRegions.length <= 1) return beatToTime(beat, state.bpm);

    let time = 0;
    let remainingBeats = beat;
    for (const r of state.bpmRegions) {
      const regionDuration = r.endTime - r.startTime;
      const regionBeats = (regionDuration * r.bpm) / 60;
      if (remainingBeats <= regionBeats) {
        return time + (remainingBeats / r.bpm) * 60;
      }
      remainingBeats -= regionBeats;
      time += regionDuration;
    }
    // Past end — use last region's BPM
    const lastBPM = state.bpmRegions[state.bpmRegions.length - 1].bpm;
    return time + (remainingBeats / lastBPM) * 60;
  }

  // Convert time to beat accounting for variable BPM regions
  function timeToBeatVBPM(t) {
    if (state.bpmRegions.length <= 1) return timeToBeat(t, state.bpm);

    let beat = 0;
    let remainingTime = t;
    for (const r of state.bpmRegions) {
      const regionDuration = r.endTime - r.startTime;
      if (remainingTime <= regionDuration) {
        return beat + (remainingTime * r.bpm) / 60;
      }
      remainingTime -= regionDuration;
      beat += (regionDuration * r.bpm) / 60;
    }
    const lastBPM = state.bpmRegions[state.bpmRegions.length - 1].bpm;
    return beat + (remainingTime * lastBPM) / 60;
  }

  function detectPhrases(energyCurve, hopSize, sampleRate) {
    const smoothLen = Math.floor(2 * sampleRate / hopSize);
    const smoothed = [];
    for (let i = 0; i < energyCurve.length; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - smoothLen); j < Math.min(energyCurve.length, i + smoothLen); j++) { sum += energyCurve[j]; cnt++; }
      smoothed.push(sum / cnt);
    }
    const phrases = [];
    const minGap = 4 * sampleRate / hopSize;
    let last = -minGap;
    for (let i = smoothLen; i < smoothed.length - smoothLen; i++) {
      const prev = smoothed[i - smoothLen], curr = smoothed[i];
      const ratio = prev > 0.001 ? Math.abs(curr - prev) / prev : 0;
      if (ratio > 0.4 && (i - last) > minGap) {
        phrases.push({ time: (i * hopSize) / sampleRate, type: curr > prev ? "rise" : "drop", energy: curr });
        last = i;
      }
    }
    return phrases;
  }

  function detectSections(bassCurve, midCurve, highCurve, hopSize, sampleRate, duration) {
    if (bassCurve.length === 0) return [{ type: SEC.VERSE, startTime: 0, endTime: duration }];
    const windowSamples = Math.floor(4 * sampleRate / hopSize);
    const segments = [];
    const len = Math.min(bassCurve.length, midCurve.length, highCurve.length);
    for (let i = 0; i < len; i += windowSamples) {
      const end = Math.min(i + windowSamples, len);
      let bS = 0, mS = 0, hS = 0, cnt = 0;
      for (let j = i; j < end; j++) { bS += bassCurve[j]; mS += midCurve[j]; hS += highCurve[j]; cnt++; }
      segments.push({ startTime: (i * hopSize) / sampleRate, endTime: (end * hopSize) / sampleRate, bass: bS / cnt, mid: mS / cnt, high: hS / cnt, totalEnergy: (bS + mS + hS) / cnt });
    }
    if (segments.length === 0) return [{ type: SEC.VERSE, startTime: 0, endTime: duration }];

    const energies = segments.map(s => s.totalEnergy);
    const maxE = Math.max(...energies) || 1;

    const sections = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const normE = seg.totalEnergy / maxE;
      const normBass = seg.bass / (maxE / 3 || 1);
      const nextE = i < segments.length - 1 ? segments[i + 1].totalEnergy / maxE : normE;
      let type;
      if (i === 0 && normE < 0.4) type = SEC.INTRO;
      else if (i >= segments.length - 2 && normE < 0.4) type = SEC.OUTRO;
      else if (normE < 0.25) type = SEC.BREAK;
      else if (normE < 0.45 && nextE > normE * 1.5) type = SEC.BUILDUP;
      else if (normE > 0.75 && normBass > 0.6) type = SEC.DROP;
      else if (normE > 0.55) type = SEC.CHORUS;
      else type = SEC.VERSE;
      sections.push({ type, startTime: seg.startTime, endTime: seg.endTime, energy: normE, bass: normBass });
    }

    const merged = [sections[0]];
    for (let i = 1; i < sections.length; i++) {
      const last = merged[merged.length - 1];
      if (sections[i].type === last.type) { last.endTime = sections[i].endTime; last.energy = Math.max(last.energy, sections[i].energy); }
      else merged.push({ ...sections[i] });
    }
    return merged;
  }

  function getSectionAt(timeSec) {
    for (const sec of state.sections) { if (timeSec >= sec.startTime && timeSec < sec.endTime) return sec; }
    return state.sections[state.sections.length - 1] || { type: SEC.VERSE, energy: 0.5 };
  }

  function getNormBassAt(timeSec) {
    if (state.bassCurve.length === 0) return 0.5;
    const idx = Math.floor(timeSec * (state.audioBuffer ? state.audioBuffer.sampleRate : 44100) / 1024);
    return (state.bassCurve[Math.min(idx, state.bassCurve.length - 1)] || 0) / (state.maxBass || 1);
  }
  function getNormSubBassAt(timeSec) {
    if (!state.subBassCurve || state.subBassCurve.length === 0) return 0.3;
    const idx = Math.floor(timeSec * (state.audioBuffer ? state.audioBuffer.sampleRate : 44100) / 1024);
    return (state.subBassCurve[Math.min(idx, state.subBassCurve.length - 1)] || 0) / (state.maxSubBass || 1);
  }
  function getNormCentroidAt(timeSec) {
    if (!state.centroidCurve || state.centroidCurve.length === 0) return 0.5;
    const idx = Math.floor(timeSec * (state.audioBuffer ? state.audioBuffer.sampleRate : 44100) / 1024);
    return (state.centroidCurve[Math.min(idx, state.centroidCurve.length - 1)] || 0) / (state.maxCentroid || 1);
  }
  function getNormMidAt(timeSec) {
    if (state.midCurve.length === 0) return 0.5;
    const idx = Math.floor(timeSec * (state.audioBuffer ? state.audioBuffer.sampleRate : 44100) / 1024);
    return (state.midCurve[Math.min(idx, state.midCurve.length - 1)] || 0) / (state.maxMid || 1);
  }
  function getNormHighAt(timeSec) {
    if (state.highCurve.length === 0) return 0.5;
    const idx = Math.floor(timeSec * (state.audioBuffer ? state.audioBuffer.sampleRate : 44100) / 1024);
    return (state.highCurve[Math.min(idx, state.highCurve.length - 1)] || 0) / (state.maxHigh || 1);
  }
  function getEnergyAtTime(timeSec) {
    if (state.energyCurve.length === 0) return 0.5;
    const idx = Math.floor((timeSec / state.audioDuration) * state.energyCurve.length);
    return (state.energyCurve[Math.min(idx, state.energyCurve.length - 1)] || 0) / (state.maxEnergy || 1);
  }

  // ============================================================
  // AUDIO PREVIEW PLAYER
  // ============================================================

  function setupAudioPlayer() {
    dom.btnPlay.addEventListener("click", togglePlayback);
    dom.waveformCanvas.addEventListener("click", seekAudio);
  }

  function togglePlayback() {
    if (!state.audioBuffer) return;
    if (state.isPlaying) stopPlayback(); else startPlayback();
  }

  function startPlayback() {
    const ctx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = ctx;
    if (ctx.state === "suspended") ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = state.audioBuffer;
    source.connect(ctx.destination);
    source.start(0, state.playOffset);
    source.onended = () => { if (state.isPlaying) { state.isPlaying = false; state.playOffset = 0; updatePlayUI(); } };
    state.audioSource = source;
    state.playStartTime = ctx.currentTime - state.playOffset;
    state.isPlaying = true;
    updatePlayUI();
    requestAnimationFrame(updatePlayTime);
  }

  function stopPlayback() {
    if (state.audioSource) { state.audioSource.onended = null; try { state.audioSource.stop(); } catch (e) {} }
    state.playOffset = state.audioCtx ? state.audioCtx.currentTime - state.playStartTime : 0;
    state.isPlaying = false;
    updatePlayUI();
  }

  function seekAudio(e) {
    const rect = dom.waveformCanvas.getBoundingClientRect();
    state.playOffset = ((e.clientX - rect.left) / rect.width) * state.audioDuration;
    if (state.isPlaying) { stopPlayback(); startPlayback(); }
    updatePlayTime();
  }

  function updatePlayUI() {
    const ip = $("#icon-play"), ipa = $("#icon-pause");
    if (state.isPlaying) { ip.style.display = "none"; ipa.style.display = ""; } else { ip.style.display = ""; ipa.style.display = "none"; }
  }

  function updatePlayTime() {
    if (!state.audioCtx) return;
    const cur = state.isPlaying ? state.audioCtx.currentTime - state.playStartTime : state.playOffset;
    dom.audioTime.textContent = fmt(cur) + " / " + fmt(state.audioDuration);
    if (state.isPlaying) requestAnimationFrame(updatePlayTime);
  }

  function fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ":" + (s < 10 ? "0" : "") + s; }

  // ============================================================
  // VISUALIZATION
  // ============================================================

  function drawWaveform() {
    dom.panelViz.style.display = "";
    const canvas = dom.waveformCanvas;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const curve = state.energyCurve;
    const maxE = state.maxEnergy || 1;
    const step = curve.length / W;

    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x < W; x++) { const v = (curve[Math.floor(x * step)] || 0) / maxE; ctx.lineTo(x, H - v * H * 0.85); }
    ctx.lineTo(W, H); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "rgba(255,32,64,0.35)");
    grad.addColorStop(0.5, "rgba(255,56,152,0.35)");
    grad.addColorStop(1, "rgba(32,128,255,0.35)");
    ctx.fillStyle = grad; ctx.fill();

    // Bass overlay
    if (state.bassCurve.length > 0) {
      const bStep = state.bassCurve.length / W;
      const bMax = state.maxBass || 1;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x < W; x++) ctx.lineTo(x, H - ((state.bassCurve[Math.floor(x * bStep)] || 0) / bMax) * H * 0.4);
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = "rgba(255,32,64,0.15)"; ctx.fill();
    }

    // Section coloring
    const totalTime = state.audioDuration;
    for (const sec of state.sections) {
      const x1 = (sec.startTime / totalTime) * W, x2 = (sec.endTime / totalTime) * W;
      let col;
      switch (sec.type) { case SEC.DROP: col = "rgba(255,32,64,0.12)"; break; case SEC.CHORUS: col = "rgba(255,56,152,0.10)"; break; case SEC.BUILDUP: col = "rgba(240,160,48,0.10)"; break; case SEC.BREAK: col = "rgba(32,128,255,0.08)"; break; default: col = null; }
      if (col) { ctx.fillStyle = col; ctx.fillRect(x1, 0, x2 - x1, H); }
    }

    // Onset markers
    ctx.strokeStyle = "rgba(0,240,255,0.3)"; ctx.lineWidth = 0.5;
    for (const o of state.onsets) { const x = (o / totalTime) * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

    // Phrase boundaries
    ctx.strokeStyle = "rgba(255,56,152,0.6)"; ctx.lineWidth = 1.5;
    for (const p of state.phrases) { const x = (p.time / totalTime) * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

    const bpmDisplay = state.bpmRegions.length > 1
      ? state.bpmRegions.map(r => r.bpm).filter((v, i, a) => a.indexOf(v) === i).join("/")
      : state.bpm;
    const eBPM = detectBPMFromEnergy();
    const bBPM = detectBPMFromBass();
    const matchCount = [eBPM, bBPM].filter(b => Math.abs(b - state.bpm) <= 3).length;
    const confidence = matchCount >= 2 ? "High" : matchCount >= 1 ? "Med" : "Low";
    const confClass = confidence === "High" ? "vs-good" : confidence === "Med" ? "vs-val" : "vs-warn";
    dom.vizStats.innerHTML =
      '<span>BPM: <span class="vs-val">' + bpmDisplay + '</span>' +
      (state.bpmRegions.length > 1 ? ' <span class="vs-warn">(variable)</span>' : '') +
      ' <span class="' + confClass + '">(' + confidence + ')</span></span>' +
      '<span>Onsets: <span class="vs-val">' + state.onsets.length + '</span></span>' +
      '<span>Phrases: <span class="vs-val">' + state.phrases.length + '</span></span>' +
      '<span>Sections: <span class="vs-val">' + state.sections.length + '</span></span>' +
      '<span>Duration: <span class="vs-val">' + state.audioDuration.toFixed(1) + 's</span></span>';
  }

  // ============================================================
  // SECTION D — PATTERN GENERATION ENGINE
  // ============================================================

  function beatToTime(beat, bpm) { return (beat / bpm) * 60; }
  function timeToBeat(time, bpm) { return (time * bpm) / 60; }
  function quantizeToBeat(time, bpm, sub) { return Math.round(time * (bpm / 60) * sub) / sub; }
  function getSelectedDifficulties() {
    const valid = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];
    const d = [];
    $$(".diff-chips input:checked").forEach(el => {
      if (valid.includes(el.value)) d.push(el.value);
    });
    return d;
  }
  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function pickWeighted(arr) {
    // First items are weighted higher (more comfortable)
    const weights = arr.map((_, i) => arr.length - i);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[0];
  }

  function getUserSettings() {
    // Read lighting style radio
    let lightStyle = "dynamic";
    const lightRadio = document.querySelector('input[name="light-style"]:checked');
    if (lightRadio) lightStyle = lightRadio.value;
    // Read color scheme radio
    let colorPref = "auto";
    const colorRadio = document.querySelector('input[name="color-scheme"]:checked');
    if (colorRadio) colorPref = colorRadio.value;

    return {
      style: ($("#cfg-style") || {}).value || "balanced",
      complexity: parseInt(($("#cfg-complexity") || {}).value || "50"),
      lightIntensity: parseInt(($("#cfg-light-intensity") || {}).value || "70"),
      density: parseInt(($("#cfg-density") || {}).value || "50"),
      njsOverride: parseFloat(($("#cfg-njs") || {}).value || "0"),
      njsOffset: parseFloat(($("#cfg-offset") || {}).value || "0"),
      lightStyle: lightStyle,
      colorPref: colorPref,
    };
  }

  function generateDifficulty(diffName) {
    const us = getUserSettings();
    const settings = getDiffSettings(diffName, state.bpm, us.style, us.complexity, us.density);
    // Apply NJS override if set
    if (us.njsOverride > 0) settings.njs = us.njsOverride;
    settings.njsOffset = us.njsOffset;
    const bpm = Math.max(60, Math.min(200, state.bpm || 120));
    const duration = state.audioDuration;
    const totalBeats = timeToBeat(duration, bpm);

    clearGenLog();
    logGen(0, "pattern", "Starting " + diffName + " \u2014 NPS=" + settings.nps.toFixed(1) + " BPM=" + bpm + " Style=" + us.style);
    logGen(0, "pattern", "ML weights: home=" + mlWeights.preferHomeColumn.toFixed(2) + " range=" + mlWeights.movementRange.toFixed(2) + " gen#" + mlWeights.generationCount);

    // Generate with up to 3 attempts, improving each time
    let bestNotes = null;
    let bestQuality = null;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Reset repetition tracking each attempt
      recentDirs[C.RED] = [];
      recentDirs[C.BLUE] = [];

      const notes = generateNotes(null, bpm, settings, totalBeats);
      const quality = analyzeMapQuality(notes, bpm);

      logGen(0, attempt === 0 ? "pattern" : "warn",
        "Attempt " + (attempt + 1) + ": notes=" + notes.length +
        " parity_v=" + quality.parityViolations +
        " vision=" + quality.visionBlocks +
        " angle_b=" + quality.angleBreaks +
        " comfort=" + quality.comfortScore.toFixed(1));

      if (!bestQuality || quality.comfortScore > bestQuality.comfortScore) {
        bestNotes = notes;
        bestQuality = quality;
      }

      // If quality is good enough, stop
      if (quality.parityViolations === 0 && quality.visionBlocks === 0 &&
          quality.handclaps === 0 && quality.comfortScore >= 7) {
        break;
      }

      // ML learns from this attempt to improve next one
      mlLearn(quality, diffName);
    }

    // Final ML learning from best result
    mlLearn(bestQuality, diffName);

    logGen(totalBeats, "pattern", "Final: " + bestNotes.length + " notes \u2014 Doubles: " + countDoubles(bestNotes) + " \u2014 Comfort: " + bestQuality.comfortScore.toFixed(1));

    // Check element toggles
    const wantArcs = !$("#tog-arcs") || $("#tog-arcs").checked;
    const wantChains = !$("#tog-chains") || $("#tog-chains").checked;
    const wantBombs = !$("#tog-bombs") || $("#tog-bombs").checked;
    const wantWalls = !$("#tog-walls") || $("#tog-walls").checked;

    const arcs = wantArcs ? generateArcs(bestNotes, bpm, settings) : [];
    logGen(totalBeats, "pattern", "Arcs: " + arcs.length + (wantArcs ? "" : " (disabled)"));
    const chains = wantChains ? generateChains(bestNotes, bpm, settings, totalBeats) : [];
    const bombs = wantBombs ? generateBombs(bestNotes, bpm, settings, totalBeats) : [];
    const walls = wantWalls ? generateWalls(bestNotes, bpm, settings, totalBeats) : [];

    // POST-PASS: Fix notes that overlap with walls
    if (walls.length > 0) {
      for (const n of bestNotes) {
        for (const w of walls) {
          // Check if note is inside wall's time span and column
          if (n.b >= w.b - 0.25 && n.b <= w.b + w.d + 0.25) {
            const wallRight = w.x + w.w - 1;
            if (n.x >= w.x && n.x <= wallRight) {
              // Note is behind wall — shift it away
              if (n.c === C.RED) {
                n.x = Math.max(0, w.x - 1);
              } else {
                n.x = Math.min(3, wallRight + 1);
              }
            }
            // Also avoid adjacent column to wall (too close)
            if (n.x === w.x - 1 && w.x > 0 && n.c === C.BLUE) continue; // OK
            if (n.x === wallRight + 1 && wallRight < 3 && n.c === C.RED) continue; // OK
          }
        }
      }
    }
    const lighting = generateLighting(bpm, totalBeats);
    logGen(totalBeats, "pattern", "Lighting events: " + lighting.length);
    if (lighting.length < MIN_LIGHTING_EVENTS) throw new Error("Lighting Missing");
    return { notes: bestNotes, arcs, chains, bombs, walls, lighting, settings };
  }

  // ============================================================
  // BEAT-GRID PATTERN SYSTEM (replaces onset-per-note spam)
  // Walks the beat grid at proper subdivisions, places multi-beat
  // patterns from a vocabulary, leaves breathing room between phrases
  // ============================================================

  // Pattern vocabulary — expanded with denser multi-note patterns
  const PAT = {
    // === SINGLES ===
    singleR:    [{ off: 0, hand: 0 }],
    singleB:    [{ off: 0, hand: 1 }],

    // === 2-NOTE PATTERNS ===
    altRL:      [{ off: 0, hand: 0 }, { off: 1, hand: 1 }],
    altLR:      [{ off: 0, hand: 1 }, { off: 1, hand: 0 }],
    halfAltRL:  [{ off: 0, hand: 0 }, { off: 0.5, hand: 1 }],
    halfAltLR:  [{ off: 0, hand: 1 }, { off: 0.5, hand: 0 }],
    double:     [{ off: 0, hand: -1 }],
    window:     [{ off: 0, hand: -2 }],

    // === 3-NOTE PATTERNS ===
    kickHatSnare: [{ off: 0, hand: 0 }, { off: 0.5, hand: 1 }, { off: 1, hand: 0 }],
    tripleAlt:    [{ off: 0, hand: 0 }, { off: 0.5, hand: 1 }, { off: 1, hand: 0 }],
    doubleFollow: [{ off: 0, hand: -1 }, { off: 1, hand: 0 }],  // double then single
    followDouble: [{ off: 0, hand: 0 }, { off: 1, hand: -1 }],  // single then double

    // === 4-NOTE PATTERNS ===
    stream4:    [
      { off: 0, hand: 0 }, { off: 0.5, hand: 1 },
      { off: 1, hand: 0 }, { off: 1.5, hand: 1 },
    ],
    altDouble4: [
      { off: 0, hand: -1 }, { off: 1, hand: 0 }, { off: 1.5, hand: 1 }, { off: 2, hand: -1 },
    ],
    gallop4:    [
      { off: 0, hand: -1 }, { off: 0.75, hand: 0 },
      { off: 1.5, hand: -1 }, { off: 2.25, hand: 1 },
    ],
    denseSingle4: [
      { off: 0, hand: 0 }, { off: 0.25, hand: 1 }, { off: 0.5, hand: 0 }, { off: 0.75, hand: 1 },
    ],

    // === 6-NOTE PATTERNS ===
    stream6:    [
      { off: 0, hand: 0 }, { off: 0.5, hand: 1 },
      { off: 1, hand: 0 }, { off: 1.5, hand: 1 },
      { off: 2, hand: 0 }, { off: 2.5, hand: 1 },
    ],
    comboMix6:  [
      { off: 0, hand: -1 }, { off: 0.5, hand: 0 }, { off: 1, hand: 1 },
      { off: 1.5, hand: 0 }, { off: 2, hand: -1 }, { off: 2.5, hand: 1 },
    ],

    // === 8-NOTE PATTERNS ===
    stream8:    [
      { off: 0, hand: 0 }, { off: 0.5, hand: 1 },
      { off: 1, hand: 0 }, { off: 1.5, hand: 1 },
      { off: 2, hand: 0 }, { off: 2.5, hand: 1 },
      { off: 3, hand: 0 }, { off: 3.5, hand: 1 },
    ],
    denseStream8: [
      { off: 0, hand: 0 }, { off: 0.25, hand: 1 },
      { off: 0.5, hand: 0 }, { off: 0.75, hand: 1 },
      { off: 1, hand: 0 }, { off: 1.25, hand: 1 },
      { off: 1.5, hand: 0 }, { off: 1.75, hand: 1 },
    ],

    // === COMBO PATTERNS ===
    dsd:        [{ off: 0, hand: -1 }, { off: 1, hand: 0 }],
    sds:        [{ off: 0, hand: 0 }, { off: 0.5, hand: -1 }, { off: 1, hand: 1 }],
    windowAlt:  [{ off: 0, hand: -2 }, { off: 1, hand: 0 }, { off: 1.5, hand: 1 }],

    // === REST ===
    rest:       [],
  };

  // Difficulty + section + style → available pattern pool
  function getPatPool(diff, secType, energy, style) {
    const P = {
      Easy: {
        lo: ["rest","singleR","singleB"],
        md: ["singleR","singleB","altRL","altLR","singleR","singleB"],
        hi: ["altRL","altLR","altRL","altLR","double","singleR","singleB"],
      },
      Normal: {
        lo: ["singleR","singleB","altRL","altLR"],
        md: ["altRL","altLR","altRL","altLR","halfAltRL","halfAltLR","singleR","singleB"],
        hi: ["halfAltRL","halfAltLR","altRL","altLR","double","tripleAlt","kickHatSnare"],
      },
      Hard: {
        lo: ["altRL","altLR","singleR","singleB","halfAltRL"],
        md: ["halfAltRL","halfAltLR","kickHatSnare","tripleAlt","altRL","altLR","doubleFollow"],
        hi: ["stream4","halfAltRL","halfAltLR","kickHatSnare","double","gallop4","tripleAlt","doubleFollow","followDouble"],
      },
      Expert: {
        lo: ["halfAltRL","halfAltLR","altRL","altLR","tripleAlt"],
        md: ["stream4","halfAltRL","halfAltLR","kickHatSnare","tripleAlt","gallop4","doubleFollow","sds"],
        hi: ["stream6","stream4","denseStream8","gallop4","double","dsd","sds","window","windowAlt","altDouble4","followDouble","comboMix6"],
      },
      ExpertPlus: {
        lo: ["halfAltRL","halfAltLR","stream4","tripleAlt"],
        md: ["stream6","stream4","gallop4","denseStream8","doubleFollow","sds","kickHatSnare","altDouble4"],
        hi: ["stream8","denseStream8","stream6","comboMix6","gallop4","double","dsd","window","windowAlt","altDouble4","followDouble","sds"],
      },
    };
    let p = P[diff] || P.Hard;

    // Style-specific pool overrides for high-energy sections
    if (style && (secType === SEC.DROP || secType === SEC.CHORUS || secType === SEC.BUILDUP)) {
      switch (style) {
        case "tech":
          // Ranked-style: windows, combos, controlled variety. No long streams.
          p = { ...p, hi: ["window","windowAlt","sds","dsd","doubleFollow","followDouble","tripleAlt","gallop4","comboMix6","altDouble4","halfAltRL","halfAltLR","kickHatSnare"] };
          break;
        case "speed":
          // Dense streams and bursts dominate. Minimal doubles/windows.
          p = { ...p, hi: ["stream8","denseStream8","stream6","stream4","stream4","gallop4","halfAltRL","halfAltLR","tripleAlt"] };
          break;
        case "fitness":
          // Big doubles, jumps (handled by doubleRate/jumpRate), wide patterns
          p = { ...p, hi: ["double","double","doubleFollow","followDouble","window","altDouble4","dsd","altRL","altLR","singleR","singleB"] };
          break;
        case "dance":
          // Flow patterns: smooth alternating, arcs, no streams
          p = { ...p, hi: ["altRL","altLR","halfAltRL","halfAltLR","double","doubleFollow","followDouble","singleR","singleB","window"] };
          break;
        case "chill":
          // Very sparse: mostly singles and simple alternating
          p = { ...p, hi: ["singleR","singleB","altRL","altLR","singleR","singleB"], md: ["singleR","singleB","altRL","rest","singleR"] };
          break;
        case "spam":
          // EVERY BEAT GETS NOTES — dense doubles, streams, combos everywhere
          p = {
            lo: ["altRL","altLR","halfAltRL","halfAltLR","double","stream4"],
            md: ["stream4","stream6","double","dsd","sds","gallop4","altDouble4","halfAltRL","halfAltLR","comboMix6"],
            hi: ["stream8","denseStream8","stream6","comboMix6","double","dsd","sds","window","windowAlt","gallop4","altDouble4","followDouble","doubleFollow","stream4"],
          };
          break;
        case "vibro":
          // Pure speed streams — dense alternating only
          p = {
            lo: ["halfAltRL","halfAltLR","stream4","denseStream8"],
            md: ["denseStream8","stream8","stream6","stream4","halfAltRL","halfAltLR"],
            hi: ["denseStream8","denseStream8","stream8","stream8","stream6","stream4","halfAltRL","halfAltLR"],
          };
          break;
      }
    }

    // Spam/vibro: always use hi pool — every section gets max notes
    if (style === "spam" || style === "vibro") {
      if (secType === SEC.BREAK || secType === SEC.INTRO || secType === SEC.OUTRO) return p.md;
      return p.hi;
    }

    if (secType === SEC.BREAK || secType === SEC.INTRO || secType === SEC.OUTRO) return p.lo;
    if (secType === SEC.VERSE) return energy > 0.45 ? p.md : p.lo;
    if (secType === SEC.BUILDUP) return energy > 0.5 ? p.hi : p.md;
    return energy > 0.35 ? p.hi : p.md;
  }

  // Grid step — much finer for higher diffs (this controls how often patterns CAN be placed)
  // BSMG cursor precision per difficulty — these are beat subdivisions
  // Easy: 1/1 (whole beats — kick drums, strong downbeats)
  // Normal: 1/2 (half beats — kick + snare)
  // Hard: 1/2 (half beats with occasional 1/4 in drops)
  // Expert: 1/4 (quarter beats — hi-hats, fast rhythms)
  // Expert+: 1/4 (quarter beats — every subdivision filled in drops)
  function getGridStep(diff, secType) {
    const precision = {
      Easy: 1.0,        // 1/1 — whole beats only
      Normal: 0.5,      // 1/2 — half beats
      Hard: 0.5,        // 1/2 (drops can use 1/4)
      Expert: 0.25,     // 1/4 — quarter beats
      ExpertPlus: 0.25, // 1/4 — maximum precision
    };
    let s = precision[diff] || 0.5;

    // Hard can go to 1/4 in drops
    if (diff === "Hard" && (secType === SEC.DROP || secType === SEC.CHORUS)) s = 0.25;

    // Widen for quiet sections — map to downbeats only
    if (secType === SEC.BREAK || secType === SEC.INTRO) {
      s = Math.max(s, diff === "Easy" ? 2 : 1);
    }
    if (secType === SEC.OUTRO) {
      s = Math.max(s, diff === "Easy" ? 2 : diff === "Normal" ? 1 : 0.5);
    }
    return s;
  }

  // Identify which instrument is dominant at a given time
  // Returns: "kick", "snare", "hihat", "vocal", "bass", "synth", "silence"
  function getInstrumentAt(t) {
    const bass = getNormBassAt(t);
    const subBass = state.subBassCurve ? getNormSubBassAt(t) : bass * 0.5;
    const mid = getNormMidAt(t);
    const high = getNormHighAt(t);
    const energy = getEnergyAtTime(t);

    if (energy < 0.05) return "silence";

    // BEAT DETECTION FIRST — kick and snare are the backbone of mapping
    // Lower thresholds = more likely to detect percussion = more beat-aligned notes

    // Kick drum: any significant bass presence
    if (bass > 0.4 && subBass > 0.3) return "kick";
    // Snare: mid+high spike (snare has both body and brightness)
    if (mid > 0.4 && high > 0.35 && bass > 0.15) return "snare";
    // Hi-hat/cymbal: high-only with minimal low end
    if (high > 0.5 && mid < 0.3 && bass < 0.25) return "hihat";
    // Bass line: strong low end without the transient attack of a kick
    if (bass > 0.45 && subBass < 0.3 && mid < 0.3) return "bass";
    // Vocal: ONLY when mid is very dominant with almost no bass/high
    // (raised thresholds so it doesn't catch synths and leads)
    if (mid > 0.6 && bass < 0.2 && high < 0.3) return "vocal";
    // Default: treat as generic beat (maps to alternating patterns)
    // This ensures notes stay beat-aligned instead of following melodies
    return "beat";
  }

  // BSMG HIT TYPE HIERARCHY: single < slider/chain < stack < window < tower
  // Map instruments to hit types consistently — kick always gets same treatment
  function getInstrumentPattern(instrument, diff, energy) {
    const isEasy = diff === "Easy" || diff === "Normal";
    const isExpert = diff === "Expert" || diff === "ExpertPlus";

    switch (instrument) {
      case "kick":
        // Kick = main beat anchor — strongest emphasis
        if (isEasy) return energy > 0.5 ? "double" : "singleR";
        return energy > 0.7 ? "window" : "double";

      case "snare":
        // Snare = accent on off-beats, opposite hand
        if (isEasy) return "singleB";
        return energy > 0.5 ? "halfAltRL" : "altLR";

      case "hihat":
        // Hi-hat = fast light — Easy skips, Expert maps them
        if (isEasy) return null;
        return isExpert ? "halfAltRL" : "singleR";

      case "vocal":
        // Vocals = flowing alternating (only when truly vocal)
        if (isEasy) return "altRL";
        return isExpert ? "tripleAlt" : "altRL";

      case "bass":
        // Bass line = low emphasis fill
        if (isEasy) return "singleR";
        return energy > 0.5 ? "dsd" : "altRL";

      case "beat":
        // Generic beat — alternating patterns that follow the rhythm
        if (isEasy) return energy > 0.4 ? "altRL" : "singleR";
        return isExpert ? "halfAltRL" : "altRL";

      case "silence":
        return null; // Never map silence

      default:
        return null;
    }
  }

  function generateNotes(unused, bpm, settings, totalBeats) {
    const notes = [];
    const diffName = settings.diffName || "Expert";
    currentDiffName = diffName; // Track for placeGridNote
    const useVBPM = state.bpmRegions.length > 1;

    // Hand parity state
    const hs = {
      [C.RED]:  { lastBeat: -10, lastDir: D.DOWN, lastX: 1, lastY: 0, swingCount: 0, parity: "fore" },
      [C.BLUE]: { lastBeat: -10, lastDir: D.DOWN, lastX: 2, lastY: 0, swingCount: 0, parity: "fore" },
    };

    let beat = 0.5;
    let lastPatEnd = -4;

    const diffGaps = { Easy: { drop: 1.5, verse: 2.5, quiet: 4 }, Normal: { drop: 0.75, verse: 1.5, quiet: 3 },
                       Hard: { drop: 0.25, verse: 0.75, quiet: 2 }, Expert: { drop: 0, verse: 0.25, quiet: 1 },
                       ExpertPlus: { drop: 0, verse: 0, quiet: 0.5 } };
    const diffProbs = { Easy: { drop: 0.75, verse: 0.55, quiet: 0.3 }, Normal: { drop: 0.85, verse: 0.65, quiet: 0.35 },
                        Hard: { drop: 0.95, verse: 0.75, quiet: 0.45 }, Expert: { drop: 1.0, verse: 0.85, quiet: 0.5 },
                        ExpertPlus: { drop: 1.0, verse: 0.95, quiet: 0.6 } };
    const isSpam = settings.style === "spam";
    const isSimple = diffName === "Easy" || diffName === "Normal";
    const gaps = isSpam ? { drop: 0, verse: 0, quiet: 0 } : (diffGaps[diffName] || diffGaps.Hard);
    const probs = isSpam ? { drop: 1, verse: 1, quiet: 0.95 } : (diffProbs[diffName] || diffProbs.Hard);

    // GROOVE LOCK state
    let groovePattern = null, grooveBeatsLeft = 0, grooveSection = null, grooveEnergy = 0;

    while (beat < totalBeats - 1) {
      const t = useVBPM ? beatToTimeVBPM(beat) : beatToTime(beat, bpm);
      if (t >= state.audioDuration) break;
      const localBPM = useVBPM ? getBPMAtTime(t) : bpm;
      const section = getSectionAt(t);
      const energy = getEnergyAtTime(t);
      const bass = getNormBassAt(t);
      const mid = getNormMidAt(t);
      const high = getNormHighAt(t);
      const gridStep = isSpam ? 0.25 : getGridStep(diffName, section.type);

      // CRITICAL: Snap beat to grid to prevent floating-point drift
      beat = Math.round(beat / gridStep) * gridStep;
      beat = parseFloat(beat.toFixed(4));

      // Skip truly silent beats — but lower threshold so quiet sections still get notes
      const silenceThreshold = isSpam ? 0.02 : 0.05;
      if (energy < silenceThreshold) { beat += gridStep; continue; }

      // END-OF-SONG TAPER
      const songProgress = beat / totalBeats;
      let endTaper = 1.0;
      if (songProgress > 0.92 && !isSpam) {
        endTaper = Math.max(0.15, 1.0 - (songProgress - 0.92) * 10);
      }

      // Breathing room
      const minGap = (section.type === SEC.DROP || section.type === SEC.CHORUS) ? gaps.drop :
                     (section.type === SEC.VERSE || section.type === SEC.BUILDUP) ? gaps.verse : gaps.quiet;
      if (beat - lastPatEnd < minGap) { beat += gridStep; continue; }

      // Beat position helpers
      const isDown = Math.abs(beat % 1) < 0.05;
      const isHalf = Math.abs(beat % 0.5) < 0.05;

      // BEAT-ALIGNED ONSET CHECK
      // Instead of comparing raw onset times (which are at FFT resolution),
      // quantize each onset to the nearest beat grid position and check if
      // the current beat has an onset. This ensures notes land ON the beat.
      const halfGrid = gridStep / 2;
      const hasOnset = state.onsets.some(o => {
        const onsetBeat = timeToBeat(o, localBPM);
        return Math.abs(onsetBeat - beat) < halfGrid;
      });

      // BEAT ALIGNMENT — notes should only appear where there's sound
      if (!isSpam && settings.style !== "vibro") {
        // Quiet sections: require onset on the beat
        if (!hasOnset && (section.type === SEC.VERSE || section.type === SEC.BREAK ||
            section.type === SEC.INTRO || section.type === SEC.OUTRO)) {
          beat += gridStep; continue;
        }
        // Active sections: allow downbeats even without onset, skip offbeats with no onset + low energy
        if (!hasOnset && energy < 0.25 && !isDown) {
          beat += gridStep; continue;
        }
      }

      // BSMG EMPHASIS LEVEL — determines which hit type to use
      // 0 = minimal (single), 1 = normal (alt), 2 = moderate (stack/slider), 3 = strong (window/double), 4 = peak (tower)
      let emphasisLevel = 0;
      if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
        emphasisLevel = energy > 0.7 ? 3 : energy > 0.4 ? 2 : 1;
        if (bass > 0.7 && hasOnset) emphasisLevel = Math.min(4, emphasisLevel + 1);
      } else if (section.type === SEC.BUILDUP) {
        const buildPr = Math.min(1, (t - section.startTime) / Math.max(1, section.endTime - section.startTime));
        emphasisLevel = buildPr > 0.7 ? 2 : buildPr > 0.3 ? 1 : 0;
      } else if (section.type === SEC.VERSE) {
        emphasisLevel = energy > 0.5 ? 1 : 0;
      } else {
        emphasisLevel = 0;
      }

      // Probability — HEAVILY favor beats with detected onsets
      const baseProb = (section.type === SEC.BREAK || section.type === SEC.INTRO || section.type === SEC.OUTRO) ? probs.quiet :
                   (section.type === SEC.VERSE) ? probs.verse : probs.drop;
      // Onset = high prob, no onset = very low prob (notes should be on beats)
      const prob = (hasOnset ? Math.min(1, baseProb + 0.3) : baseProb * 0.4) * endTaper;
      if (Math.random() > prob) { beat += gridStep; continue; }

      // ============================================================
      // SECTION-LOCKED RHYTHM TARGET — pick ONE thing to map per section
      // Drops/Chorus: kick + snare backbone (the BEAT)
      // Verse: kick only (sparse, intentional)
      // Buildup: kick + increasing density
      // Break/Intro/Outro: kick on downbeats only
      // This prevents the "mapping everything at once" problem
      // ============================================================
      const bpmFactor = localBPM > 170 ? 0.8 : localBPM > 140 ? 0.9 : 1.0;
      let patName;

      // Break groove on section change
      if (section.type !== grooveSection) {
        grooveBeatsLeft = 0;
        grooveSection = section.type;
      }

      if (grooveBeatsLeft > 0 && groovePattern && PAT[groovePattern]) {
        // GROOVE LOCKED — reuse pattern with variation
        patName = groovePattern;
        grooveBeatsLeft--;

        // 20% chance to swap to related pattern (keeps things interesting)
        if (Math.random() < 0.2) {
          const variants = {
            altRL: ["altLR", "halfAltRL"], altLR: ["altRL", "halfAltLR"],
            halfAltRL: ["halfAltLR"], halfAltLR: ["halfAltRL"],
            singleR: ["singleB"], singleB: ["singleR"],
            double: ["followDouble", "dsd"], followDouble: ["double", "doubleFollow"],
            stream4: ["gallop4", "altDouble4"], gallop4: ["stream4"],
            dsd: ["sds", "double"], sds: ["dsd"],
            tripleAlt: ["kickHatSnare"], kickHatSnare: ["tripleAlt"],
            stream6: ["stream4", "comboMix6"], stream8: ["denseStream8", "stream6"],
          };
          const alts = variants[patName];
          if (alts) patName = alts[Math.floor(Math.random() * alts.length)];
        }
      } else {
        // PICK NEW GROOVE based on section type

        // EMPHASIS OVERRIDE — big moments get big hits regardless of section
        let emphasisPat = null;
        if (!isSimple && emphasisLevel >= 3) {
          if (emphasisLevel >= 4) emphasisPat = diffName === "ExpertPlus" ? "window" : "double";
          else if (Math.random() < 0.4) emphasisPat = Math.random() < 0.5 ? "window" : "double";
        }

        if (emphasisPat && PAT[emphasisPat]) {
          patName = emphasisPat;
        } else if (isSpam || settings.style === "vibro") {
          const pool = getPatPool(diffName, section.type, 1.0, settings.style);
          patName = seededChoice(pool, beat) || pickRandom(pool);
        } else {
          // SECTION-SPECIFIC RHYTHM TARGET
          switch (section.type) {
            case SEC.DROP:
            case SEC.CHORUS:
              // Map to kick + snare = the BEAT. Dense, energetic.
              if (bass > 0.5) {
                // Bass hit = kick drum moment → emphasis patterns
                const kickPool = isSimple
                  ? ["double", "altRL", "altLR", "singleR", "singleB"]
                  : ["double", "dsd", "followDouble", "gallop4", "altDouble4", "halfAltRL"];
                patName = seededChoice(kickPool, beat) || pickRandom(kickPool);
              } else {
                // Non-kick beat → alternating fills
                const fillPool = isSimple
                  ? ["altRL", "altLR", "singleR", "singleB"]
                  : ["halfAltRL", "halfAltLR", "tripleAlt", "kickHatSnare", "stream4"];
                patName = seededChoice(fillPool, beat) || pickRandom(fillPool);
              }
              break;

            case SEC.VERSE:
              // Sparse — map to kick hits only, simple patterns
              if (bass > 0.4) {
                const versePool = isSimple
                  ? ["singleR", "singleB", "altRL"]
                  : ["altRL", "altLR", "halfAltRL", "singleR", "singleB"];
                patName = seededChoice(versePool, beat) || pickRandom(versePool);
              } else {
                const quietPool = ["singleR", "singleB", "altRL", "altLR"];
                patName = seededChoice(quietPool, beat) || pickRandom(quietPool);
              }
              break;

            case SEC.BUILDUP:
              // Gradually increase density — start sparse, end dense
              {
                const buildPr = Math.min(1, (t - section.startTime) / Math.max(1, section.endTime - section.startTime));
                if (buildPr > 0.7) {
                  // Late buildup — dense patterns approaching drop intensity
                  const latePool = isSimple
                    ? ["altRL", "altLR", "double", "halfAltRL"]
                    : ["stream4", "halfAltRL", "gallop4", "dsd", "tripleAlt"];
                  patName = pickRandom(latePool);
                } else if (buildPr > 0.3) {
                  const midPool = isSimple
                    ? ["altRL", "singleR", "singleB"]
                    : ["halfAltRL", "halfAltLR", "altRL", "tripleAlt"];
                  patName = pickRandom(midPool);
                } else {
                  patName = pickRandom(["singleR", "singleB", "altRL", "altLR"]);
                }
              }
              break;

            default:
              // Break/Intro/Outro — minimal, downbeat kicks only
              patName = pickRandom(["singleR", "singleB", "altRL"]);
              break;
          }
        }

        // Groove lock duration — how long to stick with this pattern
        const isSpamStyle = isSpam || settings.style === "vibro";
        grooveBeatsLeft = isSpamStyle ? (1 + Math.floor(Math.random() * 2))
          : (section.type === SEC.DROP || section.type === SEC.CHORUS)
            ? 2 + Math.floor(Math.random() * 3)  // 2-4 beats in drops (more variety)
            : (section.type === SEC.VERSE || section.type === SEC.BREAK)
              ? 4 + Math.floor(Math.random() * 5)  // 4-8 beats in verses (steady)
              : 3 + Math.floor(Math.random() * 3);  // 3-5 beats elsewhere
        groovePattern = patName;
        grooveEnergy = energy;
      }

      const pattern = PAT[patName];
      if (!pattern || pattern.length === 0) { beat += 2; lastPatEnd = beat; continue; }

      let maxOff = 0;
      const placed = [];
      let valid = true;

      for (const step of pattern) {
        const nb = parseFloat((beat + step.off).toFixed(4)); // Snap to grid
        if (nb >= totalBeats - 0.5) { valid = false; break; }
        maxOff = Math.max(maxOff, step.off);
        if (step.hand === -1) {
          placeGridNote(placed, nb, C.RED, hs, section, energy);
          placeGridNote(placed, nb, C.BLUE, hs, section, energy);
        } else if (step.hand === -2) {
          // WINDOW — use current hand positions, not always 1,2
          const redPos = getFlowPosition(C.RED, hs[C.RED].parity === "fore" ? D.DOWN : D.UP, hs, section, energy);
          const bluePos = getFlowPosition(C.BLUE, hs[C.BLUE].parity === "fore" ? D.DOWN : D.UP, hs, section, energy);
          const dir = hs[C.RED].parity === "fore" ? D.DOWN : D.UP;
          // Ensure they're not on the same column
          let rx = redPos.x, bx = bluePos.x;
          if (rx === bx) { rx = Math.max(0, bx - 1); }
          if (rx > bx) { const tmp = rx; rx = bx; bx = tmp; } // Red always left of blue
          placed.push({ b: nb, x: rx, y: redPos.y, c: C.RED, d: dir, a: 0 });
          placed.push({ b: nb, x: bx, y: bluePos.y, c: C.BLUE, d: dir, a: 0 });
          flipParity(hs, C.RED, dir, nb, rx, redPos.y);
          flipParity(hs, C.BLUE, dir, nb, bx, bluePos.y);
        } else {
          placeGridNote(placed, nb, step.hand, hs, section, energy);
        }
      }

      if (valid && placed.length > 0) {
        for (const n of placed) notes.push(n);
        lastPatEnd = beat + maxOff;
        if (placed.length > 2) logGen(beat, "pattern", patName.toUpperCase() + " x" + placed.length);
      }
      // Advance past the pattern: skip to just after the last note in the pattern
      beat = lastPatEnd + gridStep;
    }

    notes.sort((a, b) => a.b - b.b);
    parityValidationPass(notes);
    return notes;
  }

  // BSMG angle comfort rules:
  // 180° change = perfect (down → up)
  // 135° change = great (down → up-diagonal)
  // 90° change = okay ONLY if gap >= 1 beat
  // <90° change = wrist-breaker, NEVER allow

  // Hand-natural directions — left hand (red) favors left-side diagonals, right hand (blue) favors right
  // Expanded direction pools per hand — includes contextual horizontals for Expert+
  // The wider pools mean SAFE_FOLLOWUPS will more often find a parity match
  const HAND_FORE_DIRS = {
    [C.RED]:  [D.DOWN, D.DOWN_LEFT, D.DOWN_RIGHT, D.LEFT],
    [C.BLUE]: [D.DOWN, D.DOWN_RIGHT, D.DOWN_LEFT, D.RIGHT],
  };
  const HAND_BACK_DIRS = {
    [C.RED]:  [D.UP, D.UP_RIGHT, D.UP_LEFT, D.RIGHT],
    [C.BLUE]: [D.UP, D.UP_LEFT, D.UP_RIGHT, D.LEFT],
  };
  // Narrow pools for Easy/Normal — no horizontals, strict parity
  const HAND_FORE_SIMPLE = {
    [C.RED]:  [D.DOWN, D.DOWN_LEFT],
    [C.BLUE]: [D.DOWN, D.DOWN_RIGHT],
  };
  const HAND_BACK_SIMPLE = {
    [C.RED]:  [D.UP, D.UP_RIGHT],
    [C.BLUE]: [D.UP, D.UP_LEFT],
  };

  // Safe follow-up directions per previous direction (only 135°+ angle changes)
  const SAFE_FOLLOWUPS = {
    [D.DOWN]:       { best: [D.UP], good: [D.UP_LEFT, D.UP_RIGHT] },
    [D.DOWN_LEFT]:  { best: [D.UP_RIGHT], good: [D.UP] },
    [D.DOWN_RIGHT]: { best: [D.UP_LEFT], good: [D.UP] },
    [D.UP]:         { best: [D.DOWN], good: [D.DOWN_LEFT, D.DOWN_RIGHT] },
    [D.UP_LEFT]:    { best: [D.DOWN_RIGHT], good: [D.DOWN] },
    [D.UP_RIGHT]:   { best: [D.DOWN_LEFT], good: [D.DOWN] },
    [D.LEFT]:       { best: [D.RIGHT], good: [D.DOWN_RIGHT, D.UP_RIGHT] },
    [D.RIGHT]:      { best: [D.LEFT], good: [D.DOWN_LEFT, D.UP_LEFT] },
  };

  // ============================================================
  // ATTENTION-BASED PATTERN SCORER
  // Looks at recent note history to score candidate placements.
  // Uses a sliding window of the last N notes per hand and
  // scores each candidate based on:
  //   - Angle quality (attention over recent directions)
  //   - Position variety (attention over recent positions)
  //   - Musical alignment (energy/bass at the beat)
  //   - Repetition penalty (self-attention for repeated patterns)
  // ============================================================

  // ============================================================
  // BSMG SWING CURVATURE + ROTATION SCORING
  // Positive curvature: left hand CW backhand→forehand, CCW forehand→backhand
  //                     right hand is mirrored
  // Positive curvature = smoother, allows larger rotations
  // ============================================================

  function getRotationAngle(prevDir, currDir) {
    // Rotation assumes parity — 180° apart = 0 rotation
    const a = DIR_ANGLE[prevDir] || 0;
    const b = DIR_ANGLE[currDir] || 0;
    let diff = (b - a + 360) % 360;
    // Normalize: 0-180 is the rotation amount (parity means opposite = 0)
    if (diff > 180) diff = 360 - diff;
    // True rotation = distance from 180° (since parity expects opposite)
    return Math.abs(180 - diff); // 0 = no rotation, 180 = max rotation
  }

  function getCurvatureSign(prevDir, currDir, hand, prevParity) {
    // Returns +1 for positive curvature, -1 for negative, 0 for neutral
    const a = DIR_ANGLE[prevDir] || 0;
    const b = DIR_ANGLE[currDir] || 0;
    let clockwise = ((b - a + 360) % 360) < 180;

    // Positive curvature for left hand:
    //   backhand→forehand: clockwise
    //   forehand→backhand: counter-clockwise
    // Right hand is mirrored
    const isForeToBack = prevParity === "fore";
    let positive;
    if (hand === C.RED) {
      positive = isForeToBack ? !clockwise : clockwise;
    } else {
      positive = isForeToBack ? clockwise : !clockwise;
    }
    return positive ? 1 : -1;
  }

  function scoreCandidate(dir, x, y, hand, hs, beat, section, energy) {
    const h = hs[hand];
    const recent = recentDirs[hand] || [];
    let score = 5.0;

    // 1. ROTATION CONTROL — per BSMG guidelines
    if (h.lastBeat > -5) {
      const rotation = getRotationAngle(h.lastDir, dir);
      const beatGap = beat - h.lastBeat;

      // Small rotations (0-45°) are smooth and comfortable
      if (rotation <= 45) score += 1.5;
      // Medium rotations (45-90°) are fine with enough time
      else if (rotation <= 90) score += beatGap >= 0.5 ? 0.5 : -0.5;
      // Large rotations (90-135°) need more time and emphasis
      else if (rotation <= 135) score += (energy > 0.6 && beatGap >= 0.75) ? 0.3 : -1.5;
      // Extreme rotations (135°+) should almost never happen
      else score -= 3.0;

      // 2. SWING CURVATURE — positive curvature is smoother
      const curv = getCurvatureSign(h.lastDir, dir, hand, h.parity);
      if (curv > 0) score += 0.8;  // Positive curvature = natural )( arcs
      else score -= 0.3;            // Negative curvature = less natural

      // Basic angle safety check
      const angle = angleDiff(DIR_ANGLE[h.lastDir], DIR_ANGLE[dir]);
      if (angle < 90) score -= 3.0; // Wrist breaker regardless of curvature
    }

    // 3. FOREHAND/BACKHAND LANE PREFERENCE (BSMG)
    // Forehand = more comfortable in inner lanes, backhand = outer lanes
    if (h.parity === "fore") {
      // Forehand: inner lanes preferred
      if (hand === C.RED && x >= 1) score += 0.3;
      if (hand === C.BLUE && x <= 2) score += 0.3;
    } else {
      // Backhand: outer lanes preferred
      if (hand === C.RED && x <= 1) score += 0.3;
      if (hand === C.BLUE && x >= 2) score += 0.3;
    }

    // 4. POSITION FLOW — smooth movement
    if (h.lastBeat > -5) {
      const dx = Math.abs(x - h.lastX), dy = Math.abs(y - h.lastY);
      if (dx === 0 && dy === 0) score -= 0.8;
      else if (dx <= 1 && dy <= 1) score += 0.5;
      else score -= 0.5;
    }

    // 5. REPETITION PENALTY
    if (recent.length >= 2) {
      let repeatCount = 0;
      for (const rd of recent) { if (rd === dir) repeatCount++; }
      if (repeatCount >= 3) score -= 4.0;
      else if (repeatCount >= 2) score -= 2.0;
      if (recent.length > 0 && recent[recent.length - 1] === dir) score -= 1.5;
    }

    // 6. DIRECTION DIVERSITY
    if (recent.length >= 4) {
      if (!new Set(recent).has(dir)) score += 1.0;
    }

    // 7. EMPHASIS MATCHING — larger rotations on emphasized beats
    if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
      // Drops/chorus: reward diagonals for emphasis, varied angles
      if (dir !== D.DOWN && dir !== D.UP) score += 0.4;
      // Forehand hits carry more emphasis — use them on strong beats
      if (h.parity === "fore" && Math.abs(beat % 1) < 0.05) score += 0.3;
    } else if (section.type === SEC.VERSE || section.type === SEC.BREAK) {
      // Calm: reward simple directions, low rotation
      if (dir === D.DOWN || dir === D.UP) score += 0.5;
    } else if (section.type === SEC.BUILDUP) {
      // Buildup: gradually increase rotation angle as intensity rises
      const buildPr = energy;
      if (h.lastBeat > -5) {
        const rot = getRotationAngle(h.lastDir, dir);
        if (rot > 45 * buildPr) score += 0.3; // Reward growing rotation
      }
    }

    // 8. HAND NATURAL PREFERENCE
    if (hand === C.RED) {
      if (dir === D.DOWN_LEFT || dir === D.UP_RIGHT) score += 0.3;
    } else {
      if (dir === D.DOWN_RIGHT || dir === D.UP_LEFT) score += 0.3;
    }

    return score;
  }

  // Select the best direction from candidates using attention scoring
  function selectBestDirection(candidates, hand, hs, beat, section, energy) {
    if (candidates.length <= 1) return candidates[0] || D.DOWN;

    let bestDir = candidates[0], bestScore = -999;
    const pos = getFlowPosition(hand, candidates[0], hs, section, energy);

    for (const dir of candidates) {
      const p = getFlowPosition(hand, dir, hs, section, energy);
      const s = scoreCandidate(dir, p.x, p.y, hand, hs, beat, section, energy);
      if (s > bestScore) { bestScore = s; bestDir = dir; }
    }
    return bestDir;
  }

  // BSMG angle rules + hand preference + attention scoring
  function placeGridNote(arr, beat, hand, hs, section, energy) {
    const h = hs[hand];
    const beatGap = beat - h.lastBeat;
    const isSimple = currentDiffName === "Easy" || currentDiffName === "Normal";

    let dir;
    if (h.lastBeat < -5) {
      // First note — use hand-natural forehand
      dir = isSimple ? HAND_FORE_SIMPLE[hand][0] : HAND_FORE_DIRS[hand][0];
    } else if (beatGap >= 2.5) {
      // Long gap — parity soft reset, pick a comfortable starter
      const pool = h.parity === "fore"
        ? (isSimple ? HAND_FORE_SIMPLE[hand] : HAND_FORE_DIRS[hand])
        : (isSimple ? HAND_BACK_SIMPLE[hand] : HAND_BACK_DIRS[hand]);
      // Pick based on energy — higher energy = more diagonal variety
      dir = energy > 0.5 ? pool[Math.floor(Math.random() * pool.length)] : pool[0];
    } else {
      // Normal flow — use safe follow-ups filtered by parity
      const safeDirs = SAFE_FOLLOWUPS[h.lastDir];
      if (safeDirs) {
        const parityPool = h.parity === "fore"
          ? (isSimple ? HAND_FORE_SIMPLE[hand] : HAND_FORE_DIRS[hand])
          : (isSimple ? HAND_BACK_SIMPLE[hand] : HAND_BACK_DIRS[hand]);

        const bestMatch = safeDirs.best.filter(d => parityPool.includes(d));
        const goodMatch = safeDirs.good.filter(d => parityPool.includes(d));
        const allSafe = [...bestMatch, ...goodMatch];

        if (allSafe.length > 0) {
          dir = selectBestDirection(allSafe, hand, hs, beat, section, energy);
        } else {
          // KEY FIX: Don't fall back to boring DOWN/UP!
          // Use best angle-safe direction regardless of parity — better flow than repetitive down-up
          const allCandidates = [...safeDirs.best, ...safeDirs.good];
          if (allCandidates.length > 0) {
            dir = selectBestDirection(allCandidates, hand, hs, beat, section, energy);
          } else {
            // True last resort — use PARITY_FOLLOWUP table with variety
            const followups = PARITY_FOLLOWUP[h.lastDir] || PARITY_FOLLOWUP[D.ANY];
            dir = followups[Math.floor(Math.random() * Math.min(2, followups.length))];
          }
        }
      } else {
        const followups = PARITY_FOLLOWUP[h.lastDir] || PARITY_FOLLOWUP[D.ANY];
        dir = followups[Math.floor(Math.random() * Math.min(2, followups.length))];
      }
    }

    // Hard angle safety check — but use PARITY_FOLLOWUP variety instead of DOWN/UP
    if (h.lastBeat > -5) {
      const angle = angleDiff(DIR_ANGLE[h.lastDir], DIR_ANGLE[dir]);
      if (angle < 90 || (angle < 135 && beatGap < 1)) {
        const followups = PARITY_FOLLOWUP[h.lastDir] || PARITY_FOLLOWUP[D.ANY];
        // Pick from followups, preferring ones the scorer likes
        dir = selectBestDirection(followups, hand, hs, beat, section, energy);
      }
    }

    const pos = getFlowPosition(hand, dir, hs, section, energy);
    const other = hand === C.RED ? C.BLUE : C.RED;
    const safe = resolveCollision(pos, beat, arr, hand, other, hs);

    // Arm crossing guard
    let x = safe.x;
    if (hand === C.RED && Math.abs(beat - hs[C.BLUE].lastBeat) < 1.5 && x >= hs[C.BLUE].lastX) {
      x = Math.max(TERRITORY[hand].minX, hs[C.BLUE].lastX - 1);
    }
    if (hand === C.BLUE && Math.abs(beat - hs[C.RED].lastBeat) < 1.5 && x <= hs[C.RED].lastX) {
      x = Math.min(TERRITORY[hand].maxX, hs[C.RED].lastX + 1);
    }

    arr.push({ b: beat, x: x, y: safe.y, c: hand, d: dir, a: 0 });
    flipParity(hs, hand, dir, beat, x, safe.y);
  }

  function flipParity(hs, hand, dir, beat, x, y) {
    const h = hs[hand];
    h.lastBeat = beat; h.lastDir = dir; h.lastX = x; h.lastY = y;
    h.swingCount++;
    h.parity = h.parity === "fore" ? "back" : "fore";
    trackDir(hand, dir);
  }

  // Repetition tracking — ring buffers per hand
  const recentDirs = { [C.RED]: [], [C.BLUE]: [] };
  const RECENT_HISTORY = 6;
  let currentDiffName = "Expert"; // Tracked for difficulty-aware direction selection

  // Smart parity direction — considers hand, section, comfort, and prevents repetition
  function getSmartParityDir(lastDir, beatGap, hand, section) {
    // After long gap, parity resets
    if (beatGap >= 2) {
      if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
        return pickNonRepeat([D.DOWN, D.DOWN_LEFT, D.DOWN_RIGHT], hand);
      }
      return D.DOWN;
    }

    const followups = PARITY_FOLLOWUP[lastDir] || PARITY_FOLLOWUP[D.ANY];

    // In calm sections, prefer the most comfortable (first) option
    if (section.type === SEC.VERSE || section.type === SEC.INTRO || section.type === SEC.BREAK) {
      const chosen = followups[0];
      trackDir(hand, chosen);
      return chosen;
    }

    // Use repetition prevention for energetic sections
    const chosen = pickNonRepeat(followups, hand);
    trackDir(hand, chosen);
    return chosen;
  }

  function trackDir(hand, dir) {
    recentDirs[hand].push(dir);
    if (recentDirs[hand].length > RECENT_HISTORY) recentDirs[hand].shift();
  }

  function pickNonRepeat(options, hand) {
    const recent = recentDirs[hand] || [];
    if (recent.length < 3 || options.length <= 1) return pickRandom(options);

    // Count how many times each option appeared recently
    const counts = {};
    for (const d of recent) counts[d] = (counts[d] || 0) + 1;

    // Filter to least-repeated options
    const scored = options.map(d => ({ d, count: counts[d] || 0 }));
    scored.sort((a, b) => a.count - b.count);
    const minCount = scored[0].count;
    const best = scored.filter(s => s.count <= minCount + 1).map(s => s.d);

    return pickRandom(best.length > 0 ? best : options);
  }

  // (avoidCollision replaced by resolveCollision above)

  // ============================================================
  // BSMG-COMPLIANT VALIDATION PASS
  // Based on https://bsmg.wiki/mapping/basic-mapping.html
  // Enforces: parity, vision blocks, forbidden patterns, flow angles
  // ============================================================

  function parityValidationPass(notes) {
    // PASS 1: Strict parity per hand — no double-downs or double-ups
    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);

      for (let i = 1; i < hand.length; i++) {
        const prev = hand[i - 1], curr = hand[i];
        const gap = curr.b - prev.b;

        // Reset after long gaps
        if (gap >= 2.0) continue;

        const prevDown = IS_DOWN.includes(prev.d) || prev.d === D.LEFT;
        const prevUp = IS_UP.includes(prev.d) || prev.d === D.RIGHT;
        const currDown = IS_DOWN.includes(curr.d) || curr.d === D.LEFT;
        const currUp = IS_UP.includes(curr.d) || curr.d === D.RIGHT;

        // Fix double-down or double-up
        if ((prevDown && currDown) || (prevUp && currUp)) {
          const followups = PARITY_FOLLOWUP[prev.d];
          if (followups && followups.length > 0) {
            // Use beat position as hash for variety (not array index which repeats)
            const pick = Math.floor(curr.b * 7) % followups.length;
            curr.d = followups[pick];
          } else {
            curr.d = prevDown ? D.UP : D.DOWN;
          }
        }

        // Angle safety check
        const angle = angleDiff(DIR_ANGLE[prev.d], DIR_ANGLE[curr.d]);
        const minAngle = gap < 0.75 ? 120 : 80;
        if (angle < minAngle) {
          const sf = SAFE_FOLLOWUPS[prev.d];
          if (sf) {
            const candidates = [...sf.best, ...sf.good];
            const pDown = IS_DOWN.includes(prev.d);
            const parityOK = pDown
              ? candidates.filter(d => IS_UP.includes(d) || d === D.RIGHT)
              : candidates.filter(d => IS_DOWN.includes(d) || d === D.LEFT);
            if (parityOK.length > 0) {
              curr.d = parityOK[Math.floor(curr.b * 3) % parityOK.length];
            } else {
              curr.d = pDown ? D.UP : D.DOWN;
            }
          } else {
            curr.d = IS_DOWN.includes(prev.d) ? D.UP : D.DOWN;
          }
        }
      }
    }

    // PASS 2: Fix same-cell overlaps
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].x === notes[j].x && notes[i].y === notes[j].y) {
          if (notes[j].c === C.BLUE) notes[j].x = Math.min(3, notes[j].x + 1);
          else notes[i].x = Math.max(0, notes[i].x - 1);
        }
      }
    }

    // PASS 3: Arm crossing guard
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        const red = notes[i].c === C.RED ? notes[i] : (notes[j].c === C.RED ? notes[j] : null);
        const blue = notes[i].c === C.BLUE ? notes[i] : (notes[j].c === C.BLUE ? notes[j] : null);
        if (red && blue && red.x > blue.x) {
          // Red is right of blue = crossing
          const tmp = red.x; red.x = blue.x; blue.x = tmp;
        }
      }
    }
  }

  // ---- ARCS (SLIDERS) ----
  // Arcs connect consecutive same-color notes with a curved guide line.
  // LIMITS: max 1 per 3 beats, capped total, only in sections with enough gap,
  // head/tail must have compatible swing directions
  function generateArcs(notes, bpm, settings) {
    const arcs = [];
    if (settings.arcRate <= 0) return arcs;
    const maxArcs = Math.max(4, Math.floor(notes.length / 12)); // ~1 arc per 12 notes
    let lastArcBeat = -10;

    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);
      for (let i = 0; i < hand.length - 1; i++) {
        if (arcs.length >= maxArcs) break;

        const curr = hand[i], next = hand[i + 1];
        const gap = next.b - curr.b;

        // Gap must be 1-3 beats (too short = cluttered, too long = invisible)
        if (gap < 1.0 || gap > 3.0) continue;

        // Minimum 3 beats since last arc
        if (curr.b - lastArcBeat < 3) continue;

        // Probability check
        if (Math.random() > settings.arcRate * 0.5) continue;

        const t = beatToTime(curr.b, bpm);
        const sec = getSectionAt(t);

        // Prefer arcs in flowing sections (verse, chorus), less in drops
        if (sec.type === SEC.DROP && Math.random() > 0.3) continue;
        if (sec.type === SEC.BREAK || sec.type === SEC.INTRO) {
          if (Math.random() > 0.5) continue; // Some arcs OK in calm sections for flow
        }

        // Arc curvature varies by section
        const mu = sec.type === SEC.VERSE ? 0.5 : (0.6 + Math.random() * 0.5);
        const tmu = 0.3 + Math.random() * 0.3;

        arcs.push({
          b: curr.b, c: color, x: curr.x, y: curr.y, d: curr.d,
          mu: mu, tb: next.b, tx: next.x, ty: next.y, tc: next.d,
          tmu: tmu, m: 0, a: 0,
        });
        lastArcBeat = curr.b;
      }
    }
    return arcs;
  }

  // ---- CHAINS (BURST SLIDERS) ----
  // Chains attach to existing notes and slide to a tail position.
  // STRICT LIMITS: max 1 chain per 4 beats, only on strong beats, capped total count
  function generateChains(notes, bpm, settings, totalBeats) {
    const chains = [];
    if (settings.chainRate <= 0) return chains;

    const maxChains = Math.max(2, Math.floor(totalBeats / 16)); // ~1 chain per 16 beats
    let lastChainBeat = -10;

    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);
      for (let i = 0; i < hand.length - 1; i++) {
        if (chains.length >= maxChains) break;

        const curr = hand[i], next = hand[i + 1];
        const gap = next.b - curr.b;

        // Needs 0.75-2.5 beat gap and minimum 4 beats since last chain
        if (gap < 0.75 || gap > 2.5) continue;
        if (curr.b - lastChainBeat < 4) continue;

        // Low probability — chains are special, not common
        if (Math.random() > settings.chainRate * 0.4) continue;

        const t = beatToTime(curr.b, bpm);
        const sec = getSectionAt(t);
        const energy = getEnergyAtTime(t);
        const bass = getNormBassAt(t);

        // Only on strong musical moments in energetic sections
        if (energy < 0.5 || sec.type === SEC.BREAK || sec.type === SEC.INTRO || sec.type === SEC.OUTRO) continue;
        if (bass < 0.4 && energy < 0.6) continue; // Need bass hit or high energy

        // Only on downbeats (whole beats)
        if (Math.abs(curr.b - Math.round(curr.b)) > 0.15) continue;

        const headX = curr.x, headY = curr.y, headDir = curr.d;
        let tailX = headX, tailY = headY;
        const chainDur = Math.min(gap * 0.5, 0.75);
        const tailBeat = curr.b + chainDur;

        // Tail follows cut direction
        if (IS_DOWN.includes(headDir)) tailY = Math.max(0, headY - 1);
        else if (IS_UP.includes(headDir)) tailY = Math.min(2, headY + 1);
        if (IS_LEFT.includes(headDir)) tailX = Math.max(0, headX - 1);
        else if (IS_RIGHT.includes(headDir)) tailX = Math.min(3, headX + 1);

        if (tailBeat >= next.b - 0.2) continue;

        const sliceCount = Math.max(3, Math.min(6, Math.floor(energy * 5)));

        chains.push({
          b: curr.b, c: color, x: headX, y: headY, d: headDir,
          tb: rb(tailBeat), tx: tailX, ty: tailY,
          sc: sliceCount, s: rb(chainDur / sliceCount),
        });
        lastChainBeat = curr.b;
      }
    }
    return chains;
  }

  // ---- BOMBS (BSMG-compliant) ----
  // BSMG rules: no face bombs (center columns middle row), bombs must be visible
  // (not in dark sections), placed for hand separation or parity resets
  function generateBombs(notes, bpm, settings, totalBeats) {
    const bombs = [];
    if (settings.bombRate <= 0) return bombs;

    for (let beat = 4; beat < totalBeats - 2; beat += 3) {
      if (Math.random() > settings.bombRate) continue;
      const sec = getSectionAt(beatToTime(beat, bpm));
      // BSMG: bombs hard to see in dark sections
      if (sec.type === SEC.BREAK || sec.type === SEC.INTRO || sec.type === SEC.OUTRO) continue;
      // Only place near notes (for hand separation purpose)
      const nearNotes = notes.filter(n => Math.abs(n.b - beat) < 1);
      if (nearNotes.length < 1) continue;

      // Place bomb at bottom row between the hands (for reset/separation)
      // BSMG: bottom row bombs force hands away — preferred reset method
      const bx = Math.random() > 0.5 ? 1 : 2;
      const by = 0; // Bottom row — safest, most visible, BSMG-preferred for resets

      // Check no notes overlap within 1 beat at same position
      if (notes.some(n => Math.abs(n.b - beat) < 1 && n.x === bx && n.y === by)) continue;
      // Avoid face bomb positions (center columns, middle row)
      // Already safe since by=0, but double check
      if (bx >= 1 && bx <= 2 && by === 1) continue;

      bombs.push({ b: beat, x: bx, y: by });
    }
    return bombs;
  }

  // ---- WALLS (v3.3.0 compliant, BSMG-safe, style-aware) ----
  // v3.3.0 obstacles: {b, x, y, d, w, h}
  // x: column (0-3), y: row (0-2), d: duration in beats, w: width in columns, h: height in rows
  // BSMG rules: no center face walls, no danger dash, no rapid dodge, no disembodied notes
  function generateWalls(notes, bpm, settings, totalBeats) {
    const walls = [];
    if (settings.wallDens <= 0) return walls;
    let lastWallEnd = -10;
    let lastWallSide = -1;
    const isFitness = settings.style === "fitness";

    for (let beat = 3; beat < totalBeats - 3; beat += (isFitness ? 2 : 4)) {
      if (Math.random() > settings.wallDens) continue;
      const t = beatToTime(beat, bpm);
      const sec = getSectionAt(t);
      const energy = getEnergyAtTime(t);
      if (energy < 0.2 || sec.type === SEC.BREAK || sec.type === SEC.INTRO || sec.type === SEC.OUTRO) continue;

      // Minimum gap — no rapid dodge
      const minGap = isFitness ? 1.5 : 3;
      if (beat - lastWallEnd < minGap) continue;

      // Duration clamped to 0.5-2 beats
      const dur = Math.max(0.5, Math.min(2, isFitness ? (0.5 + Math.random() * 0.75) : (0.75 + Math.random())));

      // Check area is free of notes (with buffer)
      const hasNoteAt = (x, b, d) => notes.some(n => n.b >= b - 0.25 && n.b <= b + d + 0.25 && n.x === x);

      if (isFitness) {
        const roll = Math.random();

        if (roll < 0.4) {
          // SIDE DODGE — single column, full height, alternating sides
          const side = lastWallSide === 0 ? 3 : 0; // Alternate sides
          if (hasNoteAt(side, beat, dur)) continue;
          walls.push({ b: beat, x: side, y: 0, d: rb(dur), w: 1, h: 5 });
          lastWallEnd = beat + dur;
          lastWallSide = side;

        } else if (roll < 0.6) {
          // CROUCH WALL — single column at far edge, top row only, SHORT
          // BSMG: never block center (columns 1-2) with crouch walls
          const side = Math.random() > 0.5 ? 0 : 3;
          if (hasNoteAt(side, beat, 0.5) || notes.some(n => n.b >= beat - 0.25 && n.b <= beat + 0.75 && n.y === 2)) continue;
          walls.push({ b: beat, x: side, y: 2, d: rb(0.5), w: 1, h: 1 });
          lastWallEnd = beat + 0.5;

        } else if (roll < 0.8) {
          // ALTERNATING DODGE — left wall then right wall
          const s1 = lastWallSide === 0 ? 3 : 0;
          const s2 = s1 === 0 ? 3 : 0;
          if (hasNoteAt(s1, beat, 0.75) || hasNoteAt(s2, beat + 1.5, 0.75)) continue;
          walls.push({ b: beat, x: s1, y: 0, d: rb(0.75), w: 1, h: 5 });
          walls.push({ b: beat + 1.5, x: s2, y: 0, d: rb(0.75), w: 1, h: 5 });
          lastWallEnd = beat + 2.25;
          lastWallSide = s2;
          beat += 1;

        } else {
          // SHORT JAB — quick side wall
          const side = lastWallSide === 0 ? 3 : 0;
          if (hasNoteAt(side, beat, 0.5)) continue;
          walls.push({ b: beat, x: side, y: 0, d: rb(0.5), w: 1, h: 5 });
          lastWallEnd = beat + 0.5;
          lastWallSide = side;
        }

      } else {
        // STANDARD — side walls only, edge columns, music-synced
        const side = lastWallSide === 0 ? 3 : 0; // Alternate sides
        if (hasNoteAt(side, beat, dur)) continue;

        // Only place on beats with energy
        if (energy < 0.35) continue;

        walls.push({ b: beat, x: side, y: 0, d: rb(Math.min(dur, totalBeats - beat - 1)), w: 1, h: 5 });
        lastWallEnd = beat + dur;
        lastWallSide = side;
      }
    }
    return walls;
  }

  // ============================================================
  // SECTION E — LIGHTING ENGINE (SPECTRAL, LAYERED, SECTION-AWARE)
  // ============================================================

  function generateLighting(bpm, totalBeats) {
    const spb = 60 / bpm;
    const us = getUserSettings();
    const intensity = Math.max(0.5, us.lightIntensity / 100);
    // Event types per official Beat Saber docs
    // 0-4, 6-7, 10-11 = Light groups | 5 = Color Boost | 8-9 = Value/Trigger | 12-13 = Value
    const ET = {
      BACK: 0, RING: 1, LEFT: 2, RIGHT: 3, CENTER: 4,
      BOOST: 5, // Color Boost (toggle between color pairs)
      EXTRA1: 6, EXTRA2: 7, // Extra light groups (env-specific)
      RSPIN: 8, RZOOM: 9, // Ring spin trigger, ring zoom trigger
      EXTRA3: 10, EXTRA4: 11, // Extra light groups
      LSPD: 12, RSPD: 13, // Laser speed (left/right)
    };

    // Light event values per official docs
    // 0=Off | 1-4=Secondary(blue) | 5-8=Primary(red) | 9-12=White
    const V = {
      OFF: 0,
      // Secondary color (blue by default)
      B_ON: 1, B_FL: 2, B_FD: 3, B_TR: 4,   // Static, Flash, Fade, Transition
      // Primary color (red by default)
      R_ON: 5, R_FL: 6, R_FD: 7, R_TR: 8,   // Static, Flash, Fade, Transition
      // White
      W_ON: 9, W_FL: 10, W_FD: 11, W_TR: 12, // Static, Flash, Fade, Transition
    };

    // EVENT MAP — key is "beat_eventType", only ONE event per key (last write wins)
    // This prevents flickering from conflicting events at the same beat
    const eventMap = new Map();
    let patternSeed = Math.floor(Math.random() * 4);
    let colorScheme = us.colorPref === "auto" ? "blue" : us.colorPref;
    const lightStyle = us.lightStyle || "dynamic";
    // Minimal mode reduces event density, smooth avoids flashes, strobe maximizes them
    const stepSize = lightStyle === "minimal" ? 1.0 : 0.5;
    const useFlash = lightStyle !== "smooth";
    // In smooth mode: convert flashes to smooth transitions (value 4/8/12)
    // Transitions fade from current state — much smoother than instant ON
    const flashVal = (baseVal) => {
      if (useFlash) return baseVal;
      // Map Flash → Transition, Fade → Transition, leave ON/OFF unchanged
      switch (baseVal) {
        case V.R_FL: case V.R_FD: return V.R_TR;
        case V.B_FL: case V.B_FD: return V.B_TR;
        case V.W_FL: case V.W_FD: return V.W_TR;
        default: return baseVal;
      }
    };
    const colorVal = (blue, red, white) => {
      if (us.colorPref === "blue") return blue;
      if (us.colorPref === "red") return red;
      if (us.colorPref === "white") return white || blue;
      return blue; // auto
    };

    function ev(beat, et, val, f) {
      // Apply smooth mode — convert flashes/fades to transitions
      const actualVal = flashVal(val);
      const rawF = f * intensity;
      const finalF = actualVal === 0 ? 0 : Math.max(0.15, Math.min(1, rawF));
      const key = rb(beat) + "_" + et;
      eventMap.set(key, { b: rb(beat), et, i: actualVal, f: finalF });
    }

    // Startup — lights on from beat 0
    ev(0, ET.BACK, V.B_ON, 0.3);
    ev(0, ET.CENTER, V.B_ON, 0.2);
    ev(0, ET.RING, V.B_ON, 0.15);
    ev(0, ET.LSPD, 1, 1);
    ev(0, ET.RSPD, 1, 1);

    for (let beat = 0; beat < totalBeats; beat += stepSize) {
      const t = beatToTime(beat, bpm);
      if (t > state.audioDuration) break;
      const sec = getSectionAt(t);
      const e = getEnergyAtTime(t);
      const bass = getNormBassAt(t), mid = getNormMidAt(t), high = getNormHighAt(t);
      const isWhole = Math.abs(beat % 1) < 0.01;
      const isDown = Math.abs(beat % 4) < 0.01;
      const bar = Math.floor(beat / 4);

      if (Math.abs(beat % 32) < 0.01) patternSeed = (patternSeed + 1) % 4;

      // ======== BASE LAYER — ambient per section (runs always) ========
      if (sec.type === SEC.INTRO) {
        const pr = Math.min(1, (t - sec.startTime) / Math.max(1, sec.endTime - sec.startTime));
        if (isWhole) {
          ev(beat, ET.BACK, V.B_ON, 0.15 + pr * 0.25);
          ev(beat, ET.CENTER, V.B_FD, 0.1 + pr * 0.15);
          if (pr > 0.3) ev(beat, ET.RING, V.B_ON, pr * 0.2);
          if (pr > 0.5) ev(beat, bar % 2 === 0 ? ET.LEFT : ET.RIGHT, V.B_FD, pr * 0.15);
        }
      }
      else if (sec.type === SEC.VERSE) {
        if (isWhole) {
          ev(beat, ET.BACK, V.B_ON, 0.3);
          ev(beat, ET.CENTER, mid > 0.4 ? V.B_FL : V.B_FD, 0.25);
          const breathPhase = Math.sin(beat * Math.PI / 4) * 0.5 + 0.5;
          ev(beat, ET.RING, V.B_ON, breathPhase * 0.25);
          if (bar % 2 === 0) ev(beat, ET.LEFT, V.B_FD, 0.15);
          else ev(beat, ET.RIGHT, V.B_FD, 0.15);
        }
      }
      else if (sec.type === SEC.BUILDUP) {
        const pr = Math.min(1, (t - sec.startTime) / Math.max(1, sec.endTime - sec.startTime));
        if (isWhole) {
          ev(beat, ET.CENTER, pr > 0.6 ? V.W_FL : V.B_FL, pr * 0.8);
          ev(beat, ET.BACK, V.B_FL, pr * 0.6);
          ev(beat, ET.RING, V.B_ON, pr * 0.5);
          ev(beat, ET.RSPIN, V.B_ON, pr);
          ev(beat, ET.LSPD, Math.floor(pr * 7), 1);
          ev(beat, ET.RSPD, Math.floor(pr * 7), 1);
          if (pr > 0.5) {
            ev(beat, ET.LEFT, V.B_FL, pr * 0.5);
            ev(beat, ET.RIGHT, V.B_FL, pr * 0.5);
          }
        }
        // Heartbeat at peak
        if (pr > 0.8 && isWhole) {
          ev(beat, ET.CENTER, V.R_FL, 1);
        }
      }
      else if (sec.type === SEC.DROP) {
        if (isWhole) {
          // Laser speeds maxed
          ev(beat, ET.LSPD, 5 + (patternSeed % 3), 1);
          ev(beat, ET.RSPD, 4 + (patternSeed % 3), 1);
          ev(beat, ET.RSPIN, V.B_ON, 1);
        }
        // Energy-driven — different patterns per patternSeed
        if (patternSeed < 2) {
          // SWEEP PATTERN — light travels across groups
          if (isWhole) {
            const phase = Math.floor(beat) % 4;
            const groups = [ET.LEFT, ET.CENTER, ET.RIGHT, ET.BACK];
            const flashColor = bass > 0.5 ? V.R_FL : V.B_FL;
            ev(beat, groups[phase], flashColor, 1.0);
            ev(beat, groups[(phase + 2) % 4], V.B_FD, 0.3);
            ev(beat, ET.RING, flashColor, 0.8);
          }
        } else {
          // PULSE PATTERN — all lights pulse together on beats
          if (isWhole) {
            const pulseColor = beat % 2 < 1 ? V.R_FL : V.B_FL;
            ev(beat, ET.BACK, pulseColor, 0.9);
            ev(beat, ET.CENTER, pulseColor, 1.0);
            ev(beat, ET.LEFT, bass > 0.5 ? V.R_FL : V.B_ON, 0.7);
            ev(beat, ET.RIGHT, bass > 0.5 ? V.R_FL : V.B_ON, 0.7);
            ev(beat, ET.RING, pulseColor, 0.8);
          }
        }
        // Bass emphasis
        if (isWhole && bass > 0.6) {
          ev(beat, ET.RZOOM, V.R_ON, 1);
        }
      }
      else if (sec.type === SEC.CHORUS) {
        if (isWhole) {
          ev(beat, ET.LSPD, 3 + (patternSeed % 3), 1);
          ev(beat, ET.RSPD, 2 + (patternSeed % 3), 1);
        }
        if (patternSeed < 2) {
          // MIRROR PATTERN — left and right alternate colors
          if (isWhole) {
            const c1 = beat % 2 < 1 ? V.B_FL : V.R_FL;
            const c2 = beat % 2 < 1 ? V.R_FL : V.B_FL;
            ev(beat, ET.LEFT, c1, 0.8);
            ev(beat, ET.RIGHT, c2, 0.8);
            ev(beat, ET.CENTER, c1, 0.9);
            ev(beat, ET.BACK, c2, 0.6);
            ev(beat, ET.RING, c1, 0.7);
          }
        } else {
          // CHASER — light moves left→center→right→back across 1 beat
          if (isWhole) {
            ev(beat, ET.LEFT, V.B_FL, 0.9);
            ev(beat, ET.CENTER, V.B_FD, 0.3);
            ev(beat, ET.RIGHT, V.B_FD, 0.2);
          }
          if (isWhole && beat % 1 > 0.4) {
            // Second half-beat chaser continuation
          }
        }
        // Rainbow ring on downbeats
        if (isDown) {
          const rainbow = [V.B_FL, V.R_FL, V.W_FL];
          ev(beat, ET.RING, rainbow[Math.floor(beat / 4) % 3], 0.8);
        }
      }
      else if (sec.type === SEC.BREAK) {
        if (isWhole) {
          ev(beat, ET.CENTER, V.B_FD, 0.12);
          ev(beat, ET.BACK, V.OFF, 0);
          ev(beat, ET.LEFT, V.OFF, 0);
          ev(beat, ET.RIGHT, V.OFF, 0);
          ev(beat, ET.LSPD, 0, 1);
          ev(beat, ET.RSPD, 0, 1);
        }
        if (isWhole && mid > 0.4 && Math.random() < 0.25) {
          ev(beat, ET.CENTER, V.B_FL, 0.25);
        }
      }
      else if (sec.type === SEC.OUTRO) {
        const pr = Math.min(1, (t - sec.startTime) / Math.max(1, sec.endTime - sec.startTime));
        const dim = Math.max(0, 1 - pr);
        if (isWhole) {
          ev(beat, ET.BACK, V.B_FD, dim * 0.3);
          ev(beat, ET.CENTER, V.B_FD, dim * 0.2);
          ev(beat, ET.RING, V.B_FD, dim * 0.15);
          ev(beat, ET.LSPD, Math.max(0, Math.floor(dim * 2)), 1);
          ev(beat, ET.RSPD, Math.max(0, Math.floor(dim * 2)), 1);
        }
      }

      // ======== SPECTRAL ACCENT LAYER — only on half-beats, only if no section override ========
      // These use beat+0.25 offset to avoid conflicting with section events at whole beats
      if (!isWhole && bass > 0.5 && sec.type !== SEC.BREAK && sec.type !== SEC.OUTRO) {
        ev(beat, ET.BACK, bass > 0.7 ? V.R_FL : V.B_FL, bass * 0.7);
      }
      if (!isWhole && high > 0.5 && sec.type !== SEC.BREAK) {
        const side = patternSeed < 2 ? (beat % 1 < 0.5 ? ET.LEFT : ET.RIGHT) : (beat % 1 < 0.5 ? ET.RIGHT : ET.LEFT);
        ev(beat, side, V.W_FD, high * 0.5);
      }

      // ======== PHRASE BOUNDARY — color swap (overrides everything) ========
      const isPhr = state.phrases.some(p => Math.abs(p.time - t) < spb * 0.5);
      if (isPhr && isWhole) {
        colorScheme = colorScheme === "blue" ? "red" : "blue";
        const bv = colorScheme === "red" ? V.R_FL : V.B_FL;
        ev(beat, ET.BACK, bv, 1.0);
        ev(beat, ET.CENTER, bv, 1.0);
        ev(beat, ET.LEFT, bv, 0.9);
        ev(beat, ET.RIGHT, bv, 0.9);
        ev(beat, ET.RING, bv, 0.8);
        eventMap.set(rb(beat) + "_" + ET.BOOST, { b: rb(beat), et: ET.BOOST, i: colorScheme === "red" ? 1 : 0, f: 1 });
        patternSeed = (patternSeed + 1) % 4;
      }

      // ======== SECTION TRANSITION — boost color swaps ========
      for (const s of state.sections) {
        if (Math.abs(t - s.startTime) < spb * 0.5 && isWhole) {
          if (s.type === SEC.DROP) {
            // Blackout → explosion
            ev(Math.max(0, beat - 0.5), ET.BACK, V.OFF, 0);
            ev(Math.max(0, beat - 0.5), ET.CENTER, V.OFF, 0);
            ev(beat, ET.BACK, V.R_FL, 1);
            ev(beat, ET.CENTER, V.R_FL, 1);
            ev(beat, ET.LEFT, V.R_FL, 1);
            ev(beat, ET.RIGHT, V.R_FL, 1);
            ev(beat, ET.RING, V.R_FL, 1);
            ev(beat, ET.RZOOM, V.R_ON, 1);
            eventMap.set(rb(beat) + "_" + ET.BOOST, { b: rb(beat), et: ET.BOOST, i: 1, f: 1 });
          }
          if (s.type === SEC.CHORUS) {
            eventMap.set(rb(beat) + "_" + ET.BOOST, { b: rb(beat), et: ET.BOOST, i: 1, f: 1 });
          }
          if (s.type === SEC.VERSE || s.type === SEC.BREAK) {
            eventMap.set(rb(beat) + "_" + ET.BOOST, { b: rb(beat), et: ET.BOOST, i: 0, f: 1 });
          }
        }
      }
    }

    // ======== END-OF-SONG FADE ========
    const fadeStart = Math.max(2, totalBeats - 4);
    // Remove events in fade zone
    for (const [key, ev] of eventMap) {
      if (ev.b >= fadeStart && ev.et !== ET.BOOST) eventMap.delete(key);
    }
    for (let fb = fadeStart; fb < totalBeats; fb += 0.5) {
      const pr = (fb - fadeStart) / Math.max(1, totalBeats - fadeStart);
      const dim = Math.max(0, (1 - pr) * intensity);
      [ET.BACK, ET.CENTER, ET.LEFT, ET.RIGHT, ET.RING].forEach(et => {
        ev(fb, et, dim > 0.1 ? V.B_FD : V.OFF, dim * 0.4);
      });
      ev(fb, ET.LSPD, Math.max(0, Math.floor((1 - pr) * 2)), 1);
      ev(fb, ET.RSPD, Math.max(0, Math.floor((1 - pr) * 2)), 1);
    }
    // Final blackout
    [ET.BACK, ET.CENTER, ET.LEFT, ET.RIGHT, ET.RING].forEach(et => {
      ev(totalBeats - 0.25, et, V.OFF, 0);
    });

    // ======== FLATTEN MAP → SORTED ARRAY ========
    const events = Array.from(eventMap.values());
    events.sort((a, b) => a.b - b.b);

    // Ensure minimum event count with structured events
    if (events.length < MIN_LIGHTING_EVENTS) {
      for (let fb = 0; fb < totalBeats && events.length < MIN_LIGHTING_EVENTS; fb += 1) {
        const fe = getEnergyAtTime(beatToTime(fb, bpm));
        if (fe > 0.1) {
          events.push({ b: fb, et: ET.BACK, i: V.B_ON, f: Math.max(0.2, fe * 0.5) });
          events.push({ b: fb, et: ET.CENTER, i: fe > 0.5 ? V.B_FL : V.B_FD, f: Math.max(0.15, fe * 0.4) });
        }
      }
      events.sort((a, b) => a.b - b.b);
    }

    return events;
  }

  // ============================================================
  // SECTION F — RANKED VALIDATION
  // ============================================================

  function computeRankScores(diffData) {
    const { notes, arcs, chains, bombs, walls, lighting } = diffData;
    const flow = computeFlowScore(notes), parity = computeParityScore(notes), tech = computeTechScore(notes, arcs, chains);
    const lightSync = Math.min(10, (lighting.length / (MIN_LIGHTING_EVENTS * 3)) * 10);
    const wallC = computeWallComfort(walls, notes), read = computeReadability(notes);
    const viol = countViolations(notes, bombs, walls);
    const rank = Math.max(0, Math.min(10, 2.5 * (flow / 10) + 2.0 * (parity / 10) + 2.0 * (tech / 10) + 1.5 * (lightSync / 10) + 1.0 * (read / 10) - 3.0 * (viol / Math.max(1, notes.length))));
    return { flow, parity, tech, lightingSync: lightSync, wallComfort: wallC, readability: read, violations: viol, rankScore: rank, passed: rank >= RANKED_THRESHOLD };
  }

  function computeFlowScore(notes) {
    if (notes.length < 2) return 5;
    let good = 0, total = 0;
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      for (let i = 1; i < hand.length; i++) {
        total++;
        if (hand[i].b - hand[i - 1].b >= 2) { good++; continue; }
        if ((IS_DOWN.includes(hand[i - 1].d) && IS_UP.includes(hand[i].d)) || (IS_UP.includes(hand[i - 1].d) && IS_DOWN.includes(hand[i].d))) good++;
      }
    }
    return total > 0 ? (good / total) * 10 : 5;
  }

  function computeParityScore(notes) {
    if (notes.length < 2) return 10;
    let viol = 0, total = 0;
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      for (let i = 1; i < hand.length; i++) {
        total++;
        if (hand[i].b - hand[i - 1].b < 1.5) {
          if ((IS_DOWN.includes(hand[i - 1].d) && IS_DOWN.includes(hand[i].d)) || (IS_UP.includes(hand[i - 1].d) && IS_UP.includes(hand[i].d))) viol++;
        }
      }
    }
    return total > 0 ? Math.max(0, (1 - viol / total) * 10) : 10;
  }

  function computeTechScore(notes, arcs, chains) {
    const dirs = new Set(notes.map(n => n.d));
    const dv = dirs.size / 9;
    const ab = Math.min(1, arcs.length / Math.max(1, notes.length * 0.05));
    const cb = Math.min(1, chains.length / Math.max(1, notes.length * 0.02));
    const db = Math.min(1, countDoubles(notes) / Math.max(1, notes.length * 0.02));
    return Math.min(10, dv * 4 + ab * 2.5 + cb * 1.5 + db * 2);
  }

  function countDoubles(notes) {
    let c = 0;
    for (let i = 0; i < notes.length - 1; i++) { if (Math.abs(notes[i + 1].b - notes[i].b) < 0.01 && notes[i].c !== notes[i + 1].c) c++; }
    return c;
  }

  function computeWallComfort(walls, notes) {
    if (walls.length === 0) return 9;
    let issues = 0;
    for (const w of walls) {
      if (notes.some(n => n.b >= w.b && n.b <= w.b + w.d && n.x === w.x)) issues++;
      if (w.h >= 3 && w.w >= 3) issues++;
    }
    return Math.max(0, 10 - issues * 2);
  }

  function computeReadability(notes) {
    if (notes.length < 2) return 10;
    let bad = 0;
    for (let i = 1; i < notes.length; i++) { if (notes[i].b - notes[i - 1].b < 0.08 && notes[i].c === notes[i - 1].c) bad++; }
    return Math.max(0, 10 - (bad / notes.length) * 30);
  }

  function countViolations(notes, bombs, walls) {
    let v = 0;
    for (const b of bombs) { for (const n of notes) { if (Math.abs(n.b - b.b) < 0.25 && n.x === b.x && n.y === b.y) v++; } }
    for (const w of walls) { if ((w.x === 1 || w.x === 2) && w.h >= 2) v++; }
    return v;
  }

  // ============================================================
  // MACHINE LEARNING FEEDBACK LOOP
  // Learns from generated maps to improve future generations.
  // Tracks quality metrics per generation, adjusts internal
  // weights for pattern selection, and re-generates if quality
  // is below threshold.
  // ============================================================

  // Persistent weight storage (survives across generations within session)
  const mlWeights = {
    // Position learning
    preferHomeColumn: 0.6,
    movementRange: 0.4,

    // Pattern preference multipliers — ML adjusts these based on quality
    patPrefs: {
      double: 1.0, stream: 1.0, gallop: 1.0, combo: 1.0,
      single: 1.0, window: 1.0, half: 1.0,
    },

    // Onset sync target — how well notes should align to music
    onsetSyncTarget: 0.6,

    // Density adjustment — learned from comfort feedback
    densityMul: 1.0,

    // Generation tracking
    generationCount: 0,
    history: [],
    bestComfort: 0,
    bestSync: 0,
  };

  // Deep quality analysis
  function analyzeMapQuality(notes, bpm) {
    const quality = {
      parityViolations: 0, visionBlocks: 0, handclaps: 0,
      skyStreams: 0, armCrossings: 0, angleBreaks: 0,
      flowScore: 0, comfortScore: 0, spacingScore: 0,
      handBalance: 0, totalNotes: notes.length,
      clutterScore: 10, emphasisScore: 10, rowDistScore: 10,
      onsetSync: 0,
    };

    if (notes.length < 2) return quality;

    // Parity violations + angle breaks
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      for (let i = 1; i < hand.length; i++) {
        const prev = hand[i - 1], curr = hand[i], gap = curr.b - prev.b;
        if (gap < 2.0) {
          if ((IS_DOWN.includes(prev.d) && IS_DOWN.includes(curr.d)) ||
              (IS_UP.includes(prev.d) && IS_UP.includes(curr.d))) {
            quality.parityViolations++;
          }
          const angle = angleDiff(DIR_ANGLE[prev.d], DIR_ANGLE[curr.d]);
          if (angle < 90) quality.angleBreaks++;
        }
      }
    }

    // Vision blocks
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if ((n.x === 1 || n.x === 2) && n.y === 1) {
        if (notes.some(m => m.b > n.b && m.b < n.b + 1.5 && m !== n)) quality.visionBlocks++;
      }
    }

    // Handclaps
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].c === notes[j].c) continue;
        const a = notes[i], b = notes[j];
        if (a.y === b.y && Math.abs(a.x - b.x) <= 1) {
          if ((IS_RIGHT.includes(a.d) && IS_LEFT.includes(b.d)) ||
              (IS_LEFT.includes(a.d) && IS_RIGHT.includes(b.d))) quality.handclaps++;
        }
      }
    }

    // Arm crossings
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].c === C.RED && notes[j].c === C.BLUE && notes[i].x > notes[j].x + 1) quality.armCrossings++;
      }
    }

    // Sky streams
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      let topRun = 0;
      for (const n of hand) {
        if (n.y === 2) { topRun++; if (topRun > 3) quality.skyStreams++; }
        else topRun = 0;
      }
    }

    // Hand balance
    const redCount = notes.filter(n => n.c === C.RED).length;
    const blueCount = notes.filter(n => n.c === C.BLUE).length;
    quality.handBalance = Math.min(redCount, blueCount) / Math.max(1, Math.max(redCount, blueCount));

    // Spacing score
    let spacingVariance = 0;
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      if (hand.length < 3) continue;
      const gaps = [];
      for (let i = 1; i < hand.length; i++) gaps.push(hand[i].b - hand[i - 1].b);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      spacingVariance += gaps.reduce((s, g) => s + Math.abs(g - avgGap), 0) / gaps.length;
    }
    quality.spacingScore = Math.max(0, 10 - spacingVariance * 3);

    // Clutter
    let clutterPenalty = 0;
    for (let i = 0; i < notes.length; i++) {
      let nearby = 0;
      for (let j = i + 1; j < notes.length && notes[j].b - notes[i].b < 0.5; j++) nearby++;
      if (nearby > 4) clutterPenalty++;
    }
    quality.clutterScore = Math.max(0, 10 - (clutterPenalty / Math.max(1, notes.length)) * 50);

    // Emphasis consistency
    let emphasisInconsistency = 0;
    const doubleBeats = [];
    for (let i = 0; i < notes.length - 1; i++) {
      if (Math.abs(notes[i + 1].b - notes[i].b) < 0.01 && notes[i].c !== notes[i + 1].c) doubleBeats.push(notes[i].b);
    }
    if (doubleBeats.length > 2) {
      const doubleEnergies = doubleBeats.map(b => getEnergyAtTime(beatToTime(b, bpm)));
      const avgDE = doubleEnergies.reduce((a, b) => a + b, 0) / doubleEnergies.length;
      for (const de of doubleEnergies) { if (de < avgDE * 0.5) emphasisInconsistency++; }
    }
    quality.emphasisScore = Math.max(0, 10 - emphasisInconsistency * 2);

    // Row distribution
    const rowCounts = [0, 0, 0];
    notes.forEach(n => { if (n.y >= 0 && n.y <= 2) rowCounts[n.y]++; });
    const topPct = rowCounts[2] / Math.max(1, notes.length);
    quality.rowDistScore = Math.max(0, 10 - (topPct > 0.25 ? (topPct - 0.25) * 30 : 0));

    // Flow score
    let goodFlow = 0, totalFlow = 0;
    for (let c = 0; c <= 1; c++) {
      const hand = notes.filter(n => n.c === c);
      for (let i = 1; i < hand.length; i++) {
        totalFlow++;
        if (angleDiff(DIR_ANGLE[hand[i - 1].d], DIR_ANGLE[hand[i].d]) >= 90) goodFlow++;
      }
    }
    quality.flowScore = totalFlow > 0 ? (goodFlow / totalFlow) * 10 : 5;

    // Onset sync — how many notes align with actual musical onsets
    let synced = 0;
    for (const n of notes) {
      const t = beatToTime(n.b, bpm);
      if (state.onsets.some(o => Math.abs(o - t) < 0.1)) synced++;
    }
    quality.onsetSync = notes.length > 0 ? synced / notes.length : 0;

    // Composite comfort
    const total = Math.max(1, notes.length);
    quality.comfortScore = Math.max(0, 10
      - (quality.parityViolations / total) * 30
      - (quality.angleBreaks / total) * 20
      - (quality.visionBlocks / total) * 15
      - (quality.handclaps * 5)
      - (quality.armCrossings / total) * 10
      - (quality.skyStreams * 2)
      - (10 - quality.clutterScore) * 0.3
      - (10 - quality.emphasisScore) * 0.2
      - (10 - quality.rowDistScore) * 0.2
      + (quality.onsetSync * 2) // Bonus for onset sync
    );

    return quality;
  }

  // ML Learning — adjusts weights based on quality analysis
  function mlLearn(quality, diffName) {
    const lr = Math.max(0.05, 0.3 / (1 + mlWeights.generationCount * 0.1));
    const score = (quality.flowScore + quality.comfortScore + quality.spacingScore) / 30;

    // Position learning
    if (quality.parityViolations > 0) mlWeights.preferHomeColumn = Math.min(0.9, mlWeights.preferHomeColumn + lr * 0.3);
    if (quality.armCrossings > 0) mlWeights.movementRange = Math.max(0.2, mlWeights.movementRange - lr * 0.15);
    if (quality.rowDistScore < 7) mlWeights.movementRange = Math.max(0.2, mlWeights.movementRange - lr * 0.1);

    // Unlock movement if quality is high
    if (score > 0.75 && quality.armCrossings === 0) {
      mlWeights.movementRange = Math.min(0.7, mlWeights.movementRange + lr * 0.03);
      mlWeights.preferHomeColumn = Math.max(0.35, mlWeights.preferHomeColumn - lr * 0.03);
    }

    // Pattern preference learning
    if (quality.comfortScore > 8) {
      // Good comfort — slightly boost complex patterns
      mlWeights.patPrefs.stream = Math.min(1.3, mlWeights.patPrefs.stream + lr * 0.05);
      mlWeights.patPrefs.window = Math.min(1.3, mlWeights.patPrefs.window + lr * 0.05);
    } else if (quality.comfortScore < 5) {
      // Bad comfort — reduce complex patterns
      mlWeights.patPrefs.stream = Math.max(0.5, mlWeights.patPrefs.stream - lr * 0.1);
      mlWeights.patPrefs.combo = Math.max(0.5, mlWeights.patPrefs.combo - lr * 0.1);
      mlWeights.patPrefs.single = Math.min(1.5, mlWeights.patPrefs.single + lr * 0.1);
    }

    // Density learning
    if (quality.clutterScore < 6) {
      mlWeights.densityMul = Math.max(0.6, mlWeights.densityMul - lr * 0.1);
    } else if (quality.clutterScore > 9 && score > 0.6) {
      mlWeights.densityMul = Math.min(1.3, mlWeights.densityMul + lr * 0.03);
    }

    // Onset sync learning
    if (quality.onsetSync > mlWeights.bestSync) mlWeights.bestSync = quality.onsetSync;

    // Track best scores
    if (quality.comfortScore > mlWeights.bestComfort) mlWeights.bestComfort = quality.comfortScore;

    // History
    mlWeights.history.push({ diff: diffName, score, comfort: quality.comfortScore, sync: quality.onsetSync });
    if (mlWeights.history.length > 30) mlWeights.history.shift();
    mlWeights.generationCount++;

    logGen(0, "pattern", "ML[" + mlWeights.generationCount + "]: comfort=" + quality.comfortScore.toFixed(1) +
      " sync=" + (quality.onsetSync * 100).toFixed(0) + "%" +
      " home=" + mlWeights.preferHomeColumn.toFixed(2) +
      " density=" + mlWeights.densityMul.toFixed(2));
  }

  function getMLPositionBias() {
    return {
      homeStrength: mlWeights.preferHomeColumn,
      moveRange: mlWeights.movementRange,
      densityMul: mlWeights.densityMul,
    };
  }

  // ============================================================
  // SECTION G — FORMAT BUILDERS
  // ============================================================

  function getCoverFilename() {
    // Always JPEG — we convert all input formats to JPEG via canvas
    return "cover.jpg";
  }

  function buildInfoDat(diffs) {
    // Deduplicate by name and sort by rank
    const seen = new Set();
    const unique = diffs.filter(d => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });
    const sorted = [...unique].sort((a, b) => diffRank(a.name) - diffRank(b.name));
    const envName = ($("#cfg-environment") || {}).value || "DefaultEnvironment";

    // V3 environments that require environmentVersion: 3
    const V3_ENVS = [
      "WeaveEnvironment", "PyroEnvironment", "EDMEnvironment", "TheSecondEnvironment",
      "LizzoEnvironment", "TheWeekndEnvironment", "RockMixtapeEnvironment",
      "Dragons2Environment", "Panic2Environment", "QueenEnvironment",
      "LinkinPark2Environment", "TheRollingStonesEnvironment", "LatticeEnvironment",
      "DaftPunkEnvironment", "HipHopEnvironment", "ColliderEnvironment", "BritneyEnvironment",
      "Monstercat2Environment", "MetallicaEnvironment", "GridEnvironment", "ColdplayEnvironment",
    ];
    const isV3Env = V3_ENVS.includes(envName);
    const wantChroma = $("#tog-chroma") && $("#tog-chroma").checked;

    const info = {
      _version: "2.1.0",
      _songName: $("#cfg-song-name").value || "Unknown Song",
      _songSubName: "",
      _songAuthorName: $("#cfg-song-author").value || "Unknown Artist",
      _levelAuthorName: $("#cfg-map-author").value || "BeatForge AI",
      _beatsPerMinute: Math.max(60, Math.min(200, state.bpm || 120)), _shuffle: 0, _shufflePeriod: 0.5,
      _previewStartTime: autoDetectPreviewTime(), _previewDuration: 10,
      _songFilename: "song.ogg", _coverImageFilename: getCoverFilename(),
      _environmentName: envName,
      _allDirectionsEnvironmentName: "GlassDesertEnvironment",
      _songTimeOffset: 0,
      // CLEAN customData — NO editor fingerprints, NO AI references
      // Only includes Chroma suggestion if user toggled it on
      _customData: wantChroma ? { _suggestions: ["Chroma"] } : {},
      _difficultyBeatmapSets: [{ _beatmapCharacteristicName: "Standard", _difficultyBeatmaps: sorted.map(d => ({
        _difficulty: d.name === "ExpertPlus" ? "ExpertPlus" : d.name,
        _difficultyRank: diffRank(d.name),
        _beatmapFilename: diffFilename(d.name),
        _noteJumpMovementSpeed: d.data.settings.njs,
        _noteJumpStartBeatOffset: d.data.settings.njsOffset || 0,
        _customData: {},
      })) }],
    };

    // Add environment version for v3 envs
    if (isV3Env) {
      info._environmentVersion = 3;
    }

    return info;
  }

  function diffFilename(n) { return n + "Standard.dat"; }
  function diffRank(n) { return { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 }[n] || 7; }

  function buildDifficultyDat(dd) {
    const { notes, arcs, chains, bombs, walls, lighting, settings } = dd;
    const envName = ($("#cfg-environment") || {}).value || "DefaultEnvironment";
    const V3_ENVS = [
      "WeaveEnvironment", "PyroEnvironment", "EDMEnvironment", "TheSecondEnvironment",
      "LizzoEnvironment", "TheWeekndEnvironment", "RockMixtapeEnvironment",
      "Dragons2Environment", "Panic2Environment", "QueenEnvironment",
      "LinkinPark2Environment", "TheRollingStonesEnvironment", "LatticeEnvironment",
      "DaftPunkEnvironment", "HipHopEnvironment", "ColliderEnvironment", "BritneyEnvironment",
      "Monstercat2Environment", "MetallicaEnvironment", "GridEnvironment", "ColdplayEnvironment",
    ];
    const isV3Env = V3_ENVS.includes(envName);

    // BPM events
    const bpmEvents = [];
    if (state.bpmRegions.length > 1) {
      for (let i = 1; i < state.bpmRegions.length; i++) {
        let regionBeat = 0;
        for (let j = 0; j < i; j++) {
          regionBeat += ((state.bpmRegions[j].endTime - state.bpmRegions[j].startTime) * state.bpmRegions[j].bpm) / 60;
        }
        bpmEvents.push({ b: rb(regionBeat), m: state.bpmRegions[i].bpm });
      }
    }

    // Static events (work for all environments)
    const wantChroma = $("#tog-chroma") && $("#tog-chroma").checked;
    const basicEvents = lighting.filter(ev => ev.et !== 5).map(ev => {
      const base = { b: rb(ev.b), et: ev.et, i: ev.i, f: Math.max(0, parseFloat(ev.f.toFixed(3))) };
      if (wantChroma && ev.i > 0) {
        base._customData = { _color: getChromaColor(ev.i, ev.f, ev.b) };
      }
      return base;
    });
    const boostEvents = lighting.filter(ev => ev.et === 5).map(ev => ({ b: rb(ev.b), o: ev.i === 1 }));

    // GLS events for V3 environments
    let glsColorGroups = [];
    let glsRotationGroups = [];

    if (isV3Env) {
      glsColorGroups = buildGLSColorEvents(lighting);
      glsRotationGroups = buildGLSRotationEvents(lighting);
    }

    return {
      version: SCHEMA_VERSION,
      bpmEvents: bpmEvents,
      rotationEvents: [],
      colorNotes: notes.map(n => ({ b: rb(n.b), x: n.x, y: n.y, c: n.c, d: n.d, a: n.a })),
      bombNotes: bombs.map(bm => ({ b: rb(bm.b), x: bm.x, y: bm.y })),
      obstacles: walls.map(w => ({ b: rb(w.b), x: w.x, y: w.y, d: rb(w.d), w: w.w, h: w.h })),
      sliders: arcs.map(a => ({ b: rb(a.b), c: a.c, x: a.x, y: a.y, d: a.d, mu: a.mu, tb: rb(a.tb), tx: a.tx, ty: a.ty, tc: a.tc, tmu: a.tmu, m: a.m })),
      burstSliders: chains.map(c => ({ b: rb(c.b), c: c.c, x: c.x, y: c.y, d: c.d, tb: rb(c.tb), tx: c.tx, ty: c.ty, sc: c.sc, s: c.s })),
      basicBeatmapEvents: basicEvents,
      colorBoostBeatmapEvents: boostEvents,
      waypoints: [],
      lightColorEventBoxGroups: glsColorGroups,
      lightRotationEventBoxGroups: glsRotationGroups,
      lightTranslationEventBoxGroups: [],
      vfxEventBoxGroups: [],
      _fxEventsCollection: { _fl: [], _il: [] },
      basicEventTypesWithKeywords: { d: [] },
      useNormalEventsAsCompatibleEvents: true,
    };
  }

  // ============================================================
  // ============================================================
  // GLS (Group Lighting System) — v3.3.0 format
  // Per BSMG wiki: https://bsmg.wiki/mapping/map-format/lightshow.html
  //
  // lightColorEventBoxGroups format:
  //   { b: beat, g: groupId, e: [{ f: indexFilter, w, d, r, t, b, i, e: [colorEvents] }] }
  //
  // Index Filter (v3.1.0+):
  //   { c: chunks, f: type, p: param0, t: param1, r: reverse, n: random, s: seed, l: limit%, d: limitBehavior }
  //
  // Light Color Event:
  //   { b: beatOffset, i: transType(0=instant,1=transition,2=extend), c: color(0=red,1=blue,2=white), s: brightness, f: strobeFreq, sb: strobeBright, sf: strobeFade }
  //
  // lightRotationEventBoxGroups format:
  //   { b: beat, g: groupId, e: [{ f: indexFilter, w, d, s, t, b, i, a: axis(0=X,1=Y,2=Z), r: invertAxis, l: [rotEvents] }] }
  //
  // Light Rotation Event:
  //   { b: beatOffset, p: transType(0=transition,1=extend), e: easing, r: magnitude, o: direction(0=auto,1=CW,2=CCW), l: loopCount }
  // ============================================================

  // Standard index filter: select all objects in the group
  function glsFilterAll() {
    return { c: 1, f: 1, p: 0, t: 0, r: 0, n: 0, s: 0, l: 0, d: 0 };
  }

  // Convert a static event value (0-12) to GLS color event data
  function staticToGLS(val, floatVal) {
    if (val === 0) return { c: 0, s: 0, i: 0 }; // Off

    let color, transType;
    const isFlash = [2, 6, 10].includes(val);
    const isFade = [3, 7, 11].includes(val);
    const isTransition = [4, 8, 12].includes(val);

    if (val >= 1 && val <= 4) color = 1;       // Secondary (blue)
    else if (val >= 5 && val <= 8) color = 0;   // Primary (red)
    else if (val >= 9 && val <= 12) color = 2;  // White
    else color = 0;

    // v3 transition types: 0=Instant, 1=Transition (smooth), 2=Extend (hold previous)
    if (isTransition || isFade) transType = 1;
    else transType = 0;

    let brightness = Math.max(0, floatVal);
    if (isFlash) brightness = Math.min(1.5, brightness * 1.37);

    return { c: color, s: brightness, i: transType };
  }

  function buildGLSColorEvents(lighting) {
    const groups = [];
    const ET_TO_GROUP = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 5, 7: 6, 10: 7, 11: 8 };

    // Collect and sort light events by group
    const byGroup = {};
    for (const ev of lighting) {
      if (ev.et === 5 || ev.et >= 8) continue;
      const gid = ET_TO_GROUP[ev.et];
      if (gid === undefined) continue;
      if (!byGroup[gid]) byGroup[gid] = [];
      byGroup[gid].push(ev);
    }

    // For each group, create event box groups in 2-beat windows
    for (const [gid, events] of Object.entries(byGroup)) {
      if (events.length === 0) continue;
      events.sort((a, b) => a.b - b.b);

      // Window events into 2-beat boxes
      let winStart = events[0].b;
      let winEvents = [];

      const flush = () => {
        if (winEvents.length === 0) return;
        const baseBeat = winEvents[0].b;
        const lastBeat = winEvents[winEvents.length - 1].b;

        // Build color events array with beat offsets relative to group start
        const colorEvents = winEvents.map(we => {
          const gls = staticToGLS(we.i, we.f);
          return {
            b: rb(we.b - baseBeat),
            i: gls.i,     // Transition type
            c: gls.c,     // Color
            s: gls.s,     // Brightness
            f: 0,         // Strobe frequency
            sb: 0,        // Strobe brightness
            sf: 0,        // Strobe fade
          };
        });

        groups.push({
          b: rb(baseBeat),
          g: parseInt(gid),
          e: [{
            f: glsFilterAll(),
            w: rb(lastBeat - baseBeat),  // Beat distribution value
            d: 1,          // Wave distribution
            r: 0,          // No brightness distribution offset
            t: 1,          // Wave type
            b: 0,          // Don't affect first
            i: 0,          // Linear easing
            e: colorEvents,
          }],
        });
      };

      for (const ev of events) {
        if (ev.b - winStart >= 2.0 && winEvents.length > 0) {
          flush();
          winStart = ev.b;
          winEvents = [];
        }
        winEvents.push(ev);
      }
      flush();
    }

    groups.sort((a, b) => a.b - b.b);
    return groups;
  }

  function buildGLSRotationEvents(lighting) {
    const groups = [];

    for (const ev of lighting) {
      // Ring spin (et=8) → group 1, Y-axis full rotation
      if (ev.et === 8) {
        groups.push({
          b: rb(ev.b),
          g: 1,
          e: [{
            f: glsFilterAll(),
            w: 0, d: 1, s: 0, t: 1, b: 0, i: 0,
            a: 1,  // Y axis
            r: 0,  // Don't invert
            l: [{
              b: 0,       // Beat offset 0
              p: 0,       // Transition type
              e: 2,       // OutQuad easing
              r: 360,     // Full 360° rotation
              o: 0,       // Auto direction
              l: 0,       // No extra loops
            }],
          }],
        });
      }

      // Ring zoom (et=9) → group 1, X-axis small tilt
      if (ev.et === 9) {
        groups.push({
          b: rb(ev.b),
          g: 1,
          e: [{
            f: glsFilterAll(),
            w: 0, d: 1, s: 0, t: 1, b: 0, i: 0,
            a: 0,  // X axis
            r: 0,
            l: [{
              b: 0, p: 0, e: 3, // InOutQuad
              r: 15,    // 15° tilt
              o: 0, l: 0,
            }],
          }],
        });
      }

      // Laser speed left (et=12) → group 2 continuous rotation
      // Laser speed right (et=13) → group 3 continuous rotation
      if (ev.et === 12 || ev.et === 13) {
        const gid = ev.et === 12 ? 2 : 3;
        const speed = ev.i || 0;
        if (speed > 0) {
          groups.push({
            b: rb(ev.b),
            g: gid,
            e: [{
              f: glsFilterAll(),
              w: 0, d: 1, s: 0, t: 1, b: 0, i: 0,
              a: 1,  // Y axis
              r: ev.et === 13 ? 1 : 0,
              l: [{
                b: 0,
                p: 0,
                e: 0,              // Linear easing
                r: speed * 45,     // Magnitude proportional to speed
                o: ev.et === 12 ? 1 : 2,  // Left=CW, Right=CCW
                l: speed > 3 ? 1 : 0,
              }],
            }],
          });
        }
      }
    }

    groups.sort((a, b) => a.b - b.b);
    return groups;
  }



  function rb(b) { return parseFloat(b.toFixed(4)); }

  // Chroma 2.0 RGB color generator — handles all 13 light event values
  function getChromaColor(eventVal, floatVal, beat) {
    const alpha = Math.max(0.1, Math.min(1.0, floatVal));
    const hueShift = Math.sin(beat * 0.1) * 0.15;

    // Determine color family from official value ranges
    let r, g, b;
    if (eventVal >= 1 && eventVal <= 4) {
      // Secondary (blue family) — cyan-to-blue spectrum
      r = 0.0 + hueShift * 0.5;
      g = 0.5 + hueShift;
      b = 1.0;
    } else if (eventVal >= 5 && eventVal <= 8) {
      // Primary (red family) — red-to-magenta spectrum
      r = 1.0;
      g = 0.1 + Math.abs(hueShift) * 0.3;
      b = 0.2 + hueShift * 0.5;
    } else if (eventVal >= 9 && eventVal <= 12) {
      // White — warm white with temperature shift
      r = 1.0;
      g = 0.95 + hueShift * 0.1;
      b = 0.9 - hueShift * 0.1;
    } else {
      return [1.0, 1.0, 1.0, alpha];
    }

    // Fade/transition values get reduced alpha for smoother effect
    const isFade = eventVal === 3 || eventVal === 7 || eventVal === 11;
    const isTransition = eventVal === 4 || eventVal === 8 || eventVal === 12;
    const finalAlpha = (isFade || isTransition) ? alpha * 0.7 : alpha;

    return [r, g, b, finalAlpha];
  }

  function buildBPMInfoDat() {
    const sr = state.audioBuffer.sampleRate;
    const sc = Math.floor(sr * state.audioDuration);
    const safeBPM = Math.max(60, Math.min(200, state.bpm || 120));
    const expectedEB = (state.audioDuration * safeBPM) / 60;

    // Build bpmData from regions
    const bpmData = [];
    let runningBeat = 0;

    if (state.bpmRegions.length > 1) {
      for (const region of state.bpmRegions) {
        const rBPM = Math.max(60, Math.min(200, region.bpm || safeBPM));
        const si = Math.floor(region.startTime * sr);
        const ei = Math.min(Math.floor(region.endTime * sr), sc);
        const regionDuration = Math.max(0, region.endTime - region.startTime);
        const regionBeats = (regionDuration * rBPM) / 60;
        bpmData.push({ si, ei, sb: rb(runningBeat), eb: rb(runningBeat + regionBeats) });
        runningBeat += regionBeats;
      }
    }

    // Sanity: if regions produced bad total beats, use simple single-region
    if (bpmData.length === 0 || runningBeat < 4 || runningBeat > expectedEB * 3) {
      bpmData.length = 0;
      bpmData.push({ si: 0, ei: sc, sb: 0, eb: rb(expectedEB) });
    }

    return { version: "4.0.0", songChecksum: "", songSampleCount: sc, songFrequency: sr, bpmData, lufsData: [] };
  }

  // ============================================================
  // SECTION H — ZIP EXPORT
  // ============================================================

  // ============================================================
  // ARCVIEWER PREVIEW — upload to temp host + open ArcViewer
  // Features: upload progress, share link, cached URL, retry
  // ============================================================

  const ARCVIEWER_URL = 'https://allpoland.github.io/ArcViewer/';
  let lastPreviewUrl = null;

  // BUILD ZIP BLOB — used by both export and preview
  async function buildZipBlob(gm) {
    const zip = new JSZip();
    zip.file("Info.dat", JSON.stringify(gm.infoDat, null, 2));
    zip.file("BPMInfo.dat", JSON.stringify(gm.bpmInfo, null, 2));
    for (const d of gm.difficulties) zip.file(diffFilename(d.name), JSON.stringify(d.dat, null, 2));
    zip.file("song.ogg", await state.audioFile.arrayBuffer());
    if (state.coverBlob) {
      zip.file("cover.jpg", state.coverBlob);
    } else if (state.coverFile) {
      try { zip.file("cover.jpg", await state.coverFile.arrayBuffer()); }
      catch (e) { zip.file("cover.jpg", generatePlaceholderCover()); }
    } else {
      zip.file("cover.jpg", generatePlaceholderCover());
    }
    verifyExport(zip, gm);
    return await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }

  // ============================================================
  // GITHUB-BASED PREVIEW SYSTEM
  // Uploads zip to user's GitHub repo → ArcViewer loads via ?url=
  // Falls back to download + drag-drop if no GitHub config
  // ============================================================

  function getGitHubConfig() {
    return {
      token: ($("#cfg-gh-token") || {}).value || localStorage.getItem("bf_gh_token") || "",
      owner: ($("#cfg-gh-owner") || {}).value || localStorage.getItem("bf_gh_owner") || "GalaxyFSRP1",
      repo:  ($("#cfg-gh-repo") || {}).value || localStorage.getItem("bf_gh_repo") || "AiMapper",
    };
  }

  function saveGitHubConfig() {
    const cfg = getGitHubConfig();
    if (cfg.token) localStorage.setItem("bf_gh_token", cfg.token);
    if (cfg.owner) localStorage.setItem("bf_gh_owner", cfg.owner);
    if (cfg.repo) localStorage.setItem("bf_gh_repo", cfg.repo);
    showToast("GitHub settings saved!", 2000);
  }

  function loadGitHubConfig() {
    const t = localStorage.getItem("bf_gh_token") || "";
    const o = localStorage.getItem("bf_gh_owner") || "GalaxyFSRP1";
    const r = localStorage.getItem("bf_gh_repo") || "AiMapper";
    const tEl = $("#cfg-gh-token"); if (tEl && t) tEl.value = t;
    const oEl = $("#cfg-gh-owner"); if (oEl) oEl.value = o;
    const rEl = $("#cfg-gh-repo"); if (rEl) rEl.value = r;
  }

  function hasGitHubConfig() {
    const cfg = getGitHubConfig();
    return cfg.token.length > 5 && cfg.owner.length > 0 && cfg.repo.length > 0;
  }

  function randomPreviewName() {
    const c = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = ""; for (let i = 0; i < 12; i++) s += c[Math.floor(Math.random() * c.length)];
    return "bf_" + s + ".zip";
  }

  // Upload zip to GitHub repo via Contents API
  async function uploadToGitHub(blob, onProgress) {
    const cfg = getGitHubConfig();
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      throw new Error("GitHub not configured. Open ArcViewer Settings below and add your token/repo.");
    }

    const filename = randomPreviewName();
    const path = "previews/" + filename;

    if (onProgress) onProgress(10);
    console.log("[BeatForge] Uploading to GitHub:", cfg.owner + "/" + cfg.repo + "/" + path);

    // Convert blob to base64
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunk = 32768;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    if (onProgress) onProgress(40);

    // PUT to GitHub Contents API
    const apiUrl = "https://api.github.com/repos/" + cfg.owner + "/" + cfg.repo + "/contents/" + path;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Authorization": "token " + cfg.token,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github.v3+json",
      },
      body: JSON.stringify({ message: "BeatForge preview: " + filename, content: base64 }),
    });

    if (onProgress) onProgress(80);

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("[BeatForge] GitHub API error:", resp.status, errBody);
      if (resp.status === 401) throw new Error("GitHub token invalid or expired.");
      if (resp.status === 404) throw new Error("Repo not found. Check owner/repo.");
      throw new Error("GitHub API: HTTP " + resp.status);
    }

    console.log("[BeatForge] GitHub upload success:", path);
    if (onProgress) onProgress(100);

    // Use the custom domain URL — GitHub Pages serves the file from the repo
    return "https://beatforgemapper.phantomvoid.online/" + path;
  }

  // Clean up old preview files (keep last 5)
  async function cleanupOldPreviews() {
    const cfg = getGitHubConfig();
    if (!cfg.token || !cfg.owner || !cfg.repo) return;
    try {
      const url = "https://api.github.com/repos/" + cfg.owner + "/" + cfg.repo + "/contents/previews";
      const resp = await fetch(url, {
        headers: { "Authorization": "token " + cfg.token, "Accept": "application/vnd.github.v3+json" },
      });
      if (!resp.ok) return;
      const files = await resp.json();
      if (!Array.isArray(files)) return;
      const previews = files.filter(f => f.name.startsWith("bf_") && f.name.endsWith(".zip"));
      if (previews.length <= 5) return;
      const toDelete = previews.slice(0, previews.length - 5);
      for (const file of toDelete) {
        await fetch("https://api.github.com/repos/" + cfg.owner + "/" + cfg.repo + "/contents/" + file.path, {
          method: "DELETE",
          headers: { "Authorization": "token " + cfg.token, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Cleanup old preview", sha: file.sha }),
        });
        console.log("[BeatForge] Cleaned up:", file.name);
      }
    } catch (e) { console.warn("[BeatForge] Cleanup:", e.message); }
  }

  // MAIN PREVIEW
  async function previewInArcViewer() {
    if (!state.generatedMap) { alert("Generate a map first!"); return; }

    const btn = $("#btn-preview-arc");
    const origHTML = btn ? btn.innerHTML : "";
    if (btn) btn.disabled = true;
    function setBtn(t) { if (btn) btn.textContent = t; }

    try {
      setBtn("Building zip...");
      const blob = await buildZipBlob(state.generatedMap);
      const sizeMB = (blob.size / 1024 / 1024).toFixed(1);

      if (hasGitHubConfig()) {
        // === GITHUB UPLOAD → ARCVIEWER AUTO-LOAD ===
        setBtn("Uploading to GitHub...");
        showToast("Uploading " + sizeMB + " MB to GitHub...", 10000);

        const rawUrl = await uploadToGitHub(blob, (pct) => setBtn("Uploading " + pct + "%"));
        lastPreviewUrl = rawUrl;

        const arcUrl = ARCVIEWER_URL + "?url=" + encodeURIComponent(rawUrl);
        console.log("[BeatForge] ArcViewer URL:", arcUrl);
        window.open(arcUrl, "_blank");

        showToast("ArcViewer opened with your map!", 5000);
        setBtn("Opened!");

        const sp = $("#preview-share-panel");
        if (sp) { sp.style.display = "flex"; const uf = $("#preview-url"); if (uf) uf.value = arcUrl; }

        cleanupOldPreviews(); // Background cleanup
      } else {
        // === DOWNLOAD + DRAG-DROP FALLBACK ===
        setBtn("Downloading...");
        const filename = ($("#cfg-song-name").value || "BeatForge_Map").replace(/[^a-zA-Z0-9_-]/g, "_") + ".zip";
        downloadBlob(blob, filename);
        setTimeout(() => {
          window.open(ARCVIEWER_URL, "_blank");
          showToast("Zip downloaded (" + sizeMB + " MB)! Drag into ArcViewer.\nTip: Set up GitHub in ArcViewer Settings for one-click preview!", 12000);
        }, 400);
        setBtn("Done!");
      }

      setTimeout(() => { if (btn) { btn.innerHTML = origHTML; btn.disabled = false; } }, 2500);

    } catch (err) {
      console.error("[BeatForge] Preview error:", err);
      showToast("Error: " + err.message + " — falling back to download.", 6000);
      try {
        const blob = await buildZipBlob(state.generatedMap);
        downloadBlob(blob, ($("#cfg-song-name").value || "BeatForge").replace(/[^a-zA-Z0-9_-]/g, "_") + ".zip");
        window.open(ARCVIEWER_URL, "_blank");
      } catch (e2) { alert("Preview failed: " + err.message); }
      if (btn) { btn.innerHTML = origHTML; btn.disabled = false; }
    }
  }

  async function doDownloadAndPreview() { return previewInArcViewer(); }

  function reopenPreview() {
    if (lastPreviewUrl) {
      window.open(ARCVIEWER_URL + "?url=" + encodeURIComponent(lastPreviewUrl), "_blank");
      showToast("Re-opened with last preview.", 3000);
    } else {
      window.open(ARCVIEWER_URL, "_blank");
    }
  }

  function copyPreviewLink() {
    const uf = $("#preview-url");
    if (uf && uf.value) navigator.clipboard.writeText(uf.value).then(() => showToast("Link copied!", 2000));
  }



  // Toast notification system
  function showToast(msg, duration) {
    duration = duration || 4000;
    let container = $("#toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.style.cssText = "background:rgba(10,10,20,0.95);color:#00e5ff;font-family:'Rajdhani',sans-serif;font-size:0.85rem;padding:12px 20px;border-radius:8px;border:1px solid rgba(0,229,255,0.3);box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:auto;max-width:360px;animation:toastIn 0.3s ease;";
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ============================================================
  // BUILT-IN NOTE TIMELINE PREVIEW — scrolling 2D note visualizer
  // Shows notes on a scrolling beat grid without leaving BeatForge
  // ============================================================

  let cachedDiffs = null; // Store for timeline re-rendering

  function renderNoteTimeline(diffs, selectedIdx) {
    cachedDiffs = diffs;
    const canvas = $("#preview-timeline");
    if (!canvas || !diffs || diffs.length === 0) return;
    const panel = $("#panel-preview");
    if (panel) panel.style.display = "";

    // Populate difficulty selector
    const sel = $("#timeline-diff-select");
    if (sel && sel.options.length !== diffs.length) {
      sel.innerHTML = "";
      diffs.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = d.name;
        if (i === diffs.length - 1) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => renderNoteTimeline(cachedDiffs, parseInt(sel.value));
    }

    const idx = selectedIdx !== undefined ? selectedIdx : diffs.length - 1;
    const diff = diffs[idx];
    const notes = diff.data.notes;
    const walls = diff.data.walls;
    const bpm = state.bpm || 120;
    const totalBeats = (state.audioDuration * bpm) / 60;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    // Layout: 4 columns (x), time scrolls left-to-right
    const cols = 4, rows = 3;
    const laneH = H / rows;
    const beatWidth = Math.max(3, W / Math.min(totalBeats, 100)); // Scale to fit ~100 beats visible
    const scrollOffset = 0; // Could be animated later

    // Background grid
    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, 0, W, H);

    // Row guides
    for (let r = 0; r <= rows; r++) {
      ctx.strokeStyle = "rgba(0,229,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, r * laneH);
      ctx.lineTo(W, r * laneH);
      ctx.stroke();
    }

    // Beat lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    for (let b = 0; b < totalBeats; b++) {
      const x = (b / totalBeats) * W;
      if (b % 4 === 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.03)";
      }
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Draw walls
    for (const w of walls) {
      const x = (w.b / totalBeats) * W;
      const ww = Math.max(1, (w.d / totalBeats) * W);
      const y = (rows - 1 - (w.y + w.h - 1)) * laneH;
      const wh = w.h * laneH;
      ctx.fillStyle = "rgba(100,100,100,0.25)";
      ctx.fillRect(x, y, ww, wh);
    }

    // Draw notes
    const noteSize = Math.max(3, Math.min(8, beatWidth * 0.4));
    for (const n of notes) {
      const x = (n.b / totalBeats) * W;
      const y = (rows - 1 - n.y) * laneH + laneH / 2;

      // Color
      if (n.c === 0) { // Red
        ctx.fillStyle = "#ff1744";
      } else { // Blue
        ctx.fillStyle = "#2979ff";
      }

      // Draw note block
      ctx.fillRect(x - noteSize / 2, y - noteSize / 2, noteSize, noteSize);

      // Direction arrow (tiny line)
      const dirs = [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1],[0,0]];
      if (n.d >= 0 && n.d < dirs.length && n.d !== 8) {
        const [dx, dy] = dirs[n.d];
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx * noteSize, y + dy * noteSize);
        ctx.stroke();
      }
    }

    // Difficulty label
    ctx.fillStyle = "#00e5ff";
    ctx.font = "bold 10px Orbitron, monospace";
    ctx.fillText(diff.name + " — " + notes.length + " notes", 6, 14);

    // Column labels at bottom
    ctx.font = "8px Rajdhani, sans-serif";
    ctx.fillStyle = "#556";
    ["L", "ML", "MR", "R"].forEach((label, i) => {
      // These are column labels but timeline is horizontal, so skip
    });
  }

  async function exportZip(gm) {
    try {
      const zip = new JSZip();
      zip.file("Info.dat", JSON.stringify(gm.infoDat, null, 2));
      zip.file("BPMInfo.dat", JSON.stringify(gm.bpmInfo, null, 2));
      for (const d of gm.difficulties) zip.file(diffFilename(d.name), JSON.stringify(d.dat, null, 2));

      // Audio — check if it's actually OGG
      const audioExt = state.audioFile.name.split(".").pop().toLowerCase();
      if (audioExt !== "ogg") {
        alert("WARNING: Your audio file is ." + audioExt + ", not .ogg.\n\nBeat Saber requires OGG Vorbis format.\n\nThe file will be included as-is, but you may need to convert it to .ogg using Audacity or another tool before uploading to BeatSaver.");
      }
      zip.file("song.ogg", await state.audioFile.arrayBuffer());

      // Cover — use pre-converted JPEG blob if available, otherwise generate placeholder
      if (state.coverBlob) {
        zip.file("cover.jpg", state.coverBlob);
      } else if (state.coverFile) {
        // Fallback: try raw file
        try {
          zip.file("cover.jpg", await state.coverFile.arrayBuffer());
        } catch (e) {
          zip.file("cover.jpg", generatePlaceholderCover());
        }
      } else {
        zip.file("cover.jpg", generatePlaceholderCover());
      }

      verifyExport(zip, gm);
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      downloadBlob(blob, ($("#cfg-song-name").value || "BeatForge_Map").replace(/[^a-zA-Z0-9_-]/g, "_") + ".zip");
    } catch (err) {
      alert("Export failed: " + err.message);
      console.error("Export error:", err);
    }
  }

  function verifyExport(zip, map) {
    if (map.infoDat._version !== "2.1.0") throw new Error("Info.dat version mismatch");
    for (const d of map.difficulties) {
      if (d.dat.version !== SCHEMA_VERSION) throw new Error(d.name + " version mismatch");
      if (!d.dat.basicBeatmapEvents || d.dat.basicBeatmapEvents.length < MIN_LIGHTING_EVENTS) throw new Error("Lighting insufficient in " + d.name);
    }
    for (const p of Object.keys(zip.files)) { if (p.includes("/")) throw new Error("Subdirectory found: " + p); }
    for (const f of ["Info.dat", "song.ogg", "BPMInfo.dat"]) { if (!zip.files[f]) throw new Error("Missing: " + f); }
    for (const set of map.infoDat._difficultyBeatmapSets || []) { for (const bm of set._difficultyBeatmaps || []) { if (!zip.files[bm._beatmapFilename]) throw new Error("Missing diff: " + bm._beatmapFilename); } }
    if (!zip.files[map.infoDat._coverImageFilename]) throw new Error("Missing cover");
  }

  function generatePlaceholderCover() {
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 512;
    const ctx = cv.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 512, 512); g.addColorStop(0, "#ff2040"); g.addColorStop(1, "#2080ff");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "white"; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center";
    ctx.fillText($("#cfg-song-name").value || "BeatForge", 256, 240);
    ctx.font = "24px sans-serif"; ctx.fillText($("#cfg-song-author").value || "Unknown Artist", 256, 290);
    const du = cv.toDataURL("image/jpeg", 0.9);
    const bs = atob(du.split(",")[1]);
    const ab = new ArrayBuffer(bs.length); const ia = new Uint8Array(ab);
    for (let i = 0; i < bs.length; i++) ia[i] = bs.charCodeAt(i);
    return ab;
  }

  function downloadBlob(blob, fn) {
    const u = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = u; a.download = fn; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
  }

  // ============================================================
  // SECTION I — UI ORCHESTRATION & RESULTS
  // ============================================================

  async function runGeneration(skipAnalysis) {
    const diffs = getSelectedDifficulties();
    if (diffs.length === 0) { alert("Select at least one difficulty."); return; }
    dom.btnGenerate.disabled = true;
    dom.progressArea.style.display = "";
    dom.panelResults.style.display = "none";
    dom.panelDiffStats.style.display = "none";
    if (dom.panelGrid) dom.panelGrid.style.display = "none";
    if (dom.panelLog) dom.panelLog.style.display = "none";
    const warnPanel = $("#panel-warnings"); if (warnPanel) warnPanel.style.display = "none";
    const generatedDiffs = [];

    // Detailed step count: analysis(6) + per-diff(4 each) + finalize(3)
    const totalSteps = (skipAnalysis ? 0 : 6) + diffs.length * 4 + 3;
    let step = 0;

    function progress(msg) {
      step++;
      setProgress(step / totalSteps, msg);
    }

    try {
      state.genSeed = (state.genSeed + 1) % 100;

      if (!skipAnalysis) {
        // === PHASE 1: AUDIO ANALYSIS (6 steps) ===
        progress("Decoding audio waveform..."); await sleep(200);
        progress("Computing spectral bands (bass/mid/high)..."); await sleep(300);
        progress("Detecting onsets and transients..."); await sleep(250);
        progress("Running 5-method BPM detection..."); await sleep(350);
        progress("Identifying song sections (intro/verse/drop/chorus)..."); await sleep(300);
        progress("Building instrument map and energy curve..."); await sleep(200);
      }

      // === AI MODEL: classify audio style and adjust mlWeights ===
      if (window.BeatForgeAI && state.onsets && state.onsets.length > 0) {
        if (window.BeatForgeAI.isReady()) {
          progress("Running AI pattern analysis...");
          // Build lightweight feature notes from onsets for classification
          const _aiNotes = state.onsets.slice(0, 200).map((o, i) => ({
            b: o * (state.bpm / 60),
            c: i % 2,
            d: Math.floor(Math.random() * 8),
            x: Math.floor(Math.random() * 4),
            y: Math.floor(Math.random() * 3),
          }));
          const aiResult = await window.BeatForgeAI.classifyAndPatch(
            _aiNotes, state.bpm, state.audioDuration, mlWeights
          );
          if (aiResult) {
            logGen(0, "pattern",
              "AI detected style: " + aiResult.style +
              " (" + (aiResult.styleProbs[aiResult.style] * 100).toFixed(0) + "%) | " +
              "Suggested diff: " + aiResult.diff
            );
            // Flash the AI badge
            const badge = document.getElementById("ai-status-badge");
            if (badge) {
              badge.style.opacity = "0.4";
              setTimeout(() => badge.style.opacity = "1", 400);
            }
            // Show AI result panel
            updateAIResultPanel(aiResult);
          }
        } else {
          logGen(0, "pattern", "AI model loading — using rule-based weights");
        }
      }

      // === PHASE 2: PATTERN GENERATION ===
      const DIFF_ORDER = ["ExpertPlus", "Expert", "Hard", "Normal", "Easy"];
      const sorted = [...diffs].sort((a, b) => DIFF_ORDER.indexOf(a) - DIFF_ORDER.indexOf(b));
      let masterNotes = null;

      for (const dn of sorted) {
        const isHardest = (dn === sorted[0]);

        if (isHardest || !masterNotes) {
          // Generate from scratch
          progress("Analyzing rhythm target for " + dn + "..."); await sleep(250);
          progress("Placing note patterns for " + dn + "..."); await sleep(300);
          const dd = generateDifficulty(dn);
          masterNotes = dd.notes;
          progress("Validating parity and flow for " + dn + "..."); await sleep(200);
          progress("Generating lighting and walls for " + dn + "..."); await sleep(150);
          generatedDiffs.push({ name: dn, data: dd, dat: buildDifficultyDat(dd), scores: computeRankScores(dd) });
        } else {
          // Downmap from master
          progress("Selecting key notes for " + dn + " downmap..."); await sleep(200);
          progress("Simplifying patterns for " + dn + "..."); await sleep(250);
          const dd = downmapDifficulty(dn, masterNotes);
          progress("Validating " + dn + " difficulty curve..."); await sleep(150);
          progress("Building " + dn + " lighting and elements..."); await sleep(100);
          generatedDiffs.push({ name: dn, data: dd, dat: buildDifficultyDat(dd), scores: computeRankScores(dd) });
        }
      }

      // === PHASE 3: FINALIZE ===
      progress("Building Info.dat and BPMInfo.dat..."); await sleep(200);
      generatedDiffs.sort((a, b) => diffRank(a.name) - diffRank(b.name));

      progress("Running ranked validation checks..."); await sleep(250);
      state.generatedMap = { infoDat: buildInfoDat(generatedDiffs), bpmInfo: buildBPMInfoDat(), difficulties: generatedDiffs };

      progress("Rendering previews and statistics..."); await sleep(150);
      setProgress(1, "Map generation complete!");
      showResults(generatedDiffs);
      const btnRegen = $("#btn-regenerate");
      if (btnRegen) btnRegen.disabled = false;
    } catch (err) { setProgress(0, "Error: " + err.message); console.error(err); }
    dom.btnGenerate.disabled = false;
  }

  // ============================================================
  // DOWNMAPPING — derive lower difficulties from the hardest
  // Keeps core motifs (doubles on drops, direction themes) while
  // reducing density, removing complex patterns, simplifying angles
  // ============================================================
  function downmapDifficulty(diffName, masterNotes) {
    const us = getUserSettings();
    const settings = getDiffSettings(diffName, state.bpm, us.style, us.complexity, us.density);
    if (us.njsOverride > 0) settings.njs = us.njsOverride;
    settings.njsOffset = us.njsOffset;
    const bpm = Math.max(60, Math.min(200, state.bpm || 120));
    const totalBeats = timeToBeat(state.audioDuration, bpm);

    // BSMG NJS defaults per difficulty (if no override)
    if (us.njsOverride <= 0) {
      const njsDefaults = { Easy: 10, Normal: 10, Hard: 12, Expert: 16 };
      if (njsDefaults[diffName]) settings.njs = njsDefaults[diffName];
    }

    // BSMG density reduction: ~20% per step down
    const targetNPS = settings.nps || settings.baseNps || 4;
    const targetNotes = Math.floor(targetNPS * state.audioDuration);

    // BSMG grid precision per difficulty for importance scoring
    const gridStep = getGridStep(diffName, SEC.DROP);

    // Score each master note by musical importance
    const scored = masterNotes.map((n, i) => {
      let importance = 0;
      const t = beatToTime(n.b, bpm);
      const energy = getEnergyAtTime(t);
      const sec = getSectionAt(t);

      // Downbeat = most important
      if (Math.abs(n.b % 1) < 0.05) importance += 3;
      else if (Math.abs(n.b % 0.5) < 0.05) importance += 2;
      else if (Math.abs(n.b % 0.25) < 0.05) importance += 1;

      // Doubles in drops = core motif
      const hasPartner = masterNotes.some(m => m !== n && Math.abs(m.b - n.b) < 0.01 && m.c !== n.c);
      if (hasPartner && (sec.type === SEC.DROP || sec.type === SEC.CHORUS)) importance += 2;

      // High energy notes matter more
      importance += energy * 2;

      // Section boundaries are landmarks
      const secStart = timeToBeat(sec.startTime, bpm);
      if (Math.abs(n.b - secStart) < 2) importance += 1;

      // BSMG: penalize notes off this diff's grid precision
      if (Math.abs(n.b % gridStep) > 0.05) importance -= 2;

      // For Easy: heavily penalize fast notes (1/4, 1/8)
      if (diffName === "Easy" && Math.abs(n.b % 1) > 0.05) importance -= 1;

      return { note: n, importance, idx: i };
    });

    scored.sort((a, b) => b.importance - a.importance);
    const toKeep = scored.slice(0, targetNotes);
    toKeep.sort((a, b) => a.note.b - b.note.b);

    // Build note array with BSMG-correct simplification per difficulty
    const notes = [];
    const hs = {
      [C.RED]:  { lastBeat: -10, lastDir: D.DOWN, lastX: 1, lastY: 0, swingCount: 0, parity: "fore" },
      [C.BLUE]: { lastBeat: -10, lastDir: D.DOWN, lastX: 2, lastY: 0, swingCount: 0, parity: "fore" },
    };

    for (const { note } of toKeep) {
      const hand = note.c;
      const h = hs[hand];
      const beatGap = note.b - h.lastBeat;

      let dir = note.d;
      let x = note.x, y = note.y;

      if (diffName === "Easy") {
        // BSMG EASY: No diagonals, no top-row arrows, no crossovers
        // Break parity freely — players at this level don't grasp flow
        // Straighten all directions to cardinal DOWN/UP
        if (IS_DOWN.includes(dir) || dir === D.DOWN_LEFT || dir === D.DOWN_RIGHT) dir = D.DOWN;
        else if (IS_UP.includes(dir) || dir === D.UP_LEFT || dir === D.UP_RIGHT) dir = D.UP;
        else if (dir === D.LEFT || dir === D.RIGHT) dir = D.DOWN; // Side hits → down for Easy

        // Home columns only, bottom/middle rows only
        x = HOME[hand].x;
        y = Math.min(1, note.y); // Never top row (y=2) for Easy

        // No crossovers: red stays left, blue stays right
        if (hand === C.RED && x > 2) x = 1;
        if (hand === C.BLUE && x < 1) x = 2;

      } else if (diffName === "Normal") {
        // BSMG NORMAL: Limited diagonals, introduce flow in fast sections
        // Can break parity on resets (beatGap >= 1.5)
        if (dir === D.DOWN_LEFT || dir === D.DOWN_RIGHT) dir = D.DOWN; // Simplify diagonals
        if (dir === D.UP_LEFT || dir === D.UP_RIGHT) dir = D.UP;
        // Keep LEFT/RIGHT as emphasis — BSMG says side hits are good for emphasis

        // Stay near home, allow middle row
        x = Math.max(HOME[hand].x - 1, Math.min(HOME[hand].x + 1, note.x));
        y = Math.min(1, note.y); // Mostly bottom/middle

        // No crossovers
        if (hand === C.RED && x > 2) x = 2;
        if (hand === C.BLUE && x < 1) x = 1;

        // Enforce parity only for fast notes (< 1.5 beats apart)
        if (beatGap < 1.5 && h.lastBeat > -5) {
          const prevDown = IS_DOWN.includes(h.lastDir) || h.lastDir === D.LEFT || h.lastDir === D.RIGHT;
          const currDown = IS_DOWN.includes(dir);
          if (prevDown && currDown) dir = D.UP;
          if (!prevDown && !currDown) dir = D.DOWN;
        }

      } else if (diffName === "Hard") {
        // BSMG HARD: Proper parity enforced, simplified Expert patterns
        // Allow diagonals but simplify extreme angles
        // Compact streams to less demanding positions

        // Keep position closer to center
        x = Math.max(HOME[hand].x - 1, Math.min(HOME[hand].x + 1, note.x));

        // Enforce parity
        if (beatGap < 2.0 && h.lastBeat > -5) {
          const prevDown = IS_DOWN.includes(h.lastDir);
          const currDown = IS_DOWN.includes(dir);
          if (prevDown && currDown) {
            dir = (PARITY_FOLLOWUP[h.lastDir] || [D.UP])[0];
          }
          if (!prevDown && !currDown && IS_UP.includes(h.lastDir) && IS_UP.includes(dir)) {
            dir = (PARITY_FOLLOWUP[h.lastDir] || [D.DOWN])[0];
          }
        }

      } else {
        // Expert: keep most patterns, minor simplification
        if (beatGap < 2.0 && h.lastBeat > -5) {
          const prevDown = IS_DOWN.includes(h.lastDir);
          const currDown = IS_DOWN.includes(dir);
          if (prevDown && currDown) dir = (PARITY_FOLLOWUP[h.lastDir] || [D.UP])[0];
          if (!prevDown && !currDown && IS_UP.includes(h.lastDir) && IS_UP.includes(dir)) {
            dir = (PARITY_FOLLOWUP[h.lastDir] || [D.DOWN])[0];
          }
        }
      }

      notes.push({ b: note.b, x, y, c: hand, d: dir, a: 0 });
      h.lastBeat = note.b; h.lastDir = dir; h.lastX = x; h.lastY = y;
      h.parity = h.parity === "fore" ? "back" : "fore";
      h.swingCount++;
    }

    // BSMG EASY: Remove ALL doubles (one hand per beat)
    if (diffName === "Easy") {
      const filtered = [];
      let lastBeat = -10;
      for (const n of notes) {
        if (Math.abs(n.b - lastBeat) < 0.01) continue;
        filtered.push(n);
        lastBeat = n.b;
      }
      notes.length = 0;
      notes.push(...filtered);
    }

    // BSMG NORMAL: Very limited doubles (only on highest energy moments)
    if (diffName === "Normal") {
      const filtered = [];
      let lastBeat = -10;
      for (const n of notes) {
        if (Math.abs(n.b - lastBeat) < 0.01) {
          // Only keep double if energy > 0.75 (BSMG: "big flashy movements")
          if (getEnergyAtTime(beatToTime(n.b, bpm)) > 0.75) {
            filtered.push(n);
          }
          continue;
        }
        filtered.push(n);
        lastBeat = n.b;
      }
      notes.length = 0;
      notes.push(...filtered);
    }

    // Run parity validation (skip for Easy since parity is intentionally broken)
    if (diffName !== "Easy") {
      parityValidationPass(notes);
    }

    // Generate supporting elements
    const wantArcs = !$("#tog-arcs") || $("#tog-arcs").checked;
    const wantChains = !$("#tog-chains") || $("#tog-chains").checked;
    const wantBombs = !$("#tog-bombs") || $("#tog-bombs").checked;
    const wantWalls = !$("#tog-walls") || $("#tog-walls").checked;

    // BSMG: Easy gets no arcs/chains/sliders. Normal gets very limited.
    const arcs = (wantArcs && diffName !== "Easy") ? generateArcs(notes, bpm, settings) : [];
    const chains = (wantChains && diffName !== "Easy" && diffName !== "Normal") ? generateChains(notes, bpm, settings, totalBeats) : [];
    const bombs = wantBombs ? generateBombs(notes, bpm, settings, totalBeats) : [];
    const walls = wantWalls ? generateWalls(notes, bpm, settings, totalBeats) : [];
    const lighting = generateLighting(bpm, totalBeats);

    return { notes, arcs, chains, bombs, walls, lighting, settings };
  }

  function setProgress(f, t) { dom.progressFill.style.width = (f * 100).toFixed(1) + "%"; dom.progressText.textContent = t; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showResults(diffs) {
    dom.panelResults.style.display = "";
    dom.panelDiffStats.style.display = "";
    let tN = 0, tA = 0, tC = 0, tB = 0, tW = 0, tL = 0, tD = 0;
    for (const d of diffs) { tN += d.data.notes.length; tA += d.data.arcs.length; tC += d.data.chains.length; tB += d.data.bombs.length; tW += d.data.walls.length; tL += d.data.lighting.length; tD += countDoubles(d.data.notes); }
    const us = getUserSettings();
    dom.resultsGrid.innerHTML = rc("Notes", tN) + rc("Doubles", tD) + rc("Arcs", tA) + rc("Chains", tC) + rc("Bombs", tB) + rc("Walls", tW) + rc("Lighting", tL) + rc("Style", us.style) + rc("BPM", state.bpm) + rc("Duration", Math.floor(state.audioDuration / 60) + ":" + String(Math.floor(state.audioDuration % 60)).padStart(2, "0"));

    // Per-difficulty star ratings
    const starEl = $("#star-ratings");
    if (starEl) {
      let starHTML = '<div style="display:flex;flex-wrap:wrap;gap:12px;margin:8px 0;">';
      for (const d of diffs) {
        const nps = d.data.notes.length / Math.max(1, state.audioDuration);
        // Rough star estimate based on NPS + pattern complexity
        const stars = Math.min(12, Math.max(1, Math.round(nps * 0.8 + (d.scores.tech || 0) * 0.3)));
        const starStr = "★".repeat(Math.min(stars, 10)) + (stars > 10 ? "+" : "");
        const starColor = stars >= 8 ? "#ff3898" : stars >= 5 ? "#f0a030" : stars >= 3 ? "#00e5ff" : "#40e080";
        starHTML += '<div style="text-align:center;padding:6px 12px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid rgba(0,229,255,0.15);">' +
          '<div style="font-family:Orbitron,monospace;font-size:0.6rem;color:#667;margin-bottom:2px;">' + d.name + '</div>' +
          '<div style="font-size:0.7rem;color:' + starColor + '">' + starStr + '</div>' +
          '<div style="font-size:0.6rem;color:#556;">' + nps.toFixed(1) + ' NPS · NJS ' + (d.data.settings.njs || "?") + '</div>' +
          '</div>';
      }
      starEl.innerHTML = starHTML + '</div>';
    }

    // Map quality score
    const qualEl = $("#quality-score");
    if (qualEl && diffs.length > 0) {
      const h = diffs[diffs.length - 1];
      const avgRank = diffs.reduce((s, d) => s + d.scores.rankScore, 0) / diffs.length;
      const qualColor = avgRank >= 7 ? "#40e080" : avgRank >= 5 ? "#f0a030" : "#ff3898";
      qualEl.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid ' + qualColor + '30;">' +
        '<span style="font-family:Orbitron,monospace;font-size:1.8rem;font-weight:900;color:' + qualColor + '">' + avgRank.toFixed(1) + '</span>' +
        '<div><div style="font-family:Orbitron,monospace;font-size:0.65rem;color:#667;">MAP QUALITY SCORE</div>' +
        '<div style="font-size:0.7rem;color:#aab;">' + diffs.length + ' difficulties · ' + tN + ' total notes · ' + tL + ' lighting events</div></div></div>';
    }

    const h = diffs[diffs.length - 1]; const s = h.scores;
    const bars = [
      { l: "Flow", v: s.flow, c: "#00f0ff" }, { l: "Parity", v: s.parity, c: "#2080ff" },
      { l: "Tech", v: s.tech, c: "#ff3898" }, { l: "Lighting", v: s.lightingSync, c: "#f0a030" },
      { l: "Walls", v: s.wallComfort, c: "#40e080" }, { l: "Readability", v: s.readability, c: "#c080ff" },
    ];
    dom.rankDisplay.innerHTML = '<h3>RANKED VALIDATION \u2014 ' + h.name + '</h3><div class="rank-bars">' +
      bars.map(b => '<div class="rank-bar-row"><div class="rank-bar-label">' + b.l + '</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + (b.v * 10) + '%;background:' + b.c + '"></div></div><div class="rank-bar-score" style="color:' + b.c + '">' + b.v.toFixed(1) + '</div></div>').join("") +
      '</div><div style="margin-top:16px;text-align:center;"><span style="font-family:Orbitron,monospace;font-size:1.4rem;font-weight:900" class="' + (s.passed ? "val-good" : "val-bad") + '">RANK SCORE: ' + s.rankScore.toFixed(2) + ' / 10</span> <span style="margin-left:12px;font-size:0.8rem;color:' + (s.passed ? "#00f0ff" : "#ff2040") + '">' + (s.passed ? "PASSED" : "BELOW " + RANKED_THRESHOLD) + '</span></div>';

    let tbl = '<table><thead><tr><th>Diff</th><th>Notes</th><th>NPS</th><th>Doubles</th><th>Arcs</th><th>Chains</th><th>Bombs</th><th>Walls</th><th>Lights</th><th>Parity</th><th>Comfort</th><th>Rank</th><th>Status</th></tr></thead><tbody>';
    for (const d of diffs) {
      const sc = d.scores;
      const qa = analyzeMapQuality(d.data.notes, state.bpm);
      tbl += '<tr><td class="td-diff">' + d.name + '</td><td>' + d.data.notes.length + '</td><td>' + (d.data.notes.length / state.audioDuration).toFixed(1) + '</td><td>' + countDoubles(d.data.notes) + '</td><td>' + d.data.arcs.length + '</td><td>' + d.data.chains.length + '</td><td>' + d.data.bombs.length + '</td><td>' + d.data.walls.length + '</td><td>' + d.data.lighting.length + '</td><td class="' + (qa.parityViolations === 0 ? "td-pass" : "td-fail") + '">' + (qa.parityViolations === 0 ? "0" : qa.parityViolations) + '</td><td>' + qa.comfortScore.toFixed(1) + '</td><td>' + sc.rankScore.toFixed(2) + '</td><td class="' + (sc.passed ? "td-pass" : "td-fail") + '">' + (sc.passed ? "PASS" : "FAIL") + '</td></tr>';
    }
    dom.diffStatsTable.innerHTML = tbl + '</tbody></table>';

    // Render grid preview for hardest difficulty
    drawGridPreview(diffs);

    // Render generation log
    renderGenLog();

    // Render note density timeline
    drawDensityTimeline(diffs);

    // Render pattern breakdown
    renderPatternBreakdown(diffs);

    // Render onset sync quality
    renderOnsetSync(diffs);

    // NEW FEATURES — section timeline, star ratings, map stats, note preview
    drawSectionTimeline();
    drawEnergyCurve();
    renderStarRatings(diffs);
    renderMapStats(diffs);
    displayWarnings(diffs);
    renderNoteTimeline(diffs);
  }

  // Note density timeline — shows NPS across the song per difficulty
  function drawDensityTimeline(diffs) {
    const canvas = $("#density-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = 80 * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = 80;
    ctx.clearRect(0, 0, W, H);

    const dur = state.audioDuration;
    const bucketSize = 2; // 2 second buckets
    const numBuckets = Math.ceil(dur / bucketSize);

    const colors = { Easy: "#40e080", Normal: "#f0a030", Hard: "#ff3898", Expert: "#c080ff", ExpertPlus: "#ff2040" };

    // Draw energy backdrop
    ctx.fillStyle = "rgba(0,229,255,0.08)";
    for (let i = 0; i < numBuckets; i++) {
      const t = i * bucketSize;
      const e = getEnergyAtTime(t + bucketSize / 2);
      const h = e * H * 0.3;
      ctx.fillRect((i / numBuckets) * W, H - h, W / numBuckets, h);
    }

    // Draw NPS per difficulty
    for (const d of diffs) {
      const notes = d.data.notes;
      const buckets = new Array(numBuckets).fill(0);
      for (const n of notes) {
        const t = beatToTime(n.b, state.bpm);
        const bi = Math.min(numBuckets - 1, Math.floor(t / bucketSize));
        buckets[bi]++;
      }

      const maxNPS = Math.max(...buckets.map(c => c / bucketSize), 1);
      const color = colors[d.name] || "#ffffff";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let i = 0; i < numBuckets; i++) {
        const x = (i / numBuckets) * W + W / numBuckets / 2;
        const y = H - (buckets[i] / bucketSize / maxNPS) * H * 0.8;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Legend
    ctx.font = "9px 'Chakra Petch', sans-serif";
    let legendX = 4;
    for (const d of diffs) {
      ctx.fillStyle = colors[d.name] || "#fff";
      ctx.fillRect(legendX, 3, 8, 8);
      ctx.fillStyle = "#ccc";
      ctx.fillText(d.name, legendX + 11, 10);
      legendX += ctx.measureText(d.name).width + 20;
    }
  }

  // Pattern breakdown — shows what patterns were used and how many
  function renderPatternBreakdown(diffs) {
    const el = $("#pattern-breakdown");
    if (!el) return;

    const hardest = diffs[diffs.length - 1];
    const notes = hardest.data.notes;
    const total = notes.length;

    // Count patterns by type
    const redCount = notes.filter(n => n.c === C.RED).length;
    const blueCount = notes.filter(n => n.c === C.BLUE).length;
    const doubles = countDoubles(notes);
    const topRow = notes.filter(n => n.y === 2).length;
    const midRow = notes.filter(n => n.y === 1).length;
    const botRow = notes.filter(n => n.y === 0).length;

    // Count direction distribution
    const downFamily = notes.filter(n => IS_DOWN.includes(n.d)).length;
    const upFamily = notes.filter(n => IS_UP.includes(n.d)).length;
    const sideFamily = notes.filter(n => n.d === D.LEFT || n.d === D.RIGHT).length;

    const pct = (v) => total > 0 ? (v / total * 100).toFixed(1) + "%" : "0%";

    el.innerHTML = '<span style="color:var(--neon-cyan);font-family:Orbitron,monospace;font-weight:700">PATTERN ANALYSIS (' + hardest.name + ')</span><br>' +
      '<span style="color:#ff3040">Red: ' + redCount + ' (' + pct(redCount) + ')</span> · ' +
      '<span style="color:#2090ff">Blue: ' + blueCount + ' (' + pct(blueCount) + ')</span> · ' +
      'Doubles: ' + doubles + '<br>' +
      'Rows: Top ' + pct(topRow) + ' · Mid ' + pct(midRow) + ' · Bottom ' + pct(botRow) + '<br>' +
      'Dirs: Down↓ ' + pct(downFamily) + ' · Up↑ ' + pct(upFamily) + ' · Side↔ ' + pct(sideFamily);
  }

  // Onset sync quality — how well notes align with actual musical beats
  function renderOnsetSync(diffs) {
    const el = $("#onset-sync");
    if (!el || state.onsets.length === 0) return;

    const hardest = diffs[diffs.length - 1];
    const notes = hardest.data.notes;

    let synced = 0, total = notes.length;
    for (const n of notes) {
      const t = beatToTime(n.b, state.bpm);
      // Check if any onset is within 100ms of this note
      const isOnBeat = state.onsets.some(o => Math.abs(o - t) < 0.1);
      if (isOnBeat) synced++;
    }

    const syncPct = total > 0 ? (synced / total * 100).toFixed(1) : 0;
    const quality = syncPct > 70 ? "Excellent" : syncPct > 50 ? "Good" : syncPct > 30 ? "Fair" : "Low";
    const color = syncPct > 70 ? "#4cff88" : syncPct > 50 ? "#f0a030" : "#ff3040";

    el.innerHTML = '<span style="font-family:Orbitron,monospace;font-weight:700;color:' + color + '">ONSET SYNC: ' + syncPct + '% (' + quality + ')</span>' +
      ' — <span style="color:#888">' + synced + '/' + total + ' notes aligned to musical beats</span>';
  }

  function rc(l, v) { return '<div class="result-card"><div class="rc-label">' + l + '</div><div class="rc-value val-good">' + v + '</div></div>'; }

  // ============================================================
  // ENERGY CURVE VISUALIZATION
  // Shows bass/mid/high energy over time on a canvas
  // ============================================================
  function drawEnergyCurve() {
    const canvas = $("#energy-canvas");
    if (!canvas || !state.energyCurve || state.energyCurve.length < 10) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const dur = state.audioDuration || 1;
    const curves = [
      { data: state.bassCurve, color: "rgba(255,56,152,0.6)", label: "Bass" },
      { data: state.midCurve, color: "rgba(0,229,255,0.5)", label: "Mid" },
      { data: state.highCurve, color: "rgba(192,128,255,0.4)", label: "High" },
    ];

    for (const curve of curves) {
      if (!curve.data || curve.data.length < 10) continue;
      const max = Math.max(...curve.data) || 1;
      ctx.beginPath();
      ctx.strokeStyle = curve.color;
      ctx.lineWidth = 1;
      for (let i = 0; i < W; i++) {
        const idx = Math.floor((i / W) * curve.data.length);
        const val = (curve.data[idx] || 0) / max;
        const y = H - val * H;
        if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
      }
      ctx.stroke();

      // Fill area under curve
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fillStyle = curve.color.replace(/[\d.]+\)$/, "0.1)");
      ctx.fill();
    }

    // Section markers
    if (state.sections) {
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "7px Rajdhani, sans-serif";
      for (const sec of state.sections) {
        const x = (sec.startTime / dur) * W;
        ctx.fillRect(x, 0, 1, H);
        ctx.fillText(sec.type, x + 2, 8);
      }
    }
  }

  // ============================================================
  // MAP WARNINGS — BeatSaver-ready validation
  // Checks for common issues that would cause problems
  // ============================================================
  function generateMapWarnings(diffs) {
    const warnings = [];
    const bpm = state.bpm || 120;
    const dur = state.audioDuration || 0;

    for (const d of diffs) {
      const notes = d.data.notes;
      if (notes.length === 0) { warnings.push({ level: "error", diff: d.name, msg: "No notes generated" }); continue; }

      const firstNote = notes[0];
      const lastNote = notes[notes.length - 1];
      const firstTime = beatToTime(firstNote.b, bpm);
      const lastTime = beatToTime(lastNote.b, bpm);

      // Hot start (notes within 1.5s)
      if (firstTime < 1.5) {
        warnings.push({ level: "warn", diff: d.name, msg: "Hot start — first note at " + firstTime.toFixed(1) + "s (should be >1.5s)" });
      }

      // Hot end (notes within 2s of song end)
      if (dur - lastTime < 2.0) {
        warnings.push({ level: "warn", diff: d.name, msg: "Notes too close to song end (" + (dur - lastTime).toFixed(1) + "s gap)" });
      }

      // NPS check
      const nps = notes.length / Math.max(1, dur);
      if (d.name === "Easy" && nps > 3) {
        warnings.push({ level: "warn", diff: d.name, msg: "NPS " + nps.toFixed(1) + " may be too high for Easy (recommended <3)" });
      }
      if (d.name === "Normal" && nps > 5) {
        warnings.push({ level: "warn", diff: d.name, msg: "NPS " + nps.toFixed(1) + " may be too high for Normal (recommended <5)" });
      }

      // Vision blocks (middle row center lane notes)
      let visionBlocks = 0;
      for (const n of notes) {
        if (n.y === 1 && (n.x === 1 || n.x === 2)) visionBlocks++;
      }
      if (visionBlocks > notes.length * 0.3) {
        warnings.push({ level: "info", diff: d.name, msg: visionBlocks + " potential vision blocks (center-middle notes)" });
      }

      // Lighting check
      if (d.data.lighting.length < 20) {
        warnings.push({ level: "error", diff: d.name, msg: "Insufficient lighting (" + d.data.lighting.length + " events)" });
      }

      // Long empty gaps (>8 beats with no notes)
      let maxGap = 0;
      for (let i = 1; i < notes.length; i++) {
        const gap = notes[i].b - notes[i-1].b;
        if (gap > maxGap) maxGap = gap;
      }
      if (maxGap > 8) {
        warnings.push({ level: "info", diff: d.name, msg: "Long empty gap of " + maxGap.toFixed(1) + " beats detected" });
      }

      // Parity violations (for Hard+)
      if (d.name !== "Easy" && d.name !== "Normal") {
        const qa = analyzeMapQuality(notes, bpm);
        if (qa.parityViolations > notes.length * 0.05) {
          warnings.push({ level: "warn", diff: d.name, msg: qa.parityViolations + " parity violations (" + (qa.parityViolations / notes.length * 100).toFixed(1) + "%)" });
        }
      }
    }

    // NPS progression check
    const npsList = diffs.map(d => ({ name: d.name, nps: d.data.notes.length / Math.max(1, dur) }));
    for (let i = 1; i < npsList.length; i++) {
      if (npsList[i].nps < npsList[i-1].nps * 0.95) {
        warnings.push({ level: "info", diff: npsList[i].name,
          msg: "NPS (" + npsList[i].nps.toFixed(1) + ") is lower than " + npsList[i-1].name + " (" + npsList[i-1].nps.toFixed(1) + ")" });
      }
    }

    return warnings;
  }

  function displayWarnings(diffs) {
    const panel = $("#panel-warnings");
    const list = $("#warnings-list");
    if (!panel || !list) return;

    const warnings = generateMapWarnings(diffs);
    if (warnings.length === 0) {
      panel.style.display = "none";
      return;
    }

    panel.style.display = "";
    const icons = { error: "🔴", warn: "🟡", info: "🔵" };
    const colors = { error: "#ff3040", warn: "#f0a030", info: "#00e5ff" };
    list.innerHTML = warnings.map(w =>
      '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);color:' + colors[w.level] + '">' +
      '<span style="margin-right:6px">' + icons[w.level] + '</span>' +
      '<span style="color:#889;font-size:0.65rem;font-family:Orbitron,monospace">[' + w.diff + ']</span> ' +
      w.msg + '</div>'
    ).join("");
  }

  // ============================================================
  // PATTERN DIVERSITY ANALYSIS
  // Measures how varied the direction/position choices are
  // ============================================================
  function analyzePatternDiversity(notes) {
    if (notes.length < 10) return { dirDiversity: 0, posDiversity: 0, score: 0 };

    // Direction histogram
    const dirCounts = {};
    for (const n of notes) {
      dirCounts[n.d] = (dirCounts[n.d] || 0) + 1;
    }
    const dirEntries = Object.values(dirCounts);
    const dirEntropy = -dirEntries.reduce((s, c) => {
      const p = c / notes.length;
      return s + (p > 0 ? p * Math.log2(p) : 0);
    }, 0);
    const maxDirEntropy = Math.log2(Math.min(8, dirEntries.length || 1));
    const dirDiversity = maxDirEntropy > 0 ? dirEntropy / maxDirEntropy : 0;

    // Position histogram
    const posCounts = {};
    for (const n of notes) {
      const key = n.x + "," + n.y;
      posCounts[key] = (posCounts[key] || 0) + 1;
    }
    const posEntries = Object.values(posCounts);
    const posEntropy = -posEntries.reduce((s, c) => {
      const p = c / notes.length;
      return s + (p > 0 ? p * Math.log2(p) : 0);
    }, 0);
    const maxPosEntropy = Math.log2(Math.min(12, posEntries.length || 1));
    const posDiversity = maxPosEntropy > 0 ? posEntropy / maxPosEntropy : 0;

    return {
      dirDiversity: Math.round(dirDiversity * 100),
      posDiversity: Math.round(posDiversity * 100),
      score: Math.round((dirDiversity * 0.6 + posDiversity * 0.4) * 100),
      uniqueDirs: dirEntries.length,
      uniquePositions: posEntries.length,
    };
  }

  // ============================================================
  // NOTE GRID PREVIEW RENDERER
  // ============================================================

  function drawGridPreview(diffs) {
    if (!dom.panelGrid || !dom.gridCanvas) return;
    dom.panelGrid.style.display = "";

    const hardest = diffs[diffs.length - 1];
    const notes = hardest.data.notes;
    const canvas = dom.gridCanvas;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const cols = 4, rows = 3;
    const cellW = W / cols, cellH = H / rows;
    const pad = 4;

    // Count notes per cell
    const heatmap = Array.from({ length: rows }, () => Array(cols).fill(0));
    const redCount = Array.from({ length: rows }, () => Array(cols).fill(0));
    const blueCount = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (const n of notes) {
      if (n.x >= 0 && n.x < cols && n.y >= 0 && n.y < rows) {
        heatmap[n.y][n.x]++;
        if (n.c === 0) redCount[n.y][n.x]++;
        else if (n.c === 1) blueCount[n.y][n.x]++;
      }
    }

    const maxHeat = Math.max(1, ...heatmap.flat());

    // Draw cells (row 0 = top visually, but y=2 in BS grid is top)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const drawR = rows - 1 - r; // Flip: BS y=2 is top row
        const x = c * cellW + pad;
        const y = drawR * cellH + pad;
        const w = cellW - pad * 2;
        const h = cellH - pad * 2;
        const heat = heatmap[r][c] / maxHeat;
        const red = redCount[r][c];
        const blue = blueCount[r][c];
        const total = red + blue;

        // Cell background
        ctx.fillStyle = `rgba(15, 22, 40, 0.8)`;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 6);
        ctx.fill();

        if (total > 0) {
          // Color blend based on red/blue ratio
          const redRatio = red / total;
          const r1 = Math.round(255 * redRatio + 41 * (1 - redRatio));
          const g1 = Math.round(23 * redRatio + 121 * (1 - redRatio));
          const b1 = Math.round(68 * redRatio + 255 * (1 - redRatio));

          ctx.fillStyle = `rgba(${r1}, ${g1}, ${b1}, ${0.15 + heat * 0.5})`;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 6);
          ctx.fill();

          // Glow border
          ctx.strokeStyle = `rgba(${r1}, ${g1}, ${b1}, ${0.3 + heat * 0.5})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 6);
          ctx.stroke();

          // Count text
          ctx.fillStyle = `rgba(${r1}, ${g1}, ${b1}, 0.9)`;
          ctx.font = `bold ${Math.max(10, 12 + heat * 6)}px Orbitron, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(total, x + w / 2, y + h / 2);
        } else {
          ctx.strokeStyle = "rgba(32, 50, 90, 0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 6);
          ctx.stroke();
        }
      }
    }

    // Grid stats
    const totalNotes = notes.length;
    const redTotal = notes.filter(n => n.c === 0).length;
    const blueTotal = notes.filter(n => n.c === 1).length;
    const doubles = countDoubles(notes);
    const dirs = {};
    const dirNames = ["Up","Down","Left","Right","Up-Left","Up-Right","Down-Left","Down-Right","Any"];
    notes.forEach(n => { dirs[n.d] = (dirs[n.d] || 0) + 1; });
    const topDir = Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 4);

    let statsHTML = '';
    statsHTML += '<div class="grid-stat-row"><div class="grid-stat-dot" style="background:#ff1744"></div><div class="grid-stat-label">Red (Left Hand)</div><div class="grid-stat-val">' + redTotal + ' (' + (redTotal / Math.max(1, totalNotes) * 100).toFixed(0) + '%)</div></div>';
    statsHTML += '<div class="grid-stat-row"><div class="grid-stat-dot" style="background:#2979ff"></div><div class="grid-stat-label">Blue (Right Hand)</div><div class="grid-stat-val">' + blueTotal + ' (' + (blueTotal / Math.max(1, totalNotes) * 100).toFixed(0) + '%)</div></div>';
    statsHTML += '<div class="grid-stat-row"><div class="grid-stat-dot" style="background:#f50057"></div><div class="grid-stat-label">Doubles</div><div class="grid-stat-val">' + doubles + '</div></div>';
    statsHTML += '<div class="grid-stat-row"><div class="grid-stat-dot" style="background:#00e5ff"></div><div class="grid-stat-label">Hand Balance</div><div class="grid-stat-val">' + (Math.min(redTotal, blueTotal) / Math.max(1, Math.max(redTotal, blueTotal)) * 100).toFixed(0) + '%</div></div>';
    statsHTML += '<div style="margin-top:10px;font-family:Orbitron,monospace;font-size:0.5rem;letter-spacing:1.5px;color:var(--text-secondary);text-transform:uppercase">Top Directions</div>';
    for (const [dir, count] of topDir) {
      const pct = (count / totalNotes * 100).toFixed(0);
      statsHTML += '<div class="grid-stat-row"><div class="grid-stat-label">' + dirNames[parseInt(dir)] + '</div><div class="grid-stat-val">' + pct + '%</div></div>';
    }

    if (dom.gridStats) dom.gridStats.innerHTML = statsHTML;
  }

  // ============================================================
  // GENERATION LOG SYSTEM
  // ============================================================

  const genLogEntries = [];

  function logGen(beat, type, detail) {
    genLogEntries.push({ beat, type, detail });
  }

  function clearGenLog() { genLogEntries.length = 0; }

  function renderGenLog() {
    if (!dom.panelLog || !dom.genLog) return;
    dom.panelLog.style.display = "";

    // Show last 100 entries grouped by section
    const entries = genLogEntries.slice(-150);
    let html = '';
    let lastSection = '';

    for (const e of entries) {
      const sec = getSectionAt(beatToTime(e.beat, state.bpm));
      if (sec.type !== lastSection) {
        html += '<div style="margin:6px 0 2px;"><span class="log-section">\u25CF ' + sec.type.toUpperCase() + '</span></div>';
        lastSection = sec.type;
      }
      const beatStr = e.beat.toFixed(1);
      html += '<div><span class="log-time">' + beatStr + '</span>';

      if (e.type === "pattern") {
        html += '<span class="log-pattern">' + e.detail + '</span>';
      } else if (e.type === "warn") {
        html += '<span class="log-warn">' + e.detail + '</span>';
      } else {
        html += e.detail;
      }
      html += '</div>';
    }

    dom.genLog.innerHTML = html;
    dom.genLog.scrollTop = dom.genLog.scrollHeight;
  }

  // ============================================================
  // SECTION TIMELINE CANVAS — visual song structure bar
  // ============================================================
  function drawSectionTimeline() {
    const canvas = $("#section-canvas");
    if (!canvas || !state.sections || state.sections.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const dur = state.audioDuration || 1;
    const colors = {
      intro: "#1a3a5a", verse: "#1a5a3a", chorus: "#5a4a1a",
      drop: "#cc1133", buildup: "#cc7700", break: "#111122", outro: "#1a1a3a",
    };
    // BSMG intensity levels per section type
    const intensityLevel = {
      intro: 0.15, verse: 0.4, buildup: 0.6, chorus: 0.85, drop: 1.0, break: 0.1, outro: 0.2,
    };

    for (const sec of state.sections) {
      const x = (sec.startTime / dur) * W;
      const w = Math.max(2, ((sec.endTime - sec.startTime) / dur) * W);
      const intens = intensityLevel[sec.type] || 0.3;

      // Background bar
      ctx.fillStyle = colors[sec.type] || "#222";
      ctx.fillRect(x, 0, w, H - 14);

      // Intensity fill bar at bottom
      ctx.fillStyle = "rgba(0,229,255,0.3)";
      ctx.fillRect(x, H - 14, w * intens, 4);
      ctx.fillStyle = "rgba(0,229,255,0.6)";
      ctx.fillRect(x, H - 14, w * intens * 0.5, 4);

      // Section label
      ctx.fillStyle = "#ccc";
      ctx.font = "bold 9px Rajdhani, sans-serif";
      if (w > 30) {
        const label = sec.type.toUpperCase();
        ctx.fillText(label, x + 3, 11);
      }
    }

    // Time markers
    ctx.fillStyle = "#445";
    ctx.font = "8px Rajdhani, sans-serif";
    for (let t = 0; t < dur; t += 30) {
      const x = (t / dur) * W;
      ctx.fillText(Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0"), x + 2, H - 2);
    }
  }

  // ============================================================
  // STAR RATING ESTIMATOR — approximate ScoreSaber star values
  // ============================================================
  function estimateStarRating(notes, bpm, duration) {
    if (!notes || notes.length < 5) return 0;
    const nps = notes.length / Math.max(1, duration);
    // Rough ScoreSaber formula: NPS-based with tech/flow modifiers
    let stars = nps * 0.85;
    // Bonus for doubles
    let doubles = 0;
    for (let i = 0; i < notes.length - 1; i++) {
      if (Math.abs(notes[i + 1].b - notes[i].b) < 0.01 && notes[i].c !== notes[i + 1].c) doubles++;
    }
    stars += (doubles / Math.max(1, notes.length)) * 2;
    // BPM scaling
    if (bpm > 160) stars *= 1.1;
    if (bpm > 200) stars *= 1.15;
    return Math.max(0.5, Math.min(14, stars));
  }

  function renderStarRatings(diffs) {
    const el = $("#star-ratings");
    if (!el) return;
    const dur = state.audioDuration || 1;
    let html = '<div style="font-family:Orbitron,monospace;font-size:0.7rem;color:var(--neon-cyan);margin-bottom:6px;">ESTIMATED STAR RATINGS</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
    const diffColors = { Easy: "#40e080", Normal: "#f0a030", Hard: "#ff3898", Expert: "#c080ff", ExpertPlus: "#ff2040" };
    for (const d of diffs) {
      const stars = estimateStarRating(d.data.notes, state.bpm, dur);
      const fullStars = Math.floor(stars);
      const halfStar = stars - fullStars >= 0.5;
      let starStr = "";
      for (let i = 0; i < fullStars && i < 14; i++) starStr += "&#9733;";
      if (halfStar) starStr += "&#189;";
      html += '<div style="background:rgba(0,0,0,0.3);padding:6px 10px;border-radius:6px;border-left:3px solid ' + (diffColors[d.name] || "#fff") + ';">';
      html += '<div style="font-size:0.65rem;color:#888;">' + d.name + '</div>';
      html += '<div style="color:' + (diffColors[d.name] || "#fff") + ';font-size:0.85rem;">' + stars.toFixed(1) + ' ' + starStr + '</div>';
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ============================================================
  // MAP STATS SUMMARY
  // ============================================================
  function renderMapStats(diffs) {
    const el = $("#map-stats");
    if (!el) return;
    const dur = state.audioDuration || 1;
    let html = '<div style="font-family:Orbitron,monospace;font-size:0.7rem;color:var(--neon-cyan);margin-bottom:6px;">MAP STATISTICS</div>';
    html += '<table style="width:100%;font-size:0.7rem;color:#aaa;border-collapse:collapse;">';
    html += '<tr style="color:var(--neon-cyan);border-bottom:1px solid rgba(0,229,255,0.15);">';
    html += '<th style="text-align:left;padding:4px;">Diff</th><th>Notes</th><th>NPS</th><th>Walls</th><th>Bombs</th><th>Arcs</th><th>Chains</th><th>Lights</th>';
    html += '</tr>';
    for (const d of diffs) {
      const dd = d.data;
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">';
      html += '<td style="padding:4px;color:#fff;">' + d.name + '</td>';
      html += '<td style="text-align:center;">' + dd.notes.length + '</td>';
      html += '<td style="text-align:center;">' + (dd.notes.length / dur).toFixed(1) + '</td>';
      html += '<td style="text-align:center;">' + dd.walls.length + '</td>';
      html += '<td style="text-align:center;">' + dd.bombs.length + '</td>';
      html += '<td style="text-align:center;">' + (dd.arcs ? dd.arcs.length : 0) + '</td>';
      html += '<td style="text-align:center;">' + (dd.chains ? dd.chains.length : 0) + '</td>';
      html += '<td style="text-align:center;">' + dd.lighting.length + '</td>';
      html += '</tr>';
    }
    html += '</table>';
    el.innerHTML = html;
  }

  // ============================================================
  // AUTO-PREVIEW DETECTION — find most energetic 10s window
  // ============================================================
  function autoDetectPreviewTime() {
    if (!state.energyCurve || state.energyCurve.length < 100) return 12;
    const dur = state.audioDuration || 1;
    const windowSec = 10;
    const windowSamples = Math.floor((windowSec / dur) * state.energyCurve.length);
    let bestStart = 0, bestSum = 0;
    for (let i = 0; i < state.energyCurve.length - windowSamples; i++) {
      let sum = 0;
      for (let j = 0; j < windowSamples; j++) sum += state.energyCurve[i + j];
      if (sum > bestSum) { bestSum = sum; bestStart = i; }
    }
    return Math.floor((bestStart / state.energyCurve.length) * dur);
  }

  // ============================================================
  // GENRE PRESETS — quick style + settings combinations
  // ============================================================
  const GENRE_PRESETS = {
    edm:      { style: "speed", complexity: 65, density: 60, lighting: 85, env: "EDMEnvironment", diffs: ["Hard", "Expert", "ExpertPlus"] },
    rock:     { style: "balanced", complexity: 55, density: 50, lighting: 70, env: "LinkinParkEnvironment", diffs: ["Normal", "Hard", "Expert"] },
    pop:      { style: "dance", complexity: 40, density: 45, lighting: 75, env: "KDAEnvironment", diffs: ["Easy", "Normal", "Hard", "Expert"] },
    hiphop:   { style: "tech", complexity: 50, density: 45, lighting: 65, env: "HipHopEnvironment", diffs: ["Hard", "Expert", "ExpertPlus"] },
    metal:    { style: "speed", complexity: 80, density: 75, lighting: 90, env: "DragonsEnvironment", diffs: ["Expert", "ExpertPlus"] },
    ambient:  { style: "chill", complexity: 20, density: 25, lighting: 50, env: "OriginsEnvironment", diffs: ["Easy", "Normal", "Hard"] },
    dnb:      { style: "speed", complexity: 70, density: 65, lighting: 80, env: "PyroEnvironment", diffs: ["Hard", "Expert", "ExpertPlus"] },
    jpop:     { style: "dance", complexity: 50, density: 55, lighting: 80, env: "BTSEnvironment", diffs: ["Normal", "Hard", "Expert", "ExpertPlus"] },
    classical:{ style: "chill", complexity: 30, density: 35, lighting: 55, env: "BigMirrorEnvironment", diffs: ["Easy", "Normal", "Hard"] },
    punk:     { style: "balanced", complexity: 60, density: 55, lighting: 75, env: "RockMixtapeEnvironment", diffs: ["Hard", "Expert", "ExpertPlus"] },
    synthwave:{ style: "dance", complexity: 55, density: 50, lighting: 85, env: "WeaveEnvironment", diffs: ["Normal", "Hard", "Expert"] },
    hardcore: { style: "fitness", complexity: 85, density: 80, lighting: 95, env: "ColliderEnvironment", diffs: ["ExpertPlus"] },
    spam:     { style: "spam", complexity: 90, density: 95, lighting: 80, env: "PyroEnvironment", diffs: ["ExpertPlus"] },
    vibro:    { style: "vibro", complexity: 100, density: 100, lighting: 90, env: "EDMEnvironment", diffs: ["ExpertPlus"] },
  };

  function applyPreset(name) {
    const p = GENRE_PRESETS[name];
    if (!p) return;
    const styleEl = $("#cfg-style");
    if (styleEl) styleEl.value = p.style;
    const envEl = $("#cfg-environment");
    if (envEl) envEl.value = p.env;
    const comp = $("#cfg-complexity"), dens = $("#cfg-density"), light = $("#cfg-light-intensity");
    if (comp) { comp.value = p.complexity; const v = $("#val-complexity"); if (v) v.textContent = p.complexity; }
    if (dens) { dens.value = p.density; const v = $("#val-density"); if (v) v.textContent = p.density; }
    if (light) { light.value = p.lighting; const v = $("#val-lighting"); if (v) v.textContent = p.lighting; }
    // Set difficulty checkboxes
    $$(".diff-chips input[type=checkbox]").forEach(cb => {
      cb.checked = p.diffs.includes(cb.value);
    });
  }

  // ============================================================
  // COPY MAP INFO TO CLIPBOARD
  // ============================================================
  function copyMapInfo() {
    if (!state.generatedMap) return;
    const diffs = state.generatedMap.difficulties || [];
    const dur = state.audioDuration || 0;
    const mins = Math.floor(dur / 60), secs = Math.floor(dur % 60);
    const us = getUserSettings();
    let text = "--- BeatForge Map ---\n";
    text += "Song: " + ($("#cfg-song-name").value || "Unknown") + "\n";
    text += "Artist: " + ($("#cfg-song-author").value || "Unknown") + "\n";
    text += "Mapper: " + ($("#cfg-map-author").value || "BeatForge AI") + "\n";
    text += "BPM: " + (state.bpm || "?") + " | Duration: " + mins + ":" + String(secs).padStart(2, "0") + "\n";
    text += "Environment: " + (($("#cfg-environment") || {}).value || "Default") + "\n";
    text += "Style: " + us.style + " | Chroma: " + ($("#tog-chroma") && $("#tog-chroma").checked ? "Yes" : "No") + "\n\n";
    text += "Difficulties:\n";
    for (const d of diffs) {
      const nps = (d.data.notes.length / Math.max(1, dur)).toFixed(1);
      const stars = estimateStarRating(d.data.notes, state.bpm, dur).toFixed(1);
      text += "  " + d.name + ": " + d.data.notes.length + " notes (" + nps + " NPS) ~" + stars + "★";
      text += " | NJS " + (d.data.settings.njs || "?");
      text += " | " + countDoubles(d.data.notes) + " doubles";
      text += " | " + d.data.walls.length + " walls";
      text += " | " + d.data.lighting.length + " lights\n";
    }
    text += "\nGenerated by BeatForge AI — Made by PhantomVoidTTV\nhttps://beatforgemapper.phantomvoid.online";
    navigator.clipboard.writeText(text).then(() => {
      const btn = $("#btn-copy-info");
      if (btn) { btn.textContent = "COPIED!"; setTimeout(() => { btn.textContent = "COPY INFO"; }, 2000); }
    }).catch(() => alert("Copy failed — check permissions"));
  }

  // ============================================================
  // INIT
  // ============================================================

  function init() {
    initBackground();
    setupFileInputs();
    setupAudioPlayer();
    dom.btnGenerate.addEventListener("click", runGeneration);

    // Re-generate button — skip audio analysis, just regenerate patterns
    const btnRegen = $("#btn-regenerate");
    if (btnRegen) {
      btnRegen.addEventListener("click", async () => {
        if (!state.audioBuffer) return;
        btnRegen.disabled = true;
        try {
          await runGeneration(true); // Pass true to skip audio analysis
        } finally {
          btnRegen.disabled = false;
        }
      });
    }
    dom.btnExport.addEventListener("click", () => { if (!state.generatedMap) { alert("Generate a map first!"); return; } exportZip(state.generatedMap); });

    // ArcViewer preview button
    const btnPreview = $("#btn-preview-arc");
    if (btnPreview) btnPreview.addEventListener("click", previewInArcViewer);

    // Re-open last preview
    const btnReopen = $("#btn-reopen-preview");
    if (btnReopen) btnReopen.addEventListener("click", reopenPreview);

    // GitHub config
    const btnSaveGH = $("#btn-save-gh");
    if (btnSaveGH) btnSaveGH.addEventListener("click", saveGitHubConfig);
    loadGitHubConfig(); // Restore saved token/owner/repo

    // Copy preview link
    const btnCopyLink = $("#btn-copy-preview-link");
    if (btnCopyLink) btnCopyLink.addEventListener("click", copyPreviewLink);

    // Show re-open button after first successful preview
    // (re-open becomes visible when preview-share-panel is shown)

    // Genre preset buttons
    $$(".preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        applyPreset(btn.dataset.preset);
        $$(".preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    // Copy info button
    const copyBtn = $("#btn-copy-info");
    if (copyBtn) copyBtn.addEventListener("click", copyMapInfo);

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Don't trigger if typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); if (dom.btnPlay) dom.btnPlay.click(); }
      if (e.code === "Enter" && !e.shiftKey) { e.preventDefault(); if (dom.btnGenerate && !dom.btnGenerate.disabled) dom.btnGenerate.click(); }
      if (e.code === "KeyR" && !e.ctrlKey) { const r = $("#btn-regenerate"); if (r && !r.disabled) r.click(); }
      if (e.code === "KeyE" && !e.ctrlKey) { if (dom.btnExport) dom.btnExport.click(); }
      if (e.code === "KeyP" && !e.ctrlKey) { const p = $("#btn-preview-arc"); if (p && !p.disabled) p.click(); }
    });

    $("#cfg-bpm").addEventListener("change", (e) => { const v = parseFloat(e.target.value); if (v >= 30 && v <= 300) state.bpm = v; });

    // Tap BPM — tap the button to the beat, calculates BPM from tap intervals
    const tapTimes = [];
    const tapBtn = $("#btn-tap-bpm");
    const bpmInfo = $("#bpm-info");
    if (tapBtn) {
      tapBtn.addEventListener("click", () => {
        const now = performance.now();
        // Reset if last tap was > 3 seconds ago
        if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > 3000) {
          tapTimes.length = 0;
        }
        tapTimes.push(now);
        if (tapTimes.length < 2) {
          if (bpmInfo) bpmInfo.textContent = "Keep tapping...";
          return;
        }
        // Keep last 12 taps
        while (tapTimes.length > 12) tapTimes.shift();
        // Calculate average interval
        let totalInterval = 0;
        for (let i = 1; i < tapTimes.length; i++) {
          totalInterval += tapTimes[i] - tapTimes[i - 1];
        }
        const avgInterval = totalInterval / (tapTimes.length - 1);
        const tapBPM = Math.round(60000 / avgInterval);
        if (tapBPM >= 30 && tapBPM <= 300) {
          state.bpm = tapBPM;
          $("#cfg-bpm").value = tapBPM;
          if (bpmInfo) bpmInfo.textContent = "Tapped: " + tapBPM + " BPM (" + tapTimes.length + " taps)";
        }
      });
    }

    // Track when user manually edits metadata fields
    ["cfg-song-name", "cfg-song-author"].forEach(id => {
      const el = $("#" + id);
      if (el) el.addEventListener("input", () => { el.dataset.userEdited = "true"; });
    });

    // Wire up sliders
    const sliders = [
      { id: "cfg-complexity", valId: "val-complexity" },
      { id: "cfg-light-intensity", valId: "val-lighting" },
      { id: "cfg-density", valId: "val-density" },
      { id: "cfg-njs", valId: "val-njs" },
      { id: "cfg-offset", valId: "val-offset" },
    ];
    sliders.forEach(s => {
      const el = $("#" + s.id);
      const val = $("#" + s.valId);
      if (el && val) {
        el.addEventListener("input", () => { val.textContent = el.value; });
      }
    });
  }

  // ── AI RESULT PANEL ──────────────────────────────────────────────────────
  function updateAIResultPanel(aiResult) {
    let panel = document.getElementById("panel-ai-result");
    if (!panel) {
      // Inject panel right after panel-generate
      const gen = document.getElementById("panel-generate");
      if (!gen) return;
      panel = document.createElement("section");
      panel.id = "panel-ai-result";
      panel.className = "panel";
      panel.style.cssText = "margin-top:0;border-color:rgba(0,229,255,0.25);background:rgba(0,229,255,0.03);";
      gen.insertAdjacentElement("afterend", panel);
    }

    const topStyles = Object.entries(aiResult.styleProbs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);

    const barHTML = topStyles.map(([label, prob]) => {
      const pct = (prob * 100).toFixed(1);
      const colors = {
        Tech: "#00e5ff", Speed: "#ff1744", Dance: "#e040fb",
        Fit: "#69f0ae", Poodle: "#ffea00", Aesthetic: "#ff9100"
      };
      const col = colors[label] || "#00e5ff";
      return `
        <div style="margin:4px 0;">
          <div style="display:flex;justify-content:space-between;font-family:'Rajdhani',sans-serif;font-size:0.7rem;color:#aaa;margin-bottom:2px;">
            <span style="color:${col};font-weight:600;">${label}</span><span>${pct}%</span>
          </div>
          <div style="height:5px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${col};border-radius:3px;transition:width 0.6s ease;"></div>
          </div>
        </div>`;
    }).join("");

    panel.innerHTML = `
      <div class="panel-header" style="padding:10px 14px 8px;">
        <span class="step-num" style="font-size:0.6rem;padding:2px 6px;">AI</span>
        <h2 style="font-size:0.7rem;">AI ANALYSIS RESULT</h2>
        <span style="margin-left:auto;font-family:'Rajdhani',sans-serif;font-size:0.65rem;color:#69f0ae;">◆ MODEL ACTIVE</span>
      </div>
      <div style="padding:0 14px 12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-family:'Orbitron',monospace;font-size:0.55rem;color:#556;margin-bottom:6px;">STYLE CONFIDENCE</div>
          ${barHTML}
        </div>
        <div>
          <div style="font-family:'Orbitron',monospace;font-size:0.55rem;color:#556;margin-bottom:6px;">CLASSIFICATION</div>
          <div style="font-family:'Orbitron',monospace;font-size:1.1rem;color:#00e5ff;letter-spacing:2px;">${aiResult.style.toUpperCase()}</div>
          <div style="font-size:0.6rem;color:#778;margin:6px 0 10px;">Detected mapping style</div>
          <div style="font-family:'Orbitron',monospace;font-size:0.55rem;color:#556;margin-bottom:4px;">SUGGESTED DIFFICULTY</div>
          <div style="font-family:'Rajdhani',sans-serif;font-size:0.9rem;color:#ff9100;font-weight:700;">${aiResult.diff}</div>
          <div style="font-size:0.6rem;color:#445;margin-top:10px;line-height:1.5;">
            Weights patched: density×${aiResult.mlWeightPatch.densityMul.toFixed(2)},
            home ${(aiResult.mlWeightPatch.preferHomeColumn * 100).toFixed(0)}%,
            range ${(aiResult.mlWeightPatch.movementRange * 100).toFixed(0)}%
          </div>
        </div>
      </div>`;
  }

  // ── BEATSAVER MAP PREVIEW DOWNLOADER ────────────────────────────────────
  // Injected panel lets users search + download BeatSaver maps for preview
  function initBeatSaverDownloader() {
    // Insert panel into the page before panel-tips
    const tipsPanel = document.getElementById("panel-tips");
    if (!tipsPanel || document.getElementById("panel-beatsaver")) return;

    const panel = document.createElement("section");
    panel.id = "panel-beatsaver";
    panel.className = "panel";
    panel.style.cssText = "margin-top:16px;";
    panel.innerHTML = `
      <div class="panel-header">
        <span class="step-num">&#9660;</span>
        <h2>BEATSAVER MAP BROWSER</h2>
      </div>
      <div style="padding:0 2px 4px;">
        <p style="font-size:0.7rem;color:#667;margin-bottom:10px;font-family:'Rajdhani',sans-serif;">
          Search and download published Beat Saber maps directly. Use these to test your setup or study patterns.
        </p>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <input type="text" id="bs-search-input" placeholder="Search song or mapper…"
            style="flex:1;padding:8px 12px;font-family:'Rajdhani',sans-serif;font-size:0.8rem;
            background:rgba(0,0,0,0.35);border:1px solid rgba(0,229,255,0.25);border-radius:6px;
            color:#ccc;outline:none;" />
          <select id="bs-sort"
            style="padding:6px 10px;font-family:'Orbitron',monospace;font-size:0.6rem;
            background:rgba(0,0,0,0.4);border:1px solid rgba(0,229,255,0.25);border-radius:6px;
            color:var(--neon-cyan);outline:none;">
            <option value="Relevance">Relevance</option>
            <option value="Latest">Latest</option>
            <option value="Rating">Rating</option>
            <option value="Curated">Curated</option>
          </select>
          <button id="bs-search-btn"
            style="padding:8px 16px;font-family:'Orbitron',monospace;font-size:0.6rem;letter-spacing:1px;
            background:linear-gradient(135deg,rgba(0,229,255,0.15),rgba(0,100,200,0.15));
            border:1px solid rgba(0,229,255,0.4);color:var(--neon-cyan);border-radius:6px;cursor:pointer;
            transition:all 0.2s;">SEARCH</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
          <label style="font-size:0.6rem;color:#667;display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" id="bs-ranked" style="accent-color:#00e5ff;"> Ranked only
          </label>
          <label style="font-size:0.6rem;color:#667;display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" id="bs-curated" style="accent-color:#00e5ff;"> Curated only
          </label>
          <label style="font-size:0.6rem;color:#667;display:flex;align-items:center;gap:4px;">
            Min NPS: <input type="number" id="bs-min-nps" value="" placeholder="0" min="0" max="30" step="0.5"
              style="width:48px;padding:2px 6px;font-size:0.65rem;background:rgba(0,0,0,0.3);
              border:1px solid rgba(0,229,255,0.15);border-radius:4px;color:#aaa;outline:none;">
          </label>
        </div>
        <div id="bs-status" style="font-size:0.65rem;color:#556;font-family:'Rajdhani',sans-serif;height:16px;margin-bottom:6px;"></div>
        <div id="bs-results" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;max-height:480px;overflow-y:auto;padding-right:4px;"></div>
        <div style="display:flex;justify-content:center;gap:8px;margin-top:10px;">
          <button id="bs-prev-btn" style="display:none;padding:5px 14px;font-family:'Orbitron',monospace;font-size:0.6rem;background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.2);color:#667;border-radius:5px;cursor:pointer;">◀ PREV</button>
          <button id="bs-next-btn" style="display:none;padding:5px 14px;font-family:'Orbitron',monospace;font-size:0.6rem;background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.2);color:var(--neon-cyan);border-radius:5px;cursor:pointer;">NEXT ▶</button>
        </div>
      </div>`;
    tipsPanel.insertAdjacentElement("beforebegin", panel);

    let currentPage = 0;
    let lastQuery = "";
    let lastSort = "Relevance";

    async function doSearch(page) {
      const query = document.getElementById("bs-search-input").value.trim();
      const sort = document.getElementById("bs-sort").value;
      const ranked = document.getElementById("bs-ranked").checked;
      const curated = document.getElementById("bs-curated").checked;
      const minNps = parseFloat(document.getElementById("bs-min-nps").value) || 0;
      const statusEl = document.getElementById("bs-status");
      const resultsEl = document.getElementById("bs-results");

      lastQuery = query;
      lastSort = sort;
      currentPage = page;

      statusEl.textContent = "Searching BeatSaver…";
      statusEl.style.color = "#00e5ff";
      resultsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:#445;font-family:'Rajdhani',sans-serif;font-size:0.8rem;">Loading…</div>`;

      try {
        // Use the BeatSaver search API with CORS proxy fallback
        let url = `https://api.beatsaver.com/search/text/${page}?sortOrder=${sort}`;
        if (query) url += `&q=${encodeURIComponent(query)}`;
        if (ranked) url += `&ranked=true`;
        if (curated) url += `&curated=true`;
        if (minNps > 0) url += `&minNps=${minNps}`;

        const resp = await fetch(url, {
          headers: { "User-Agent": "BeatForge/3.3.0" }
        });

        if (!resp.ok) throw new Error("BeatSaver API returned " + resp.status);
        const data = await resp.json();
        const maps = data.docs || [];

        statusEl.textContent = `${data.totalDocs || maps.length} results · page ${page + 1}`;
        statusEl.style.color = "#556";

        if (maps.length === 0) {
          resultsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:20px;color:#445;font-family:'Rajdhani',sans-serif;">No maps found. Try a different search.</div>`;
          document.getElementById("bs-next-btn").style.display = "none";
          document.getElementById("bs-prev-btn").style.display = "none";
          return;
        }

        resultsEl.innerHTML = maps.map(m => {
          const meta = m.metadata || {};
          const ver = (m.versions || [])[0] || {};
          const stats = m.stats || {};
          const uploader = m.uploader || {};
          const coverUrl = ver.coverURL || "";
          const hash = ver.hash || "";
          const isRanked = (ver.diffs || []).some(d => d.ranked || d.blRanked);
          const isCurated = !!m.curator;
          const downloadUrl = ver.downloadURL || (hash ? `https://cdn.beatsaver.com/${hash.toLowerCase()}.zip` : "");

          return `
            <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(0,229,255,0.1);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;">
              <div style="position:relative;height:80px;overflow:hidden;background:#0a0a12;">
                ${coverUrl ? `<img src="${coverUrl}" style="width:100%;height:100%;object-fit:cover;opacity:0.7;" loading="lazy" onerror="this.style.display='none'">` : ""}
                <div style="position:absolute;inset:0;background:linear-gradient(to bottom,transparent 40%,rgba(0,0,0,0.8));"></div>
                <div style="position:absolute;bottom:6px;left:8px;right:8px;">
                  <div style="font-family:'Orbitron',monospace;font-size:0.6rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(m.metadata?.songName || m.name || "Unknown").substring(0, 35)}</div>
                  <div style="font-size:0.55rem;color:#aaa;font-family:'Rajdhani',sans-serif;">${meta.songAuthorName || ""} · ${uploader.name || ""}</div>
                </div>
                ${isRanked ? `<span style="position:absolute;top:5px;right:5px;font-size:0.5rem;font-family:'Orbitron',monospace;background:rgba(255,215,0,0.2);border:1px solid rgba(255,215,0,0.4);color:#ffd700;padding:1px 5px;border-radius:3px;">RANKED</span>` : ""}
                ${isCurated ? `<span style="position:absolute;top:5px;left:5px;font-size:0.5rem;font-family:'Orbitron',monospace;background:rgba(0,229,255,0.15);border:1px solid rgba(0,229,255,0.3);color:#00e5ff;padding:1px 5px;border-radius:3px;">CURATED</span>` : ""}
              </div>
              <div style="padding:7px 9px;flex:1;">
                <div style="display:flex;gap:8px;font-size:0.55rem;color:#556;font-family:'Rajdhani',sans-serif;margin-bottom:6px;">
                  <span>♪ ${meta.bpm || "?"} BPM</span>
                  <span>▲ ${stats.upvotes || 0}</span>
                  <span>▼ ${stats.downvotes || 0}</span>
                  <span>⬇ ${(stats.downloads || 0) > 999 ? ((stats.downloads/1000).toFixed(1)+"K") : stats.downloads || 0}</span>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
                  ${(ver.diffs || []).map(d => {
                    const dc = {Easy:"#69f0ae",Normal:"#00e5ff",Hard:"#ffd740",Expert:"#ff6d00",ExpertPlus:"#f44336"}[d.difficulty] || "#888";
                    return `<span style="font-size:0.5rem;font-family:'Orbitron',monospace;color:${dc};border:1px solid ${dc}33;padding:1px 4px;border-radius:2px;">${d.difficulty?.replace("ExpertPlus","E+").replace("Expert","Exp") || "?"}</span>`;
                  }).join("")}
                </div>
                <div style="display:flex;gap:5px;">
                  ${downloadUrl ? `
                  <a href="${downloadUrl}" download target="_blank" rel="noopener"
                    style="flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:5px 8px;
                    font-family:'Orbitron',monospace;font-size:0.55rem;letter-spacing:0.5px;
                    background:rgba(0,229,255,0.1);border:1px solid rgba(0,229,255,0.3);
                    color:var(--neon-cyan);border-radius:4px;cursor:pointer;text-decoration:none;transition:all 0.2s;"
                    onmouseover="this.style.background='rgba(0,229,255,0.2)'" onmouseout="this.style.background='rgba(0,229,255,0.1)'">
                    ⬇ ZIP
                  </a>` : `<span style="flex:1;text-align:center;font-size:0.55rem;color:#334;font-family:'Rajdhani',sans-serif;">No download</span>`}
                  <a href="https://beatsaver.com/maps/${m.id}" target="_blank" rel="noopener"
                    style="padding:5px 8px;font-family:'Orbitron',monospace;font-size:0.55rem;
                    background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
                    color:#667;border-radius:4px;cursor:pointer;text-decoration:none;transition:all 0.2s;"
                    onmouseover="this.style.color='#aaa'" onmouseout="this.style.color='#667'">
                    ↗
                  </a>
                </div>
              </div>
            </div>`;
        }).join("");

        // Pagination
        const prevBtn = document.getElementById("bs-prev-btn");
        const nextBtn = document.getElementById("bs-next-btn");
        prevBtn.style.display = page > 0 ? "block" : "none";
        nextBtn.style.display = maps.length === 20 ? "block" : "none";

      } catch (err) {
        statusEl.textContent = "Error: " + err.message;
        statusEl.style.color = "#ff1744";
        resultsEl.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:20px;">
            <div style="color:#ff1744;font-family:'Orbitron',monospace;font-size:0.65rem;margin-bottom:8px;">SEARCH FAILED</div>
            <div style="color:#556;font-family:'Rajdhani',sans-serif;font-size:0.7rem;">${err.message}</div>
            <div style="color:#334;font-size:0.6rem;margin-top:6px;">BeatSaver API may be temporarily unavailable. Try again in a moment.</div>
          </div>`;
        document.getElementById("bs-next-btn").style.display = "none";
        document.getElementById("bs-prev-btn").style.display = "none";
      }
    }

    document.getElementById("bs-search-btn").addEventListener("click", () => doSearch(0));
    document.getElementById("bs-search-input").addEventListener("keydown", e => {
      if (e.key === "Enter") doSearch(0);
    });
    document.getElementById("bs-next-btn").addEventListener("click", () => doSearch(currentPage + 1));
    document.getElementById("bs-prev-btn").addEventListener("click", () => doSearch(Math.max(0, currentPage - 1)));

    // Load top-rated maps on open
    doSearch(0);
  }

  init();
  initBeatSaverDownloader();
})();

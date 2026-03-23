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
    sectionTimeline: $("#section-timeline"),
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
  // Row placement — balanced across 3 rows with top for emphasis
  // Target: ~45% bottom, ~40% middle, ~15% top
  function getTargetRow(dir, energy, section, swingCount) {
    const swing = swingCount || 0;

    // DROP/CHORUS: use all 3 rows based on energy
    if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
      if (energy > 0.7 && IS_DOWN.includes(dir) && swing % 5 === 0) return 2; // Top row every 5th swing on strong beats
      if (IS_DOWN.includes(dir)) return swing % 3 === 0 ? 1 : 0; // Alternate mid/bottom for down
      if (IS_UP.includes(dir)) return 0;
      return 1;
    }

    // BUILDUP: gradually introduce top row
    if (section.type === SEC.BUILDUP) {
      if (energy > 0.65 && IS_DOWN.includes(dir) && swing % 6 === 0) return 2;
      if (IS_DOWN.includes(dir)) return 1;
      return 0;
    }

    // VERSE/INTRO/BREAK: mostly bottom two rows, rare middle
    if (IS_DOWN.includes(dir)) return swing % 4 === 0 ? 1 : 0; // Mostly bottom, some middle
    if (IS_UP.includes(dir)) return 0;
    return 1;
  }

  function getDirColumnBias(dir, hand) {
    if (IS_LEFT.includes(dir))  return hand === C.RED ? 1 : 0;
    if (IS_RIGHT.includes(dir)) return hand === C.RED ? -1 : 0;
    return 0;
  }

  // Core position selection — natural human-like grid movement
  function getFlowPosition(hand, dir, hs, section, energy) {
    const state_h = hs[hand];
    const terr = TERRITORY[hand];
    const home = HOME[hand];
    const idealY = getTargetRow(dir, energy, section, state_h.swingCount);
    const colBias = getDirColumnBias(dir, hand);
    const gap = state_h.lastBeat < -5 ? 99 : 0;
    const mlBias = getMLPositionBias();

    let prevX = gap > 5 ? home.x : state_h.lastX;
    let prevY = gap > 5 ? home.y : state_h.lastY;

    // Y: move toward ideal row, max 1 step
    let targetY = idealY;
    if (Math.abs(targetY - prevY) > 1) {
      targetY = prevY + (targetY > prevY ? 1 : -1);
    }
    // Pull back from top row unless high energy
    if (prevY === 2 && targetY === 2 && energy < 0.75) targetY = 1;

    // X: varied movement based on section and swing count
    let targetX = prevX;
    const swingNum = state_h.swingCount || 0;

    if (section.type === SEC.VERSE || section.type === SEC.INTRO || section.type === SEC.BREAK) {
      // Calm: mostly home column, occasional small movements
      if (swingNum % 4 === 0 && prevX !== home.x) {
        targetX = prevX + (home.x > prevX ? 1 : -1); // Return home every 4 swings
      } else {
        targetX = prevX + colBias;
      }
    } else if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
      // Energetic: wider movement pattern — alternate between home and edge
      if (energy > 0.6 && swingNum % 6 < 2) {
        // Move toward edge for variety
        targetX = hand === C.RED ? Math.max(0, prevX - 1) : Math.min(3, prevX + 1);
      } else if (swingNum % 6 >= 4) {
        // Return toward home
        targetX = prevX + (home.x > prevX ? 1 : home.x < prevX ? -1 : 0);
      } else {
        targetX = prevX + colBias;
      }
    } else if (section.type === SEC.BUILDUP) {
      // Buildup: gradually widen from home
      const buildProgress = energy;
      if (Math.random() < buildProgress * 0.3) {
        targetX = prevX + (Math.random() > 0.5 ? 1 : -1);
      } else {
        targetX = prevX + colBias;
      }
    } else {
      targetX = prevX + colBias;
    }

    // ML home bias — but less aggressive than before
    if (Math.random() < mlBias.homeStrength * 0.3 && targetX !== home.x) {
      targetX = prevX + (home.x > prevX ? 1 : home.x < prevX ? -1 : 0);
    }

    // Clamp
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

    // BPM detection — multi-method voting
    if (!$("#cfg-bpm").value) {
      state.bpm = detectBPM(state.onsets, state.audioDuration);
      // Safety clamp — NEVER allow BPM outside 60-200
      state.bpm = Math.max(60, Math.min(200, state.bpm || 120));
      $("#cfg-bpm").value = state.bpm;
      // Log detection info
      const eBPM = detectBPMFromEnergy();
      const bBPM = detectBPMFromBass();
      const oBPM = detectBPMFromOnsets(state.onsets);
      console.log("BPM Detection — Energy:", eBPM, "Bass:", bBPM, "Onset:", oBPM, "→ Final:", state.bpm);
      const bpmInfoEl = $("#bpm-info");
      if (bpmInfoEl) {
        const methods = [];
        if (eBPM > 0) methods.push("Energy:" + eBPM);
        if (bBPM > 0) methods.push("Bass:" + bBPM);
        if (oBPM > 0) methods.push("Onset:" + oBPM);
        bpmInfoEl.textContent = methods.join(" · ") + " → " + state.bpm;
      }
    } else {
      state.bpm = Math.max(60, Math.min(200, parseFloat($("#cfg-bpm").value) || 120));
    }

    // Variable BPM regions
    state.bpmRegions = detectBPMRegions(state.onsets, state.audioDuration, state.bpm);
    if (state.bpmRegions.length > 1) {
      logGen(0, "pattern", "Variable BPM detected: " + state.bpmRegions.map(r =>
        r.bpm + " BPM (" + r.startTime.toFixed(1) + "s-" + r.endTime.toFixed(1) + "s)"
      ).join(", "));
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
    // Adaptive window size — larger for slow songs (more context)
    const wl = Math.min(25, Math.max(10, Math.floor(flux.length / 200)));
    const mul = 1.5;
    const minGap = 0.05;

    for (let i = wl; i < flux.length - wl; i++) {
      let mean = 0;
      for (let j = i - wl; j < i + wl; j++) mean += flux[j];
      mean /= (wl * 2);

      // Adaptive threshold — lower for quiet sections
      const threshold = Math.max(0.002, mean * mul);
      if (flux[i] > threshold && flux[i] >= flux[Math.max(0, i - 1)] && flux[i] >= flux[Math.min(flux.length - 1, i + 1)]) {
        const t = (i * hopSize) / sampleRate;
        if (onsets.length === 0 || t - onsets[onsets.length - 1] > minGap) {
          // Store onset with strength for energy mapping
          onsets.push(t);
        }
      }
    }

    // If very few onsets detected (slow/quiet song), lower thresholds and retry
    if (onsets.length < 20 && flux.length > 100) {
      onsets.length = 0;
      for (let i = wl; i < flux.length - wl; i++) {
        let mean = 0;
        for (let j = i - wl; j < i + wl; j++) mean += flux[j];
        mean /= (wl * 2);
        if (flux[i] > mean * 1.2 && flux[i] > 0.001) {
          const t = (i * hopSize) / sampleRate;
          if (onsets.length === 0 || t - onsets[onsets.length - 1] > 0.08) onsets.push(t);
        }
      }
    }

    return onsets;
  }

  function detectBPM(onsets, duration) {
    const energyBPM = detectBPMFromEnergy();
    const onsetBPM = detectBPMFromOnsets(onsets);
    const bassBPM = detectBPMFromBass();

    // HARD FILTER: only accept candidates in 60-200 range
    const candidates = [energyBPM, onsetBPM, bassBPM].filter(b => b >= 60 && b <= 200);
    if (candidates.length === 0) return 120; // Safe default

    // Find agreement
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (Math.abs(candidates[i] - candidates[j]) <= 3) {
          return Math.max(60, Math.min(200, Math.round((candidates[i] + candidates[j]) / 2)));
        }
        if (Math.abs(candidates[i] - candidates[j] * 2) <= 4) return Math.max(60, Math.min(200, candidates[i]));
        if (Math.abs(candidates[i] * 2 - candidates[j]) <= 4) return Math.max(60, Math.min(200, candidates[j]));
      }
    }

    // No agreement — prefer BPM in 90-160 range
    const ranked = candidates.map(b => ({ b, score: (b >= 90 && b <= 160) ? 2 : (b >= 70 && b <= 180) ? 1 : 0 }));
    ranked.sort((a, b) => b.score - a.score);
    return Math.max(60, Math.min(200, ranked[0].b));
  }

  // Energy curve autocorrelation — THE most reliable BPM method
  function detectBPMFromEnergy() {
    const curve = state.energyCurve;
    if (!curve || curve.length < 200) return 0;

    // Normalize energy curve
    const max = Math.max(...curve);
    if (max < 0.001) return 0;
    const norm = curve.map(v => v / max);

    // Autocorrelation across BPM range 60-200
    // Each lag corresponds to a beat period
    const sr = curve.length / state.audioDuration; // Samples per second of energy curve
    const minLag = Math.floor(sr * 60 / 200); // 200 BPM
    const maxLag = Math.floor(sr * 60 / 60);  // 60 BPM
    const len = norm.length;

    let bestLag = 0, bestCorr = -1;
    for (let lag = minLag; lag <= Math.min(maxLag, len / 2); lag++) {
      let corr = 0, count = 0;
      for (let i = 0; i < len - lag; i++) {
        corr += norm[i] * norm[i + lag];
        count++;
      }
      corr /= count;
      // Weight toward common BPM ranges (80-160)
      const bpm = (sr * 60) / lag;
      const rangeBonus = (bpm >= 80 && bpm <= 160) ? 1.1 : 1.0;
      corr *= rangeBonus;

      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    if (bestLag === 0) return 0;
    let bpm = Math.round((sr * 60) / bestLag);

    // Normalize to 60-200 range
    while (bpm < 60) bpm *= 2;
    while (bpm > 200) bpm = Math.round(bpm / 2);

    return bpm;
  }

  // Bass curve autocorrelation — great for kick drum detection in EDM
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

    const intervals = [];
    for (let i = 1; i < onsets.length; i++) intervals.push(onsets[i] - onsets[i - 1]);

    const bpmCounts = {};
    for (const iv of intervals) {
      if (iv < 0.15 || iv > 2.5) continue;
      let bpm = Math.round(60 / iv);
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm = Math.round(bpm / 2);
      bpmCounts[bpm] = (bpmCounts[bpm] || 0) + 1;
      bpmCounts[bpm - 1] = (bpmCounts[bpm - 1] || 0) + 0.3;
      bpmCounts[bpm + 1] = (bpmCounts[bpm + 1] || 0) + 0.3;
    }

    let bestBPM = 0, bestCount = 0;
    for (const [b, c] of Object.entries(bpmCounts)) {
      const bi = parseInt(b);
      const smoothed = (bpmCounts[bi - 2] || 0) * 0.3 + (bpmCounts[bi - 1] || 0) * 0.7 + c +
                       (bpmCounts[bi + 1] || 0) * 0.7 + (bpmCounts[bi + 2] || 0) * 0.3;
      if (smoothed > bestCount) { bestCount = smoothed; bestBPM = bi; }
    }
    return bestBPM;
  }

  // Autocorrelation-based BPM (legacy fallback)
  function autocorrelateBPM(onsets, duration) {
    if (onsets.length < 8) return 0;
    const resolution = 0.01;
    const len = Math.floor(duration / resolution);
    const pulse = new Float32Array(len);
    for (const t of onsets) {
      const idx = Math.floor(t / resolution);
      if (idx < len) pulse[idx] = 1;
    }
    let bestLag = 0, bestCorr = 0;
    const minLag = Math.floor(60 / 200 / resolution);
    const maxLag = Math.floor(60 / 60 / resolution);
    for (let lag = minLag; lag < Math.min(maxLag, len / 2); lag++) {
      let corr = 0;
      for (let i = 0; i < len - lag; i++) corr += pulse[i] * pulse[i + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestLag === 0) return 0;
    let bpm = Math.round(60 / (bestLag * resolution));
    while (bpm < 60) bpm *= 2;
    while (bpm > 200) bpm = Math.round(bpm / 2);
    return bpm;
  }

  // ============================================================
  // VARIABLE BPM DETECTION
  // Analyzes BPM in windows across the song to detect tempo changes
  // ============================================================

  function detectBPMRegions(onsets, duration, primaryBPM) {
    const regions = [];
    if (onsets.length < 8 || duration < 8) {
      // Too short — single BPM
      regions.push({ startTime: 0, endTime: duration, bpm: primaryBPM });
      return regions;
    }

    const windowSize = 8;  // 8-second analysis windows
    const hopSize = 4;     // 4-second hop (50% overlap)
    const windowBPMs = [];

    // Analyze BPM in each window
    for (let start = 0; start < duration - windowSize / 2; start += hopSize) {
      const end = Math.min(start + windowSize, duration);
      const windowOnsets = onsets.filter(t => t >= start && t < end);
      if (windowOnsets.length < 4) {
        windowBPMs.push({ time: start + (end - start) / 2, bpm: primaryBPM });
        continue;
      }

      // Calculate BPM for this window
      const intervals = [];
      for (let i = 1; i < windowOnsets.length; i++) {
        intervals.push(windowOnsets[i] - windowOnsets[i - 1]);
      }

      // IOI histogram for this window
      const bpmVotes = {};
      for (const iv of intervals) {
        if (iv < 0.15 || iv > 3.0) continue;
        let b = Math.round(60 / iv);
        while (b < 30) b *= 2;
        while (b > 200) b /= 2;
        b = Math.round(b);
        bpmVotes[b] = (bpmVotes[b] || 0) + 1;
      }

      // Find peak, smoothed
      let localBPM = primaryBPM, bestCount = 0;
      for (const [bStr, count] of Object.entries(bpmVotes)) {
        const b = parseInt(bStr);
        const smoothed = (bpmVotes[b - 1] || 0) + count + (bpmVotes[b + 1] || 0);
        if (smoothed > bestCount) { bestCount = smoothed; localBPM = b; }
      }

      // Only accept if it has enough votes (confidence)
      if (bestCount < intervals.length * 0.15) localBPM = primaryBPM;

      windowBPMs.push({ time: start + (end - start) / 2, bpm: localBPM });
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
        // BPM changed — close current region
        regions.push({
          startTime: regionStart,
          endTime: windowBPMs[i].time - hopSize / 2,
          bpm: currentBPM,
        });
        regionStart = windowBPMs[i].time - hopSize / 2;
        currentBPM = windowBPMs[i].bpm;
      }
    }
    // Close final region
    regions.push({ startTime: regionStart, endTime: duration, bpm: currentBPM });

    // Filter out tiny regions (< 2 seconds) — merge into neighbors
    const merged = [];
    for (const r of regions) {
      if (r.endTime - r.startTime < 2 && merged.length > 0) {
        merged[merged.length - 1].endTime = r.endTime;
      } else {
        merged.push({ ...r });
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

  function drawSectionTimeline() {
    const total = state.audioDuration;
    let html = "";
    for (const sec of state.sections) {
      const w = ((sec.endTime - sec.startTime) / total * 100).toFixed(2);
      html += '<div class="section-block sec-' + sec.type + '" style="width:' + w + '%">' + sec.type + '</div>';
    }
    dom.sectionTimeline.innerHTML = html;
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
    // Use generation seed to shift the random selection
    const idx = Math.floor(Math.random() * arr.length);
    return arr[(idx + state.genSeed) % arr.length];
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
    return {
      style: ($("#cfg-style") || {}).value || "balanced",
      complexity: parseInt(($("#cfg-complexity") || {}).value || "50"),
      lightIntensity: parseInt(($("#cfg-light-intensity") || {}).value || "70"),
      density: parseInt(($("#cfg-density") || {}).value || "50"),
    };
  }

  function generateDifficulty(diffName) {
    const us = getUserSettings();
    const settings = getDiffSettings(diffName, state.bpm, us.style, us.complexity, us.density);
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
      }
    }

    if (secType === SEC.BREAK || secType === SEC.INTRO || secType === SEC.OUTRO) return p.lo;
    if (secType === SEC.VERSE) return energy > 0.45 ? p.md : p.lo;
    if (secType === SEC.BUILDUP) return energy > 0.5 ? p.hi : p.md;
    return energy > 0.35 ? p.hi : p.md;
  }

  // Grid step — much finer for higher diffs (this controls how often patterns CAN be placed)
  function getGridStep(diff, secType) {
    const base = { Easy: 2, Normal: 1, Hard: 0.5, Expert: 0.5, ExpertPlus: 0.25 };
    let s = base[diff] || 0.5;
    // Only widen for breaks/intros, not as aggressively
    if (secType === SEC.BREAK || secType === SEC.INTRO) s = Math.max(s, 1);
    return s;
  }

  function generateNotes(unused, bpm, settings, totalBeats) {
    const notes = [];
    const diffName = settings.diffName || "Expert";
    const useVBPM = state.bpmRegions.length > 1;

    // Hand parity state
    const hs = {
      [C.RED]:  { lastBeat: -10, lastDir: D.DOWN, lastX: 1, lastY: 0, swingCount: 0, parity: "fore" },
      [C.BLUE]: { lastBeat: -10, lastDir: D.DOWN, lastX: 2, lastY: 0, swingCount: 0, parity: "fore" },
    };

    let beat = 0.5;
    let lastPatEnd = -4;

    const diffGaps = { Easy: { drop: 1.5, verse: 2.5, quiet: 4 }, Normal: { drop: 1, verse: 1.5, quiet: 3 },
                       Hard: { drop: 0.5, verse: 1, quiet: 2 }, Expert: { drop: 0.25, verse: 0.5, quiet: 1.5 },
                       ExpertPlus: { drop: 0, verse: 0.25, quiet: 1 } };
    const diffProbs = { Easy: { drop: 0.7, verse: 0.5, quiet: 0.3 }, Normal: { drop: 0.8, verse: 0.6, quiet: 0.35 },
                        Hard: { drop: 0.9, verse: 0.7, quiet: 0.4 }, Expert: { drop: 0.95, verse: 0.8, quiet: 0.45 },
                        ExpertPlus: { drop: 0.98, verse: 0.9, quiet: 0.5 } };
    const gaps = diffGaps[diffName] || diffGaps.Hard;
    const probs = diffProbs[diffName] || diffProbs.Hard;

    while (beat < totalBeats - 1) {
      const t = useVBPM ? beatToTimeVBPM(beat) : beatToTime(beat, bpm);
      if (t >= state.audioDuration) break;
      const localBPM = useVBPM ? getBPMAtTime(t) : bpm;
      const section = getSectionAt(t);
      const energy = getEnergyAtTime(t);
      const bass = getNormBassAt(t);
      const mid = getNormMidAt(t);
      const high = getNormHighAt(t);
      const gridStep = getGridStep(diffName, section.type);

      // Skip truly silent beats
      if (energy < 0.08) { beat += gridStep; continue; }

      // Breathing room
      const minGap = (section.type === SEC.DROP || section.type === SEC.CHORUS) ? gaps.drop :
                     (section.type === SEC.VERSE || section.type === SEC.BUILDUP) ? gaps.verse : gaps.quiet;
      if (beat - lastPatEnd < minGap) { beat += gridStep; continue; }

      // MUSIC-REACTIVE: Check if there's an actual onset near this beat
      const hasOnset = state.onsets.some(o => Math.abs(o - t) < 0.08);

      // Probability gated by onset presence — much more likely to place on real beats
      const baseProb = (section.type === SEC.BREAK || section.type === SEC.INTRO || section.type === SEC.OUTRO) ? probs.quiet :
                   (section.type === SEC.VERSE) ? probs.verse : probs.drop;
      const prob = hasOnset ? Math.min(1, baseProb + 0.3) : baseProb * 0.5;
      if (Math.random() > prob) { beat += gridStep; continue; }

      // SPECTRAL-MATCHED PATTERN SELECTION
      // Bass hits → emphasis patterns (doubles, towers, dsd)
      // Mid hits → standard alternating patterns
      // High hits → fast short patterns (half-beat alternating)
      const bpmFactor = localBPM > 170 ? 0.8 : localBPM > 140 ? 0.9 : 1.0;
      let patName;

      if (bass > 0.65 && energy > 0.5) {
        // BASS HIT — use emphasis patterns
        const emphasisPool = diffName === "Easy" || diffName === "Normal"
          ? ["double", "altRL", "altLR"]
          : ["double", "dsd", "followDouble", "gallop4", "altDouble4", "window"];
        patName = pickRandom(emphasisPool);
      } else if (high > 0.5 && mid < 0.4 && energy > 0.3) {
        // HIGH FREQUENCY (hihat/cymbal) — fast light patterns
        const hiPool = diffName === "Easy" || diffName === "Normal"
          ? ["singleR", "singleB", "altRL"]
          : ["halfAltRL", "halfAltLR", "tripleAlt", "kickHatSnare"];
        patName = pickRandom(hiPool);
      } else {
        // GENERAL — use standard pool based on section + energy
        const pool = getPatPool(diffName, section.type, energy * bpmFactor, settings.style);
        patName = pickRandom(pool);
      }

      const pattern = PAT[patName];
      if (!pattern || pattern.length === 0) { beat += 2; lastPatEnd = beat; continue; }

      let maxOff = 0;
      const placed = [];
      let valid = true;

      for (const step of pattern) {
        const nb = beat + step.off;
        if (nb >= totalBeats - 0.5) { valid = false; break; }
        maxOff = Math.max(maxOff, step.off);
        if (step.hand === -1) {
          placeGridNote(placed, nb, C.RED, hs, section, energy);
          placeGridNote(placed, nb, C.BLUE, hs, section, energy);
        } else if (step.hand === -2) {
          const dir = hs[C.RED].parity === "fore" ? D.DOWN : D.UP;
          const row = IS_DOWN.includes(dir) ? 1 : 0;  // Middle or bottom, never top
          placed.push({ b: nb, x: 1, y: row, c: C.RED, d: dir, a: 0 });
          placed.push({ b: nb, x: 2, y: row, c: C.BLUE, d: dir, a: 0 });
          flipParity(hs, C.RED, dir, nb, 1, row);
          flipParity(hs, C.BLUE, dir, nb, 2, row);
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
  const HAND_FORE_DIRS = {
    [C.RED]:  [D.DOWN, D.DOWN_LEFT, D.DOWN_RIGHT],  // Forehand (palm-down swings)
    [C.BLUE]: [D.DOWN, D.DOWN_RIGHT, D.DOWN_LEFT],
  };
  const HAND_BACK_DIRS = {
    [C.RED]:  [D.UP, D.UP_RIGHT, D.UP_LEFT],        // Backhand (palm-up swings)
    [C.BLUE]: [D.UP, D.UP_LEFT, D.UP_RIGHT],
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

  function scoreCandidate(dir, x, y, hand, hs, beat, section, energy) {
    const h = hs[hand];
    const recent = recentDirs[hand] || [];
    let score = 5.0; // Base score

    // 1. ANGLE QUALITY — reward 180° changes, penalize < 135°
    if (h.lastBeat > -5) {
      const angle = angleDiff(DIR_ANGLE[h.lastDir], DIR_ANGLE[dir]);
      if (angle >= 170) score += 2.0;       // Perfect opposite
      else if (angle >= 135) score += 1.0;   // Good diagonal
      else if (angle >= 90) score -= 0.5;    // Acceptable but not great
      else score -= 3.0;                      // Wrist breaker
    }

    // 2. POSITION VARIETY — penalize staying in same cell, reward movement
    if (h.lastBeat > -5) {
      const dx = Math.abs(x - h.lastX);
      const dy = Math.abs(y - h.lastY);
      if (dx === 0 && dy === 0) score -= 1.0;     // Same cell = boring
      else if (dx <= 1 && dy <= 1) score += 0.5;   // Smooth 1-cell move = good
      else score -= 0.5;                             // Teleporting = bad
    }

    // 3. REPETITION PENALTY — attention over recent 6 directions
    if (recent.length >= 3) {
      let repeatCount = 0;
      for (const rd of recent) { if (rd === dir) repeatCount++; }
      // Penalize directions that appear more than twice in recent history
      if (repeatCount >= 3) score -= 1.5;
      else if (repeatCount >= 2) score -= 0.5;
    }

    // 4. DIRECTION DIVERSITY — reward using directions not seen recently
    if (recent.length >= 4) {
      const uniqueDirs = new Set(recent);
      if (!uniqueDirs.has(dir)) score += 1.0; // Novel direction = variety bonus
    }

    // 5. MUSICAL ALIGNMENT — reward placement on strong beats
    const beatPos = beat % 1;
    if (Math.abs(beatPos) < 0.05 || Math.abs(beatPos - 0.5) < 0.05) score += 0.5; // On-beat
    if (energy > 0.7) score += 0.5; // High energy moment

    // 6. SECTION AWARENESS — different sections prefer different patterns
    if (section.type === SEC.VERSE || section.type === SEC.BREAK) {
      // Calm sections: reward simple down/up, penalize diagonals
      if (dir === D.DOWN || dir === D.UP) score += 0.5;
    } else if (section.type === SEC.DROP || section.type === SEC.CHORUS) {
      // Energetic: reward variety including diagonals
      if (dir !== D.DOWN && dir !== D.UP) score += 0.3;
    }

    // 7. HAND NATURAL PREFERENCE
    if (hand === C.RED) {
      if (dir === D.DOWN_LEFT || dir === D.UP_RIGHT) score += 0.3; // Natural for left hand
    } else {
      if (dir === D.DOWN_RIGHT || dir === D.UP_LEFT) score += 0.3; // Natural for right hand
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

    // Pick direction based on parity + angle safety
    let dir;
    if (h.lastBeat < -5) {
      // First note — always straight down
      dir = D.DOWN;
    } else if (beatGap >= 2.5) {
      // Long gap — parity resets, start fresh with forehand down
      dir = h.parity === "fore" ? D.DOWN : D.UP;
    } else {
      // Use safe follow-up from previous direction
      const safeDirs = SAFE_FOLLOWUPS[h.lastDir];
      if (safeDirs) {
        // Filter to match current parity (fore = down-family, back = up-family)
        const parityPool = h.parity === "fore" ? HAND_FORE_DIRS[hand] : HAND_BACK_DIRS[hand];
        // Prefer "best" (180°), then "good" (135°) that match parity
        const bestMatch = safeDirs.best.filter(d => parityPool.includes(d));
        const goodMatch = safeDirs.good.filter(d => parityPool.includes(d));
        const allSafe = [...bestMatch, ...goodMatch];

        if (allSafe.length > 0) {
          // USE ATTENTION SCORER to pick the best direction
          dir = selectBestDirection(allSafe, hand, hs, beat, section, energy);
        } else {
          // Fallback: straight down or up based on parity
          dir = h.parity === "fore" ? D.DOWN : D.UP;
        }
      } else {
        dir = h.parity === "fore" ? D.DOWN : D.UP;
      }
    }

    // Double-check angle is >= 135° for fast notes, >= 90° for slow
    if (h.lastBeat > -5) {
      const angle = angleDiff(DIR_ANGLE[h.lastDir], DIR_ANGLE[dir]);
      if (angle < 90 || (angle < 135 && beatGap < 1)) {
        // Unsafe angle — force straight opposite
        dir = h.parity === "fore" ? D.DOWN : D.UP;
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
    // PASS 1: Strict parity enforcement per hand
    // BSMG rule: forehand→backhand→forehand. No double-downs or double-ups.
    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);
      for (let i = 1; i < hand.length; i++) {
        const prev = hand[i - 1], curr = hand[i];
        const gap = curr.b - prev.b;

        // Only enforce parity for notes within ~1.5 beats (beyond that is a natural reset)
        if (gap >= 2.0) continue;

        const prevDown = IS_DOWN.includes(prev.d);
        const prevUp = IS_UP.includes(prev.d);
        const prevLeft = prev.d === D.LEFT;
        const prevRight = prev.d === D.RIGHT;
        const currDown = IS_DOWN.includes(curr.d);
        const currUp = IS_UP.includes(curr.d);

        // STRICT: after any down-family swing, next MUST be up-family
        if (prevDown && currDown) {
          // Fix: pick the best up-family follow-up from parity table
          const followups = PARITY_FOLLOWUP[prev.d];
          if (followups && followups.length > 0) {
            curr.d = followups[0]; // Most comfortable option
          } else {
            curr.d = D.UP;
          }
        }
        // STRICT: after any up-family swing, next MUST be down-family
        else if (prevUp && currUp) {
          const followups = PARITY_FOLLOWUP[prev.d];
          if (followups && followups.length > 0) {
            curr.d = followups[0];
          } else {
            curr.d = D.DOWN;
          }
        }
        // Horizontal parity: LEFT must be followed by RIGHT-family, and vice versa
        else if (prevLeft && curr.d === D.LEFT) {
          curr.d = D.RIGHT;
        }
        else if (prevRight && curr.d === D.RIGHT) {
          curr.d = D.LEFT;
        }

        // Fix flow angle using SAFE_FOLLOWUPS for best result
        const angle = angleDiff(DIR_ANGLE[prev.d], DIR_ANGLE[curr.d]);
        const minAngle = gap < 0.75 ? 135 : 90; // Fast notes need 135°+, slower can be 90°+
        if (angle < minAngle) {
          // Use SAFE_FOLLOWUPS to find the best angle-safe direction
          const sf = SAFE_FOLLOWUPS[prev.d];
          if (sf) {
            const candidates = [...sf.best, ...sf.good];
            // Filter to match corrected parity
            const parityOK = IS_DOWN.includes(prev.d)
              ? candidates.filter(d => IS_UP.includes(d))
              : candidates.filter(d => IS_DOWN.includes(d));
            curr.d = parityOK.length > 0 ? parityOK[0] : (IS_DOWN.includes(prev.d) ? D.UP : D.DOWN);
          } else {
            curr.d = IS_DOWN.includes(prev.d) ? D.UP : D.DOWN;
          }
        }

        // Also fix the Y position to match the corrected direction
        const idealY = IS_DOWN.includes(curr.d) ? 1 : 0; // Stay in bottom rows
        if (Math.abs(curr.y - idealY) > 1) {
          curr.y = curr.y + (idealY > curr.y ? 1 : -1);
        }
      }
    }

    // PASS 2: Fix same-cell overlaps between hands
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].x === notes[j].x && notes[i].y === notes[j].y) {
          // Move blue right, red left
          if (notes[j].c === C.BLUE) notes[j].x = Math.min(3, notes[j].x + 1);
          else notes[j].x = Math.max(0, notes[j].x - 1);
        }
      }
    }

    // PASS 3: Prevent handclaps — notes pointing at each other
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].c === notes[j].c) continue; // Same color can't handclap
        const a = notes[i], b = notes[j];
        // Check if arrows point toward each other horizontally
        if (a.y === b.y) {
          if (a.x < b.x && IS_RIGHT.includes(a.d) && IS_LEFT.includes(b.d)) {
            // Handclap! Fix by flipping to parallel
            a.d = D.DOWN; b.d = D.DOWN;
          }
          if (a.x > b.x && IS_LEFT.includes(a.d) && IS_RIGHT.includes(b.d)) {
            a.d = D.DOWN; b.d = D.DOWN;
          }
        }
      }
    }

    // PASS 4: Prevent vision blocks — face notes in center columns
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      // Face notes: columns 1-2, row 1 (middle) — can block vision
      if ((n.x === 1 || n.x === 2) && n.y === 1) {
        // Check if there are notes shortly after that could be blocked
        const hasFollowUp = notes.some(m =>
          m.b > n.b && m.b < n.b + 1.5 && m !== n
        );
        if (hasFollowUp) {
          // Move the face note to a non-blocking position
          if (n.c === C.RED) { n.x = 0; } // Move red to far left
          else { n.x = 3; } // Move blue to far right
        }
      }
    }

    // PASS 5: Prevent sky streams — too many consecutive top-row notes
    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);
      let consecutiveTop = 0;
      for (let i = 0; i < hand.length; i++) {
        if (hand[i].y === 2) {
          consecutiveTop++;
          if (consecutiveTop > 3) {
            // Move to middle row
            hand[i].y = 1;
            consecutiveTop = 0;
          }
        } else {
          consecutiveTop = 0;
        }
      }
    }

    // PASS 6: Prevent arm crossings — red should always be left of blue
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        const a = notes[i], b = notes[j];
        if (a.c === C.RED && b.c === C.BLUE && a.x > b.x + 1) {
          // Red is too far right of blue — swap positions
          const tmp = a.x; a.x = Math.min(b.x, 2); b.x = Math.max(tmp, 1);
        }
        if (a.c === C.BLUE && b.c === C.RED && b.x > a.x + 1) {
          const tmp = b.x; b.x = Math.min(a.x, 2); a.x = Math.max(tmp, 1);
        }
      }
    }

    // PASS 7: Hitbox abuse check — adjacent same-beat, same-color notes pointing opposite
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].c !== notes[j].c) continue;
        const a = notes[i], b = notes[j];
        if (a.x === b.x && Math.abs(a.y - b.y) === 1) {
          if ((IS_DOWN.includes(a.d) && IS_UP.includes(b.d)) || (IS_UP.includes(a.d) && IS_DOWN.includes(b.d))) {
            b.d = a.d;
          }
        }
      }
    }

    // PASS 8: Double readability — simultaneous red+blue should have matching or symmetric dirs
    // BSMG intermediate: doubles must be clearly readable, not random mixed angles
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].b - notes[i].b > 0.01) break;
        if (notes[i].c === notes[j].c) continue;
        const r = notes[i].c === C.RED ? notes[i] : notes[j];
        const b = notes[i].c === C.BLUE ? notes[i] : notes[j];
        // Both should swing same direction (window/parallel) or mirror (symmetric)
        const rDown = IS_DOWN.includes(r.d), bDown = IS_DOWN.includes(b.d);
        const rUp = IS_UP.includes(r.d), bUp = IS_UP.includes(b.d);
        // If one is down and other is up — BAD readability (confusing to see)
        if ((rDown && bUp) || (rUp && bDown)) {
          // Fix: make both match the red hand's direction family
          if (rDown) b.d = D.DOWN;
          else b.d = D.UP;
        }
      }
    }

    // PASS 9: Triangle detection — 3 consecutive same-hand notes forming a triangle shape
    // BSMG: triangles cause ambiguous resets, avoid in Expert/Expert+
    for (let color = 0; color <= 1; color++) {
      const hand = notes.filter(n => n.c === color);
      for (let i = 0; i < hand.length - 2; i++) {
        const a = hand[i], b = hand[i + 1], c = hand[i + 2];
        const gap1 = b.b - a.b, gap2 = c.b - b.b;
        if (gap1 > 1.5 || gap2 > 1.5) continue;
        // Triangle = 3 different directions that create a rotation loop
        const ang1 = angleDiff(DIR_ANGLE[a.d], DIR_ANGLE[b.d]);
        const ang2 = angleDiff(DIR_ANGLE[b.d], DIR_ANGLE[c.d]);
        const ang3 = angleDiff(DIR_ANGLE[a.d], DIR_ANGLE[c.d]);
        // If all three angles are < 135° it's likely a triangle
        if (ang1 < 135 && ang2 < 135 && ang3 < 90) {
          // Fix c to be a clean follow-up of b
          const sf = SAFE_FOLLOWUPS[b.d];
          if (sf) c.d = sf.best[0] || (IS_DOWN.includes(b.d) ? D.UP : D.DOWN);
        }
      }
    }

    // PASS 10: Final top-row cleanup — no more than 15% of notes should be y=2
    const topCount = notes.filter(n => n.y === 2).length;
    if (topCount / Math.max(1, notes.length) > 0.15) {
      // Move excess top-row notes to middle row
      const topNotes = notes.filter(n => n.y === 2);
      const target = Math.floor(notes.length * 0.12);
      let moved = 0;
      for (const n of topNotes) {
        if (moved >= topCount - target) break;
        n.y = 1;
        moved++;
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
    const events = [];
    const spb = 60 / bpm;
    const us = getUserSettings();
    const intensity = us.lightIntensity / 100; // 0-1
    const ET = { BACK: 0, RING: 1, LEFT: 2, RIGHT: 3, CENTER: 4, BOOST: 5, RSPIN: 8, RZOOM: 9, LSPD: 12, RSPD: 13 };
    const V = { OFF: 0, B_ON: 1, B_FL: 2, B_FD: 3, R_ON: 5, R_FL: 6, R_FD: 7, W_ON: 9, W_FL: 10, W_FD: 11 };
    let colorScheme = "blue";
    let envelope = 0;
    // Lighting pattern variation seed — changes every 8 bars for variety
    let patternSeed = Math.floor(Math.random() * 4);

    function ev(beat, et, val, f) {
      events.push({ b: beat, et, i: val, f: Math.min(1, f * intensity) });
    }

    for (let beat = 0; beat < totalBeats; beat += 0.25) {
      const t = beatToTime(beat, bpm);
      if (t > state.audioDuration) break;
      const sec = getSectionAt(t);
      const e = getEnergyAtTime(t);
      const bass = getNormBassAt(t), mid = getNormMidAt(t), high = getNormHighAt(t);
      const isWhole = Math.abs(beat % 1) < 0.01;
      const isHalf = Math.abs(beat % 0.5) < 0.01;
      const isDown = Math.abs(beat % 4) < 0.01;
      const isPhr = state.phrases.some(p => Math.abs(p.time - t) < spb * 0.5);
      const bar = Math.floor(beat / 4);

      // Change lighting pattern every 8 bars
      if (Math.abs(beat % 32) < 0.01) patternSeed = (patternSeed + 1) % 4;

      envelope += (e - envelope) * 0.3;

      // L1: BASS → back lasers with pattern variation
      if (isWhole && bass > 0.25) {
        const bVal = bass > 0.7 ? V.R_FL : bass > 0.5 ? V.B_FL : V.B_ON;
        ev(beat, ET.BACK, bVal, bass * 1.4);
        if (isDown && bass > 0.5) ev(beat, ET.RZOOM, V.B_ON, bass);
      }
      if (isHalf && !isWhole && bass > 0.35) ev(beat, ET.BACK, V.B_FD, bass * 0.5);

      // L2: MID/SNARE → center lights with variation
      if (isWhole && beat % 2 >= 0.99 && mid > 0.25) {
        const si = Math.min(1, mid * 1.5);
        ev(beat, ET.CENTER, V.R_FL, si);
        ev(beat + 0.125, ET.CENTER, V.R_FD, si * 0.6);
      }
      // Verse: warm ambient center
      if (isHalf && mid > 0.45 && sec.type === SEC.VERSE) ev(beat, ET.CENTER, V.B_ON, mid * 0.4);

      // L3: HIGH → side lasers with wave pattern
      if (high > 0.25) {
        // Wave: alternate sides based on pattern seed
        const wavePhase = patternSeed < 2 ? (beat % 0.5 < 0.25) : (beat % 1 < 0.5);
        const side = wavePhase ? ET.LEFT : ET.RIGHT;
        ev(beat, side, high > 0.6 ? V.W_FL : V.B_FD, high * 0.7);
      }
      // Cymbal crashes → both sides
      if (isHalf && high > 0.7) {
        ev(beat, ET.LEFT, V.W_FD, high * 0.8);
        ev(beat, ET.RIGHT, V.W_FD, high * 0.8);
      }

      // L4: Ring — pattern variation
      if (isDown) {
        ev(beat, ET.RING, V.B_ON, envelope);
        ev(beat, ET.RSPIN, V.B_ON, 1.0);
      }
      // Alternate ring behavior per pattern seed
      if (isWhole && beat % 4 === 2) {
        ev(beat, ET.RING, patternSeed % 2 === 0 ? V.B_FD : V.R_FD, envelope * 0.5);
      }
      // Extra ring pulse on beat 3 in high energy
      if (isWhole && beat % 4 === 3 && e > 0.6) {
        ev(beat, ET.RING, V.B_FL, e * 0.6);
      }

      // L5: Laser speed per section (with variation)
      if (isDown) {
        let spd;
        switch (sec.type) {
          case SEC.DROP: spd = 5 + (patternSeed % 3); break;
          case SEC.CHORUS: spd = 3 + (patternSeed % 3); break;
          case SEC.BUILDUP: spd = Math.min(7, 2 + Math.floor(((t - sec.startTime) / Math.max(1, sec.endTime - sec.startTime)) * 6)); break;
          case SEC.VERSE: spd = 1 + (patternSeed % 2); break;
          case SEC.BREAK: spd = 0; break;
          default: spd = 1;
        }
        ev(beat, ET.LSPD, spd, 1);
        ev(beat, ET.RSPD, patternSeed >= 2 ? spd : Math.max(0, spd - 1), 1); // Asymmetric for variety
      }

      // L6: SECTION-SPECIFIC BEHAVIOR

      // BUILDUP: Crescendo with increasing flash density
      if (sec.type === SEC.BUILDUP) {
        const pr = (t - sec.startTime) / Math.max(1, sec.endTime - sec.startTime);
        if (isHalf && pr > 0.3) {
          ev(beat, ET.CENTER, V.W_FL, pr * 0.9);
          ev(beat, ET.BACK, V.B_FL, pr * 0.7);
        }
        // Accelerating ring spins
        if (isWhole && pr > 0.2) ev(beat, ET.RSPIN, V.B_ON, pr);
        // Progressive laser speed ramp
        if (isWhole) {
          const rs = Math.floor(pr * 7);
          ev(beat, ET.LSPD, rs, 1);
          ev(beat, ET.RSPD, rs, 1);
        }
        // Flash density increases
        if (pr > 0.7 && Math.random() < pr * 0.5) {
          ev(beat, ET.LEFT, V.W_FL, pr);
          ev(beat, ET.RIGHT, V.W_FL, pr);
        }
        // PULSE-ECHO — pulse starts at center and echoes outward with delay
        if (isWhole && pr > 0.4) {
          const echoIntensity = pr * 0.8;
          ev(beat, ET.CENTER, V.W_FL, echoIntensity);
          ev(beat + 0.125, ET.BACK, V.B_FL, echoIntensity * 0.7);
          ev(beat + 0.25, ET.LEFT, V.B_FL, echoIntensity * 0.5);
          ev(beat + 0.25, ET.RIGHT, V.B_FL, echoIntensity * 0.5);
          ev(beat + 0.375, ET.RING, V.B_FL, echoIntensity * 0.3);
        }
        // HEARTBEAT — double-pulse at buildup peak
        if (pr > 0.8 && isHalf) {
          ev(beat, ET.CENTER, V.R_FL, 1);
          ev(beat + 0.125, ET.CENTER, V.OFF, 0);
          ev(beat + 0.25, ET.CENTER, V.R_FL, 0.7);
        }
      }

      // DROP: Full power strobing with wave patterns
      if (sec.type === SEC.DROP && e > 0.5) {
        // Pattern variation: alternating strobe styles
        if (patternSeed < 2) {
          // Classic alternating strobe
          const sv = beat % 0.5 < 0.25 ? V.R_FL : V.B_FL;
          ev(beat, ET.CENTER, sv, 1.0);
          ev(beat, ET.BACK, sv, 0.85);
        } else {
          // Wave strobe — travels left to right
          const phase = (beat * 2) % 4;
          if (phase < 1) ev(beat, ET.LEFT, V.R_FL, 1);
          else if (phase < 2) ev(beat, ET.CENTER, V.R_FL, 1);
          else if (phase < 3) ev(beat, ET.RIGHT, V.R_FL, 1);
          else ev(beat, ET.BACK, V.R_FL, 0.9);
        }
        // Bass hits → all flash
        if (isWhole && bass > 0.55) {
          ev(beat, ET.LEFT, V.R_FL, 1);
          ev(beat, ET.RIGHT, V.R_FL, 1);
          ev(beat, ET.RING, V.R_FL, 1);
          ev(beat, ET.RZOOM, V.R_ON, 1);
        }
        // STUTTER STROBE — rapid on/off/on within quarter beat for intense moments
        if (bass > 0.7 && patternSeed >= 2 && isHalf) {
          ev(beat, ET.CENTER, V.R_FL, 1);
          ev(beat + 0.0625, ET.CENTER, V.OFF, 0);
          ev(beat + 0.125, ET.CENTER, V.W_FL, 1);
          ev(beat + 0.1875, ET.CENTER, V.OFF, 0);
          ev(beat + 0.25, ET.CENTER, V.B_FL, 0.9);
        }
        // REVERSE CHASER — right → center → left on strong beats
        if (isWhole && patternSeed < 2 && e > 0.6) {
          ev(beat, ET.RIGHT, V.R_FL, 1);
          ev(beat + 0.25, ET.CENTER, V.R_FL, 1);
          ev(beat + 0.5, ET.LEFT, V.R_FL, 1);
          ev(beat + 0.25, ET.RIGHT, V.R_FD, 0.4);
          ev(beat + 0.5, ET.CENTER, V.R_FD, 0.4);
        }
      }

      // CHORUS: Colorful with mirror/sweep effects + chaser + rainbow
      if (sec.type === SEC.CHORUS) {
        if (isWhole) {
          const cv = patternSeed % 2 === 0 ? (beat % 2 < 1 ? V.B_FL : V.R_FL) : (beat % 4 < 2 ? V.B_FL : V.R_FL);
          ev(beat, ET.CENTER, cv, e);
          ev(beat, ET.RING, cv, e * 0.7);
        }
        // Mirror effect
        if (isHalf && mid > 0.35) {
          if (patternSeed < 2) {
            ev(beat, ET.LEFT, V.B_ON, mid);
            ev(beat, ET.RIGHT, V.R_ON, mid);
          } else {
            ev(beat, ET.LEFT, V.R_ON, mid);
            ev(beat, ET.RIGHT, V.B_ON, mid);
          }
        }
        // CHASER SEQUENCE — light moves: left → center → right → back across 1 beat
        if (isWhole && patternSeed >= 2 && e > 0.5) {
          const chaserColor = bar % 2 === 0 ? V.B_FL : V.R_FL;
          ev(beat, ET.LEFT, chaserColor, 0.9);
          ev(beat + 0.25, ET.CENTER, chaserColor, 0.9);
          ev(beat + 0.5, ET.RIGHT, chaserColor, 0.9);
          ev(beat + 0.75, ET.BACK, chaserColor, 0.7);
          // Trail fade
          ev(beat + 0.25, ET.LEFT, V.B_FD, 0.3);
          ev(beat + 0.5, ET.CENTER, V.B_FD, 0.3);
          ev(beat + 0.75, ET.RIGHT, V.B_FD, 0.3);
        }
        // RAINBOW CYCLE on downbeats — cycle through blue→red→white
        if (isDown) {
          const rainbow = [V.B_FL, V.R_FL, V.W_FL];
          const rIdx = Math.floor(beat / 4) % 3;
          ev(beat, ET.RING, rainbow[rIdx], 0.8);
          ev(beat, ET.BACK, rainbow[(rIdx + 1) % 3], 0.6);
        }
      }

      // VERSE: Subtle ambient with breathing glow and slow sweep
      if (sec.type === SEC.VERSE) {
        if (isDown) {
          ev(beat, ET.BACK, V.B_ON, 0.35);
          ev(beat, ET.CENTER, V.B_FD, 0.25);
          if (bar % 2 === 0) ev(beat, ET.LEFT, V.B_FD, 0.2);
          else ev(beat, ET.RIGHT, V.B_FD, 0.2);
        }
        // BREATHING GLOW — slow sine-wave intensity on ring
        if (isWhole) {
          const breathPhase = Math.sin(beat * Math.PI / 4) * 0.5 + 0.5;
          ev(beat, ET.RING, V.B_ON, breathPhase * 0.3);
        }
        // Gentle accent on strong mid hits
        if (isWhole && mid > 0.5) {
          ev(beat, ET.CENTER, V.B_FL, mid * 0.3);
        }
      }

      // BREAK: Ambient darkness with occasional glimmers
      if (sec.type === SEC.BREAK) {
        if (isDown) {
          ev(beat, ET.CENTER, V.B_FD, 0.15);
          ev(beat, ET.BACK, V.OFF, 0);
          ev(beat, ET.LEFT, V.OFF, 0);
          ev(beat, ET.RIGHT, V.OFF, 0);
        }
        // Occasional glimmer on strong beats
        if (isWhole && mid > 0.4 && Math.random() < 0.3) {
          ev(beat, ET.CENTER, V.B_FL, 0.3);
        }
      }

      // L7: Phrase boundary → color shift + bloom
      if (isPhr) {
        colorScheme = colorScheme === "blue" ? "red" : "blue";
        const bv = colorScheme === "red" ? V.R_FL : V.B_FL;
        [ET.BACK, ET.LEFT, ET.RIGHT, ET.CENTER, ET.RING, ET.RSPIN, ET.RZOOM].forEach(et => ev(beat, et, bv, 1.0));
        events.push({ b: beat, et: ET.BOOST, i: colorScheme === "red" ? 1 : 0, f: 1 });
        patternSeed = (patternSeed + 1) % 4; // Switch pattern at phrase boundaries too
      }

      // L8: Section transition fades
      for (const s of state.sections) {
        if (Math.abs(t - s.startTime) < spb * 0.25 && isWhole) {
          if (s.type === SEC.BREAK || s.type === SEC.OUTRO) {
            [ET.BACK, ET.CENTER, ET.LEFT, ET.RIGHT].forEach(et => ev(beat, et, V.B_FD, 0.1));
          }
          if (s.type === SEC.DROP) {
            // Blackout → explosion
            [ET.BACK, ET.CENTER].forEach(et => { events.push({ b: Math.max(0, beat - 0.25), et, i: V.OFF, f: 0 }); ev(beat, et, V.R_FL, 1); });
            [ET.LEFT, ET.RIGHT, ET.RING].forEach(et => ev(beat, et, V.R_FL, 1));
            ev(beat, ET.RZOOM, V.R_ON, 1);
          }
        }
      }
    }

    // ================================================================
    // END-OF-SONG FADE-OUT
    // Smoothly dim all lights as song ends. Detect energy fade or
    // always fade the last 4 beats.
    // ================================================================
    const fadeCheckStart = totalBeats * 0.8;
    let fadeStartBeat = totalBeats; // Default: no fade
    let peakLateEnergy = 0;

    // Scan for energy drop
    for (let fb = fadeCheckStart; fb < totalBeats; fb += 0.5) {
      const fe = getEnergyAtTime(beatToTime(fb, bpm));
      if (fe > peakLateEnergy) peakLateEnergy = fe;
      if (peakLateEnergy > 0.15 && fe < peakLateEnergy * 0.35 && fadeStartBeat === totalBeats) {
        fadeStartBeat = fb;
      }
    }

    // Always fade last 4 beats even if no energy drop detected
    if (fadeStartBeat >= totalBeats - 1) {
      fadeStartBeat = Math.max(2, totalBeats - 4);
    }

    // Remove any existing events in the fade zone that would conflict
    const preFadeLen = events.length;
    for (let ei = events.length - 1; ei >= 0; ei--) {
      if (events[ei].b >= fadeStartBeat) events.splice(ei, 1);
    }

    // Generate smooth fade
    const fadeDuration = Math.max(1, totalBeats - fadeStartBeat);
    for (let fb = fadeStartBeat; fb < totalBeats; fb += 0.5) {
      const fadeProgress = (fb - fadeStartBeat) / fadeDuration; // 0→1
      const fadeI = Math.max(0, (1 - fadeProgress) * intensity);

      // Dim all groups smoothly
      [ET.BACK, ET.CENTER, ET.LEFT, ET.RIGHT, ET.RING].forEach(et => {
        events.push({ b: rb(fb), et, i: fadeI > 0.1 ? V.B_FD : V.OFF, f: fadeI * 0.4 });
      });

      // Slow lasers
      const spd = Math.max(0, Math.floor((1 - fadeProgress) * 2));
      events.push({ b: rb(fb), et: ET.LSPD, i: spd, f: 1 });
      events.push({ b: rb(fb), et: ET.RSPD, i: spd, f: 1 });
    }

    // Final blackout
    [ET.BACK, ET.CENTER, ET.LEFT, ET.RIGHT, ET.RING].forEach(et => {
      events.push({ b: rb(totalBeats - 0.25), et, i: V.OFF, f: 0 });
    });

    const filtered = events.filter(ev => ev.b >= 0);
    while (filtered.length < MIN_LIGHTING_EVENTS) {
      filtered.push({ b: Math.random() * totalBeats, et: Math.floor(Math.random() * 5), i: 3, f: 0.3 * intensity });
    }
    filtered.sort((a, b) => a.b - b.b);
    return filtered;
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
    return {
      _version: "2.1.0",
      _songName: $("#cfg-song-name").value || "Unknown Song",
      _songSubName: "",
      _songAuthorName: $("#cfg-song-author").value || "Unknown Artist",
      _levelAuthorName: $("#cfg-map-author").value || "BeatForge AI",
      _beatsPerMinute: Math.max(60, Math.min(200, state.bpm || 120)), _shuffle: 0, _shufflePeriod: 0.5,
      _previewStartTime: 12, _previewDuration: 10,
      _songFilename: "song.ogg", _coverImageFilename: getCoverFilename(),
      _environmentName: $("#cfg-environment").value,
      _allDirectionsEnvironmentName: "GlassDesertEnvironment",
      _songTimeOffset: 0,
      _customData: { _editors: { BeatForge: { version: "2.0.0" } } },
      _difficultyBeatmapSets: [{ _beatmapCharacteristicName: "Standard", _difficultyBeatmaps: sorted.map(d => ({ _difficulty: d.name, _difficultyRank: diffRank(d.name), _beatmapFilename: diffFilename(d.name), _noteJumpMovementSpeed: d.data.settings.njs, _noteJumpStartBeatOffset: 0 })) }],
    };
  }

  function diffFilename(n) { return n + "Standard.dat"; }
  function diffRank(n) { return { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 }[n] || 7; }

  function buildDifficultyDat(dd) {
    const { notes, arcs, chains, bombs, walls, lighting, settings } = dd;

    // BPM events — from variable BPM regions (only if song has tempo changes)
    const bpmEvents = [];
    if (state.bpmRegions.length > 1) {
      for (let i = 1; i < state.bpmRegions.length; i++) {
        const r = state.bpmRegions[i];
        const prevR = state.bpmRegions[i - 1];
        // Beat position where this BPM region starts
        let regionBeat = 0;
        for (let j = 0; j < i; j++) {
          regionBeat += ((state.bpmRegions[j].endTime - state.bpmRegions[j].startTime) * state.bpmRegions[j].bpm) / 60;
        }
        bpmEvents.push({ b: rb(regionBeat), m: r.bpm });
      }
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
      basicBeatmapEvents: lighting.map(ev => ({ b: rb(ev.b), et: ev.et, i: ev.i, f: parseFloat(ev.f.toFixed(3)) })),
      colorBoostBeatmapEvents: [],
      waypoints: [],
      lightColorEventBoxGroups: [], lightRotationEventBoxGroups: [],
      lightTranslationEventBoxGroups: [], vfxEventBoxGroups: [],
      _fxEventsCollection: { _fl: [], _il: [] },
      basicEventTypesWithKeywords: { d: [] },
      useNormalEventsAsCompatibleEvents: false,
    };
  }

  function rb(b) { return parseFloat(b.toFixed(4)); }

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
    ctx.font = "24px sans-serif"; ctx.fillText($("#cfg-song-author").value || "AI Generated", 256, 290);
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
    const generatedDiffs = [];
    const total = diffs.length + 2;
    let step = 0;
    try {
      state.genSeed = (state.genSeed + 1) % 100; // New seed each generation
      if (!skipAnalysis) {
        step++; setProgress(step / total, "Analyzing audio..."); await sleep(40);
      }
      for (const dn of diffs) {
        step++;
        setProgress(step / total, "Generating " + dn + (skipAnalysis ? " (re-roll)" : " (ML-optimized)") + "...");
        await sleep(80);
        const dd = generateDifficulty(dn);
        generatedDiffs.push({ name: dn, data: dd, dat: buildDifficultyDat(dd), scores: computeRankScores(dd) });
      }
      step++; setProgress(step / total, "Building Info.dat..."); await sleep(40);
      state.generatedMap = { infoDat: buildInfoDat(generatedDiffs), bpmInfo: buildBPMInfoDat(), difficulties: generatedDiffs };
      setProgress(1, "Map generation complete!");
      showResults(generatedDiffs);
      // Enable re-generate button after first successful generation
      const btnRegen = $("#btn-regenerate");
      if (btnRegen) btnRegen.disabled = false;
    } catch (err) { setProgress(0, "Error: " + err.message); console.error(err); }
    dom.btnGenerate.disabled = false;
  }

  function setProgress(f, t) { dom.progressFill.style.width = (f * 100).toFixed(1) + "%"; dom.progressText.textContent = t; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showResults(diffs) {
    dom.panelResults.style.display = "";
    dom.panelDiffStats.style.display = "";
    let tN = 0, tA = 0, tC = 0, tB = 0, tW = 0, tL = 0, tD = 0;
    for (const d of diffs) { tN += d.data.notes.length; tA += d.data.arcs.length; tC += d.data.chains.length; tB += d.data.bombs.length; tW += d.data.walls.length; tL += d.data.lighting.length; tD += countDoubles(d.data.notes); }
    const us = getUserSettings();
    dom.resultsGrid.innerHTML = rc("Notes", tN) + rc("Doubles", tD) + rc("Arcs", tA) + rc("Chains", tC) + rc("Bombs", tB) + rc("Walls", tW) + rc("Lighting", tL) + rc("Style", us.style);

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
    ];
    sliders.forEach(s => {
      const el = $("#" + s.id);
      const val = $("#" + s.valId);
      if (el && val) {
        el.addEventListener("input", () => { val.textContent = el.value; });
      }
    });
  }

  init();
})();

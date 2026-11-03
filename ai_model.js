/* ============================================================
   BeatForge AI — ONNX Model Integration
   ai_model.js  (load this BEFORE app.js in index.html)

   What it does:
   • Loads model.onnx via onnxruntime-web (runs on GPU via WebGL)
   • Exposes window.BeatForgeAI with methods app.js calls
   • Patches mlWeights with trained values once inference runs
   • Falls back to app.js defaults if model not found

   HOW TO WIRE INTO YOUR SITE:
   In index.html, add these two lines before <script src="app.js">:
     <script src="https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.1/ort.min.js"></script>
     <script src="ai_model.js"></script>
   ============================================================ */

(function () {
  "use strict";

  // ── Config ─────────────────────────────────────────────────────────────────
  const MODEL_URL   = "./model.onnx";  // relative to your site root
  const SEQ_LEN     = 64;
  const FEAT_DIM    = 32;

  const STYLE_LABELS = ["Tech", "Speed", "Dance", "Fit", "Poodle", "Aesthetic"];
  const DIFF_LABELS  = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];

  // ── State ──────────────────────────────────────────────────────────────────
  let _session      = null;   // ort.InferenceSession
  let _modelReady   = false;
  let _loadError    = null;
  let _lastResult   = null;   // cached last inference result

  // ── Load model async (non-blocking) ───────────────────────────────────────
  async function loadModel() {
    if (typeof ort === "undefined") {
      _loadError = "onnxruntime-web not loaded (missing <script> tag)";
      console.warn("[BeatForgeAI]", _loadError);
      return;
    }

    try {
      // Prefer WebGL (GPU), fall back to WASM (CPU)
      ort.env.wasm.numThreads = 2;
      _session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["webgl", "wasm"],
        graphOptimizationLevel: "all",
      });
      _modelReady = true;
      console.log("[BeatForgeAI] Model loaded ✓  (providers:", _session.handler._inferenceHandler?.executionProviders ?? "webgl/wasm", ")");
    } catch (e) {
      _loadError = e.message;
      console.warn("[BeatForgeAI] Model not found — running in rule-based mode.", e.message);
    }
  }

  // ── Feature extraction (mirrors parser.py logic, runs in browser) ──────────
  // Input: notes array from app.js state, bpm, audioDuration
  // Output: Float32Array of shape [1, SEQ_LEN, FEAT_DIM]
  function extractFeatures(notes, bpm, audioDuration) {
    const maxTime  = audioDuration || (notes.length ? notes[notes.length - 1].b / bpm * 60 : 60);
    const window_  = Math.max(maxTime, 1) / SEQ_LEN;
    const data     = new Float32Array(SEQ_LEN * FEAT_DIM);  // row-major

    for (let i = 0; i < SEQ_LEN; i++) {
      const t0    = i * window_;
      const t1    = t0 + window_;
      const bps   = bpm / 60;
      const b0    = t0 * bps;
      const b1    = t1 * bps;
      const chunk = notes.filter(n => n.b >= b0 && n.b < b1);
      const row   = i * FEAT_DIM;

      if (!chunk.length) continue;

      // feat[0] — note density
      data[row + 0] = chunk.length / Math.max(window_, 0.001);

      // feat[1] — color balance
      const left  = chunk.filter(n => n.c === 0).length;
      const right = chunk.filter(n => n.c === 1).length;
      data[row + 1] = right / (left + right + 1e-6);

      // feat[2..10] — direction histogram (9 dirs)
      const dHist = new Float32Array(9);
      chunk.forEach(n => { dHist[Math.min(n.d, 8)] += 1; });
      const dSum = dHist.reduce((a, b) => a + b, 0) + 1e-6;
      for (let d = 0; d < 9; d++) data[row + 2 + d] = dHist[d] / dSum;

      // feat[11,12] — grid spread (std of x and y)
      const xs = chunk.map(n => n.x);
      const ys = chunk.map(n => n.y);
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
      data[row + 11] = Math.sqrt(xs.reduce((a, x) => a + (x - meanX) ** 2, 0) / xs.length);
      data[row + 12] = Math.sqrt(ys.reduce((a, y) => a + (y - meanY) ** 2, 0) / ys.length);
      data[row + 13] = meanX / 3;
      data[row + 14] = meanY / 2;

      // feat[15,16] — inter-note gap stats
      const times = chunk.map(n => n.b).sort((a, b) => a - b);
      const gaps  = times.length > 1 ? times.slice(1).map((t, i) => t - times[i]) : [0];
      const gMean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const gStd  = Math.sqrt(gaps.reduce((a, g) => a + (g - gMean) ** 2, 0) / gaps.length);
      data[row + 15] = gMean;
      data[row + 16] = gStd;

      // feat[17] — obstacle presence (not available in browser context — keep 0)
      // feat[18] — stream flag
      data[row + 18] = (chunk.length >= 4 && gMean < 0.15) ? 1.0 : 0.0;

      // feat[19] — cross-body indicator
      const cross = chunk.filter(n => (n.c === 0 && n.x >= 2) || (n.c === 1 && n.x <= 1)).length;
      data[row + 19] = cross / (chunk.length + 1e-6);

      // feat[20..31] — grid cell occupancy (4×3)
      chunk.forEach(n => {
        const cell = n.y * 4 + Math.min(n.x, 3);
        const idx  = row + 20 + cell;
        data[idx] = Math.min(data[idx] + 0.2, 1.0);
      });
    }

    return data;
  }

  // ── Softmax helper ─────────────────────────────────────────────────────────
  function softmax(logits) {
    const max = Math.max(...logits);
    const exp = logits.map(x => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map(x => x / sum);
  }

  // ── Run inference ──────────────────────────────────────────────────────────
  // notes: app.js notes array
  // Returns { style, styleProbs, diff, diffProbs, mlWeightPatch }
  async function classify(notes, bpm, audioDuration) {
    if (!_modelReady || !_session) {
      return null;  // model not available — app.js will use defaults
    }

    try {
      const raw     = extractFeatures(notes, bpm, audioDuration);
      // Shape: [1, SEQ_LEN, FEAT_DIM]
      const tensor  = new ort.Tensor("float32", raw, [1, SEQ_LEN, FEAT_DIM]);
      const feeds   = { features: tensor };
      const results = await _session.run(feeds);

      const sLogits = Array.from(results.style_logits.data);
      const dLogits = Array.from(results.diff_logits.data);
      const sProbs  = softmax(sLogits);
      const dProbs  = softmax(dLogits);

      const styleIdx = sProbs.indexOf(Math.max(...sProbs));
      const diffIdx  = dProbs.indexOf(Math.max(...dProbs));

      // ── Translate model output → mlWeights patch ─────────────────────────
      // The model tells us what *kind* of map this music suits.
      // We map that onto the existing mlWeights knobs.
      const patch = buildMlWeightPatch(styleIdx, sProbs);

      _lastResult = {
        style:       STYLE_LABELS[styleIdx],
        styleProbs:  Object.fromEntries(STYLE_LABELS.map((s, i) => [s, sProbs[i]])),
        diff:        DIFF_LABELS[diffIdx],
        diffProbs:   Object.fromEntries(DIFF_LABELS.map((d, i) => [d, dProbs[i]])),
        mlWeightPatch: patch,
      };
      return _lastResult;

    } catch (e) {
      console.warn("[BeatForgeAI] Inference error:", e);
      return null;
    }
  }

  // ── Build mlWeights patch from style prediction ────────────────────────────
  // Maps the 6 style classes onto the patPrefs + position knobs
  // that app.js's mlWeights system already uses.
  function buildMlWeightPatch(styleIdx, probs) {
    // Base patch — start from neutral
    const patch = {
      preferHomeColumn: 0.55,
      movementRange:    0.45,
      densityMul:       1.0,
      patPrefs: {
        double: 1.0, stream: 1.0, gallop: 1.0, combo: 1.0,
        single: 1.0, window: 1.0, half: 1.0,
      },
    };

    // Weight each style's contribution proportionally to its probability
    const styleContributions = [
      // Tech
      { preferHomeColumn: 0.50, movementRange: 0.55, densityMul: 0.95,
        patPrefs: { window: 1.45, stream: 0.65, double: 0.85, combo: 1.25, single: 1.1, gallop: 0.9, half: 1.0 } },
      // Speed
      { preferHomeColumn: 0.65, movementRange: 0.35, densityMul: 1.25,
        patPrefs: { stream: 1.55, gallop: 1.4, double: 0.65, window: 0.45, combo: 0.9, single: 0.8, half: 0.7 } },
      // Dance
      { preferHomeColumn: 0.55, movementRange: 0.50, densityMul: 0.90,
        patPrefs: { double: 1.4, combo: 1.3, stream: 0.5, gallop: 0.7, window: 1.1, single: 1.2, half: 1.15 } },
      // Fit
      { preferHomeColumn: 0.45, movementRange: 0.65, densityMul: 1.10,
        patPrefs: { double: 1.6, combo: 1.4, stream: 0.3, gallop: 0.5, window: 1.3, single: 1.1, half: 0.8 } },
      // Poodle
      { preferHomeColumn: 0.40, movementRange: 0.70, densityMul: 0.85,
        patPrefs: { window: 1.6, combo: 1.5, stream: 0.45, double: 0.9, gallop: 0.8, single: 1.3, half: 1.4 } },
      // Aesthetic
      { preferHomeColumn: 0.70, movementRange: 0.30, densityMul: 0.75,
        patPrefs: { single: 1.5, half: 1.4, stream: 0.3, gallop: 0.3, double: 0.8, combo: 0.9, window: 1.0 } },
    ];

    // Weighted blend across all styles
    patch.preferHomeColumn = 0;
    patch.movementRange    = 0;
    patch.densityMul       = 0;
    for (const k of Object.keys(patch.patPrefs)) patch.patPrefs[k] = 0;

    probs.forEach((p, i) => {
      const c = styleContributions[i];
      patch.preferHomeColumn += p * c.preferHomeColumn;
      patch.movementRange    += p * c.movementRange;
      patch.densityMul       += p * c.densityMul;
      for (const k of Object.keys(patch.patPrefs)) {
        patch.patPrefs[k] += p * c.patPrefs[k];
      }
    });

    return patch;
  }

  // ── Apply patch to live mlWeights object ───────────────────────────────────
  // Called from app.js after inference. Blends model guidance with
  // any adaptive learning that's already happened this session.
  function applyPatchToMlWeights(mlWeights, patch, blendStrength = 0.65) {
    if (!patch) return;
    const b = blendStrength;
    const i = 1 - b;

    // Blend: (model * blend) + (current * (1-blend))
    mlWeights.preferHomeColumn = b * patch.preferHomeColumn + i * mlWeights.preferHomeColumn;
    mlWeights.movementRange    = b * patch.movementRange    + i * mlWeights.movementRange;
    mlWeights.densityMul       = b * patch.densityMul       + i * mlWeights.densityMul;

    for (const k of Object.keys(patch.patPrefs)) {
      if (mlWeights.patPrefs[k] !== undefined) {
        mlWeights.patPrefs[k] = b * patch.patPrefs[k] + i * mlWeights.patPrefs[k];
      }
    }
  }

  // ── Status badge helper (shown in UI) ─────────────────────────────────────
  function getStatusHTML() {
    if (_modelReady) {
      return `<span style="color:#00e5ff;font-size:0.6rem;font-family:'Rajdhani',sans-serif;">
        ◆ AI MODEL ACTIVE</span>`;
    }
    if (_loadError) {
      return `<span style="color:#556;font-size:0.6rem;font-family:'Rajdhani',sans-serif;">
        ◇ RULE-BASED MODE</span>`;
    }
    return `<span style="color:#445;font-size:0.6rem;font-family:'Rajdhani',sans-serif;">
      … LOADING MODEL</span>`;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.BeatForgeAI = {
    // Called once on page load — starts async model load
    init: function () {
      loadModel();
    },

    // Check if model is ready
    isReady: function () { return _modelReady; },

    // Run inference on an existing notes array, update mlWeights
    // Usage in app.js:
    //   const result = await window.BeatForgeAI.classifyAndPatch(notes, state.bpm, state.audioDuration, mlWeights);
    //   if (result) logGen(0, "pattern", "AI style: " + result.style + " (" + (result.styleProbs[result.style]*100).toFixed(0) + "%)");
    classifyAndPatch: async function (notes, bpm, audioDuration, mlWeights) {
      const result = await classify(notes, bpm, audioDuration);
      if (result && mlWeights) {
        applyPatchToMlWeights(mlWeights, result.mlWeightPatch);
      }
      return result;
    },

    // Get last result without re-running inference
    getLastResult: function () { return _lastResult; },

    // Get status HTML for display in UI
    getStatusHTML: getStatusHTML,

    // Bare classify (no side-effects)
    classify: classify,
  };

  // Auto-init when script loads
  window.BeatForgeAI.init();

  // Inject a small status badge into the header once DOM is ready
  document.addEventListener("DOMContentLoaded", function () {
    const badges = document.querySelector(".header-badges");
    if (badges) {
      const badge = document.createElement("span");
      badge.id = "ai-status-badge";
      badge.style.cssText = "display:inline-flex;align-items:center;padding:3px 8px;background:rgba(0,229,255,0.06);border:1px solid rgba(0,229,255,0.15);border-radius:3px;";
      badge.innerHTML = getStatusHTML();
      badges.appendChild(badge);

      // Update badge once model loads (poll every 500ms for up to 10s)
      let tries = 0;
      const poll = setInterval(function () {
        tries++;
        badge.innerHTML = getStatusHTML();
        if (_modelReady || _loadError || tries > 20) clearInterval(poll);
      }, 500);
    }
  });

})();

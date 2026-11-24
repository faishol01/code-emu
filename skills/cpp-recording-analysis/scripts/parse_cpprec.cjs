#!/usr/bin/env node

/**
 * parse_cpprec.cjs - Decoder & Learning Analytics Extractor for cpp.wasm Recordings (.cpprec)
 *
 * Usage:
 *   node parse_cpprec.cjs <path-to-recording.cpprec> [--json] [--timeline]
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = [0x43, 0x50, 0x50, 0x52, 0x45, 0x43]; // "CPPREC"
const VERSION = 1;
const TICK_MS = 10;
const T = { USER: 0, ADD: 1, RENAME: 2, DELETE: 3, EDIT: 4, INPUT: 5, CURSOR: 6, LEAVE: 7 };

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  get done() { return this.i >= this.b.length; }
  uint() {
    let r = 0, m = 1, x;
    do {
      if (this.i >= this.b.length) throw new Error('The recording is cut short.');
      x = this.b[this.i++];
      r += (x & 0x7f) * m;
      m *= 128;
    } while (x & 0x80);
    return r;
  }
  sint() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  str() {
    const n = this.uint();
    if (this.i + n > this.b.length) throw new Error('The recording is cut short.');
    const s = Buffer.from(this.b.subarray(this.i, this.i + n)).toString('utf8');
    this.i += n;
    return s;
  }
}

class Context {
  constructor() { this.ends = new Map(); this.at = new Map(); }
  key(e) { return e.user + ':' + e.file + ':' + e.type; }
  expected(e) { return this.ends.get(this.key(e)) || 0; }
  edited(e) {
    const end = e.pos + e.text.length;
    this.ends.set(this.key(e), end);
    if (e.type === T.EDIT) this.at.set(e.user, end);
  }
  lastAt(u) { return this.at.get(u) || 0; }
  moved(e) { this.at.set(e.user, e.head); }
}

function decodeCpprec(bytes) {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a valid cpp.wasm recording (.cpprec) file.');
  }
  if (bytes[6] !== VERSION) {
    throw new Error('Unsupported recording version: ' + bytes[6]);
  }
  let payload = bytes.subarray(8);
  if (bytes[7] & 1) {
    payload = zlib.inflateRawSync(payload);
  }

  const r = new Reader(payload);
  const meta = JSON.parse(r.str());
  const events = [];
  let ticks = 0;
  const ctx = new Context();

  while (!r.done) {
    ticks += r.uint();
    const kind = r.uint();
    const e = { t: ticks * TICK_MS, type: kind & 7, user: Math.floor(kind / 8) };
    switch (e.type) {
      case T.USER: e.name = r.str(); e.color = r.str(); break;
      case T.ADD: e.file = r.uint(); e.name = r.str(); e.code = r.str(); e.input = r.str(); break;
      case T.RENAME: e.file = r.uint(); e.name = r.str(); break;
      case T.DELETE: e.file = r.uint(); break;
      case T.EDIT:
      case T.INPUT:
        e.file = r.uint();
        e.pos = ctx.expected(e) + r.sint();
        e.del = r.uint();
        e.text = r.str();
        ctx.edited(e);
        break;
      case T.CURSOR:
        e.file = r.uint();
        e.anchor = ctx.lastAt(e.user) + r.sint();
        e.head = e.anchor + r.sint();
        ctx.moved(e);
        break;
      case T.LEAVE: break;
      default: break;
    }
    events.push(e);
  }
  return { meta, events };
}

function splice(s, pos, del, text) {
  pos = Math.min(Math.max(0, pos), s.length);
  return s.slice(0, pos) + text + s.slice(Math.min(s.length, pos + del));
}

function analyzeRecording(meta, events) {
  const users = new Map();
  const files = new Map();
  const fileNames = new Map();

  let totalCharsInserted = 0;
  let totalCharsDeleted = 0;
  let editCount = 0;
  let cursorMoves = 0;
  let largeDeletionCount = 0;

  const pauseBuckets = {
    active: 0,      // < 2s
    thinking: 0,    // 2s - 5s
    deliberation: 0,// 5s - 30s
    longIdle: 0     // > 30s
  };

  let lastEventTime = 0;
  const durationMs = events.length ? events[events.length - 1].t : 0;
  const milestones = [
    { pct: 25, t: durationMs * 0.25, captured: false, snapshot: {} },
    { pct: 50, t: durationMs * 0.50, captured: false, snapshot: {} },
    { pct: 75, t: durationMs * 0.75, captured: false, snapshot: {} },
    { pct: 100, t: durationMs, captured: false, snapshot: {} }
  ];

  // Track recent edits to detect struggles / rapid delete cycles
  const struggleEpisodes = [];
  let recentDeletionsInWindow = 0;
  let windowStartTime = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    // Pauses
    if (i > 0) {
      const dtSec = (e.t - lastEventTime) / 1000;
      if (dtSec < 2) pauseBuckets.active += dtSec;
      else if (dtSec < 5) pauseBuckets.thinking += dtSec;
      else if (dtSec < 30) pauseBuckets.deliberation += dtSec;
      else pauseBuckets.longIdle += dtSec;
    }
    lastEventTime = e.t;

    // Track struggles in 10-second rolling windows
    if (e.t - windowStartTime > 10000) {
      if (recentDeletionsInWindow >= 40) {
        struggleEpisodes.push({
          timeSec: Math.round(windowStartTime / 1000),
          deletedChars: recentDeletionsInWindow,
          type: 'high_churn'
        });
      }
      recentDeletionsInWindow = 0;
      windowStartTime = e.t;
    }

    switch (e.type) {
      case T.USER:
        users.set(e.user, e.name);
        break;
      case T.ADD:
        files.set(e.file, e.code || '');
        fileNames.set(e.file, e.name || ('file_' + e.file));
        break;
      case T.RENAME:
        fileNames.set(e.file, e.name);
        break;
      case T.DELETE:
        files.delete(e.file);
        break;
      case T.EDIT:
        editCount++;
        totalCharsInserted += e.text.length;
        totalCharsDeleted += e.del;
        recentDeletionsInWindow += e.del;
        if (e.del >= 15) largeDeletionCount++;

        if (files.has(e.file)) {
          files.set(e.file, splice(files.get(e.file), e.pos, e.del, e.text));
        }
        break;
      case T.CURSOR:
        cursorMoves++;
        break;
      default: break;
    }

    // Milestones check
    for (const m of milestones) {
      if (!m.captured && e.t >= m.t) {
        m.captured = true;
        const snap = {};
        files.forEach((code, fid) => {
          snap[fileNames.get(fid) || ('file_' + fid)] = code;
        });
        m.snapshot = snap;
      }
    }
  }

  // Ensure last milestone is filled
  const finalMilestone = milestones[milestones.length - 1];
  if (!finalMilestone.captured) {
    finalMilestone.captured = true;
    const snap = {};
    files.forEach((code, fid) => {
      snap[fileNames.get(fid) || ('file_' + fid)] = code;
    });
    finalMilestone.snapshot = snap;
  }

  const finalFiles = {};
  files.forEach((code, fid) => {
    finalFiles[fileNames.get(fid) || ('file_' + fid)] = code;
  });

  const netChars = Object.values(finalFiles).reduce((sum, c) => sum + c.length, 0);
  const efficiencyRatio = totalCharsInserted > 0 ? (netChars / totalCharsInserted) : 0;
  const durationMinutes = durationMs / 60000;
  const grossWpm = durationMinutes > 0 ? Math.round((totalCharsInserted / 5) / durationMinutes) : 0;
  const netWpm = durationMinutes > 0 ? Math.round((netChars / 5) / durationMinutes) : 0;

  // C++ Concepts Extracted from final code
  const combinedCode = Object.values(finalFiles).join('\n');
  const detectedConcepts = detectCppConcepts(combinedCode);

  return {
    meta: {
      title: meta.title || 'Untitled Session',
      started: meta.started,
      durationMs,
      durationFormatted: formatDuration(durationMs),
      users: Array.from(users.values()),
      fileCount: files.size
    },
    metrics: {
      totalEvents: events.length,
      editOperations: editCount,
      cursorMovements: cursorMoves,
      totalCharsInserted,
      totalCharsDeleted,
      netCodeLength: netChars,
      editEfficiencyRatio: Number(efficiencyRatio.toFixed(3)),
      typingVelocityGrossWpm: grossWpm,
      typingVelocityNetWpm: netWpm,
      largeDeletionsCount: largeDeletionCount,
      struggleEpisodeCount: struggleEpisodes.length
    },
    pauseDistributionSeconds: {
      activeTyping: Math.round(pauseBuckets.active),
      shortThinking: Math.round(pauseBuckets.thinking),
      deepDeliberation: Math.round(pauseBuckets.deliberation),
      idleOrStuck: Math.round(pauseBuckets.longIdle)
    },
    struggleEpisodes: struggleEpisodes.slice(0, 5),
    detectedConcepts,
    milestones: milestones.map(m => ({
      percentage: m.pct,
      timestampSec: Math.round(m.t / 1000),
      files: Object.keys(m.snapshot).map(name => ({
        name,
        lineCount: m.snapshot[name].split('\n').length,
        charCount: m.snapshot[name].length
      }))
    })),
    finalCode: finalFiles
  };
}

function detectCppConcepts(code) {
  const concepts = [];

  if (/\b(?:int|float|double|char|bool|long)\b/.test(code)) concepts.push('Primitive Types');
  if (/\bfor\s*\(/.test(code)) concepts.push('For Loops');
  if (/\bfor\s*\([^;]+:[^;]+\)/.test(code)) concepts.push('Range-based For Loops');
  if (/\bwhile\s*\(/.test(code)) concepts.push('While Loops');
  if (/\bif\s*\(/.test(code)) concepts.push('Conditionals (if/else)');
  if (/[a-zA-Z_0-9]+\s*\[[^\]]+\]/.test(code)) concepts.push('Arrays (1D)');
  if (/[a-zA-Z_0-9]+\s*\[[^\]]+\]\s*\[[^\]]+\]/.test(code)) concepts.push('Multi-Dimensional Arrays');
  if (/\bvector\s*<.+>/.test(code)) concepts.push('STL std::vector');
  if (/\b(?:map|unordered_map|set|unordered_set)\s*<.+>/.test(code)) concepts.push('STL Associative Containers');
  if (/\b(?:pair|tuple)\b/.test(code)) concepts.push('STL Utility (pair/tuple)');
  if (/(?:std::)?(?:sort|reverse|find|binary_search|lower_bound|accumulate)\s*\(/.test(code)) concepts.push('STL Algorithms');
  if (/\b(?:cin|scanf|getline)\b/.test(code)) concepts.push('Standard Input (I/O)');
  if (/\b(?:cout|printf)\b/.test(code)) concepts.push('Standard Output (I/O)');
  if (/\b(?:struct|class)\b/.test(code)) concepts.push('Object-Oriented (struct/class)');
  if (/\b(?:new|delete|malloc|free)\b/.test(code)) concepts.push('Dynamic Memory Management');
  if (/[a-zA-Z_0-9]+\s*\*\s*[a-zA-Z_0-9]+/.test(code)) concepts.push('Raw Pointers');
  if (/[a-zA-Z_0-9]+&(?:\s+[a-zA-Z_0-9]+)?/.test(code)) concepts.push('Pass-by-Reference');
  if (/\btemplate\s*<.+>/.test(code)) concepts.push('Templates / Generic Programming');
  if (/\[[^\]]*\]\s*\([^)]*\)\s*(?:->\s*[^\{]+)?\s*\{/.test(code)) concepts.push('Lambda Functions');

  return concepts;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node parse_cpprec.cjs <recording.cpprec|recording.json> [--json]');
    process.exit(0);
  }

  const filePath = args[0];
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    let meta, events;
    if (filePath.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      meta = parsed.meta || {};
      events = parsed.events || [];
    } else {
      const bytes = fs.readFileSync(filePath);
      const res = decodeCpprec(bytes);
      meta = res.meta;
      events = res.events;
    }

    const report = analyzeRecording(meta, events);

    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printMarkdownSummary(report);
    }
  } catch (err) {
    console.error('Analysis failed:', err.message);
    process.exit(1);
  }
}

function printMarkdownSummary(r) {
  console.log(`### ⏱️ Session Overview: ${r.meta.title}`);
  console.log(`- **Duration**: ${r.meta.durationFormatted}`);
  console.log(`- **Participants**: ${r.meta.users.join(', ') || 'Anonymous'}`);
  console.log(`- **Total Events**: ${r.metrics.totalEvents} (${r.metrics.editOperations} edits, ${r.metrics.cursorMovements} cursor moves)`);
  console.log(`\n### ⌨️ Velocity & Edit Dynamics`);
  console.log(`- **Inserted Chars**: ${r.metrics.totalCharsInserted} | **Deleted Chars**: ${r.metrics.totalCharsDeleted}`);
  console.log(`- **Net Code Size**: ${r.metrics.netCodeLength} chars`);
  console.log(`- **Edit Efficiency Ratio**: ${r.metrics.editEfficiencyRatio} (Net / Gross)`);
  console.log(`- **Typing Velocity**: ${r.metrics.typingVelocityNetWpm} net WPM (${r.metrics.typingVelocityGrossWpm} gross WPM)`);
  console.log(`- **Large Deletions (>=15 chars)**: ${r.metrics.largeDeletionsCount}`);
  console.log(`- **Churn / Struggle Episodes**: ${r.metrics.struggleEpisodeCount}`);
  console.log(`\n### ⏸️ Cognitive Pause Distribution`);
  console.log(`- **Active Typing (<2s)**: ${r.pauseDistributionSeconds.activeTyping}s`);
  console.log(`- **Brief Thinking (2-5s)**: ${r.pauseDistributionSeconds.shortThinking}s`);
  console.log(`- **Deep Deliberation (5-30s)**: ${r.pauseDistributionSeconds.deepDeliberation}s`);
  console.log(`- **Idle / Roadblock (>30s)**: ${r.pauseDistributionSeconds.idleOrStuck}s`);
  console.log(`\n### 🧠 C++ Concepts Demonstrated`);
  if (r.detectedConcepts.length) {
    console.log(r.detectedConcepts.map(c => `- ${c}`).join('\n'));
  } else {
    console.log(`- (None identified)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { decodeCpprec, analyzeRecording };

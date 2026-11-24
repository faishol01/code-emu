/* cpp.wasm: Learner Progress & Knowledge Analysis
   In-browser AI Skill implementation to evaluate coding sessions and C++ knowledge progression. */
(function () {
  'use strict';

  const T = { USER: 0, ADD: 1, RENAME: 2, DELETE: 3, EDIT: 4, INPUT: 5, CURSOR: 6, LEAVE: 7 };

  function analyzeRecording(meta, events) {
    const R = window.CppRec;
    const splice = (R && R.splice) || function (s, pos, del, text) {
      pos = Math.min(Math.max(0, pos), s.length);
      return s.slice(0, pos) + text + s.slice(Math.min(s.length, pos + del));
    };

    const users = new Map();
    const files = new Map();
    const fileNames = new Map();

    let totalCharsInserted = 0;
    let totalCharsDeleted = 0;
    let editCount = 0;
    let cursorMoves = 0;
    let largeDeletionsCount = 0;

    const pauseBuckets = {
      active: 0,       // < 2s
      thinking: 0,     // 2s - 5s
      deliberation: 0, // 5s - 30s
      longIdle: 0      // > 30s
    };

    let lastEventTime = 0;
    const durationMs = events.length ? events[events.length - 1].t : 0;
    const milestones = [
      { pct: 25, t: durationMs * 0.25, captured: false, snapshot: {} },
      { pct: 50, t: durationMs * 0.50, captured: false, snapshot: {} },
      { pct: 75, t: durationMs * 0.75, captured: false, snapshot: {} },
      { pct: 100, t: durationMs, captured: false, snapshot: {} }
    ];

    const struggleEpisodes = [];
    let recentDeletionsInWindow = 0;
    let windowStartTime = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];

      if (i > 0) {
        const dtSec = (e.t - lastEventTime) / 1000;
        if (dtSec < 2) pauseBuckets.active += dtSec;
        else if (dtSec < 5) pauseBuckets.thinking += dtSec;
        else if (dtSec < 30) pauseBuckets.deliberation += dtSec;
        else pauseBuckets.longIdle += dtSec;
      }
      lastEventTime = e.t;

      if (e.t - windowStartTime > 10000) {
        if (recentDeletionsInWindow >= 40) {
          struggleEpisodes.push({
            timeSec: Math.round(windowStartTime / 1000),
            deletedChars: recentDeletionsInWindow,
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
          if (e.del >= 15) largeDeletionsCount++;

          if (files.has(e.file)) {
            files.set(e.file, splice(files.get(e.file), e.pos, e.del, e.text));
          }
          break;
        case T.CURSOR:
          cursorMoves++;
          break;
        default: break;
      }

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

    const combinedCode = Object.values(finalFiles).join('\n');
    const conceptCategories = categorizeCppConcepts(combinedCode);
    const overallLevel = evaluateOverallLevel(conceptCategories, efficiencyRatio);
    const workflowArchetype = evaluateWorkflowArchetype(milestones, efficiencyRatio, struggleEpisodes.length);

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
        largeDeletionsCount,
        struggleEpisodeCount: struggleEpisodes.length
      },
      pauseDistribution: {
        active: Math.round(pauseBuckets.active),
        thinking: Math.round(pauseBuckets.thinking),
        deliberation: Math.round(pauseBuckets.deliberation),
        longIdle: Math.round(pauseBuckets.longIdle),
        total: Math.max(1, Math.round(pauseBuckets.active + pauseBuckets.thinking + pauseBuckets.deliberation + pauseBuckets.longIdle))
      },
      struggleEpisodes,
      conceptCategories,
      overallLevel,
      workflowArchetype,
      milestones: milestones.map(m => ({
        percentage: m.pct,
        timestampSec: Math.round(m.t / 1000),
        files: Object.keys(m.snapshot).map(name => ({
          name,
          lines: m.snapshot[name].split('\n').length,
          chars: m.snapshot[name].length,
          snippet: m.snapshot[name].slice(0, 150)
        }))
      })),
      finalCode: finalFiles
    };
  }

  function categorizeCppConcepts(code) {
    const categories = {
      level1: { name: 'Level 1: Novice Concepts', items: [] },
      level2: { name: 'Level 2: Developing Concepts', items: [] },
      level3: { name: 'Level 3: Competent Concepts', items: [] },
      level4: { name: 'Level 4: Proficient Concepts', items: [] }
    };

    // Level 1
    if (/\b(?:int|float|double|char|bool|long)\b/.test(code)) categories.level1.items.push('Primitive Data Types');
    if (/\b(?:cin|scanf|getline)\b/.test(code)) categories.level1.items.push('Standard Input (I/O)');
    if (/\b(?:cout|printf)\b/.test(code)) categories.level1.items.push('Standard Output (I/O)');
    if (/\bif\s*\(/.test(code)) categories.level1.items.push('Conditional Branching');
    if (/\b(?:for|while)\s*\(/.test(code)) categories.level1.items.push('Loops & Iteration');
    if (/[a-zA-Z_0-9]+\s*\[[^\]]+\]/.test(code) && !/[a-zA-Z_0-9]+\s*\[[^\]]+\]\s*\[[^\]]+\]/.test(code)) {
      categories.level1.items.push('1D Fixed-Size Arrays');
    }

    // Level 2
    if (/[a-zA-Z_0-9]+\s*\[[^\]]+\]\s*\[[^\]]+\]/.test(code)) categories.level2.items.push('2D Multi-Dimensional Arrays');
    if (/\bvector\s*<.+>/.test(code)) categories.level2.items.push('STL std::vector');
    if (/\bstring\b/.test(code)) categories.level2.items.push('std::string Operations');
    if (/\bstruct\b/.test(code)) categories.level2.items.push('User Structs');
    if (/(?:void|int|double|bool|string)\s+[a-zA-Z_0-9]+\s*\([^)]*\)\s*\{/.test(code)) {
      categories.level2.items.push('User-Defined Functions');
    }

    // Level 3
    if (/[a-zA-Z_0-9]+&(?:\s+[a-zA-Z_0-9]+)?/.test(code)) categories.level3.items.push('Pass-by-Reference (&)');
    if (/\b(?:const\s+[a-zA-Z_0-9]+&|[a-zA-Z_0-9]+(?:\s+const)?&)/.test(code)) categories.level3.items.push('Const References (const&)');
    if (/\b(?:map|unordered_map|set|unordered_set)\s*<.+>/.test(code)) categories.level3.items.push('STL Associative Containers');
    if (/(?:std::)?(?:sort|reverse|find|binary_search|lower_bound|accumulate)\s*\(/.test(code)) {
      categories.level3.items.push('STL Algorithms');
    }
    if (/\bclass\b/.test(code)) categories.level3.items.push('Object-Oriented Classes');

    // Level 4
    if (/\btemplate\s*<.+>/.test(code)) categories.level4.items.push('Generic Templates');
    if (/\[[^\]]*\]\s*\([^)]*\)\s*(?:->\s*[^\{]+)?\s*\{/.test(code)) categories.level4.items.push('Lambda Expressions');
    if (/\b(?:new|delete|malloc|free)\b/.test(code)) categories.level4.items.push('Dynamic Memory Allocation');
    if (/\bfor\s*\([^;]+:[^;]+\)/.test(code)) categories.level4.items.push('Modern Range-Based For Loops');

    return categories;
  }

  function evaluateOverallLevel(cats, efficiency) {
    if (cats.level4.items.length >= 2 || (cats.level3.items.length >= 3 && efficiency >= 0.75)) {
      return { tier: 'Proficient', color: '#2f9e44', bg: 'rgba(47, 158, 68, 0.12)' };
    }
    if (cats.level3.items.length >= 1 || (cats.level2.items.length >= 3 && efficiency >= 0.55)) {
      return { tier: 'Competent', color: '#1c7ed6', bg: 'rgba(28, 126, 214, 0.12)' };
    }
    if (cats.level2.items.length >= 1 || (cats.level1.items.length >= 3 && efficiency >= 0.40)) {
      return { tier: 'Developing', color: '#f59f00', bg: 'rgba(245, 159, 0, 0.12)' };
    }
    return { tier: 'Novice', color: '#7c8798', bg: 'rgba(124, 135, 152, 0.12)' };
  }

  function evaluateWorkflowArchetype(milestones, efficiency, struggleCount) {
    if (efficiency >= 0.70 && struggleCount === 0) {
      return { name: 'Top-Down Architectural', desc: 'Planned structure with confident execution and high edit efficiency.' };
    }
    if (efficiency >= 0.50) {
      return { name: 'Bottom-Up Iterative', desc: 'Constructed logic incrementally with healthy local refinement.' };
    }
    return { name: 'Speculative / Exploratory', desc: 'Frequent backtracking and trial-and-error deletions.' };
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m ${sec}s`;
  }

  function generateAiPrompt(report) {
    const conceptsList = [];
    Object.values(report.conceptCategories).forEach(cat => {
      cat.items.forEach(item => conceptsList.push(`${cat.name.split(':')[0]}: ${item}`));
    });

    const fileEntries = Object.keys(report.finalCode).map(name => {
      return `### File: ${name}\n\`\`\`cpp\n${report.finalCode[name]}\n\`\`\``;
    }).join('\n\n');

    return `# Role & Instruction
You are an expert C++ programming educator and cognitive task evaluator. Analyze the following coding session data extracted from a cpp.wasm session recording (.cpprec).

Evaluate the user's progress, typing dynamics, problem-solving habits, and C++ concept mastery. Provide actionable, supportive pedagogical feedback.

---

## Session Telemetry
- **Session Title**: ${report.meta.title}
- **Duration**: ${report.meta.durationFormatted} (${report.meta.durationMs} ms)
- **Participants**: ${report.meta.users.join(', ') || 'Solo learner'}
- **Total Events**: ${report.metrics.totalEvents} (${report.metrics.editOperations} edits, ${report.metrics.cursorMovements} cursor navigations)
- **Keystrokes**: ${report.metrics.totalCharsInserted} inserted, ${report.metrics.totalCharsDeleted} deleted
- **Net Code Size**: ${report.metrics.netCodeLength} characters
- **Edit Efficiency**: ${report.metrics.editEfficiencyRatio} (Net / Gross characters)
- **Typing Velocity**: ${report.metrics.typingVelocityNetWpm} Net WPM (${report.metrics.typingVelocityGrossWpm} Gross WPM)
- **Struggle Episodes (>=40 chars deleted in 10s)**: ${report.metrics.struggleEpisodeCount}
- **Large Deletions (>=15 chars)**: ${report.metrics.largeDeletionsCount}

## Cognitive Pause Distribution
- **Active Flow (<2s)**: ${report.pauseDistribution.active}s (${Math.round(report.pauseDistribution.active / report.pauseDistribution.total * 100)}%)
- **Micro-Planning (2-5s)**: ${report.pauseDistribution.thinking}s (${Math.round(report.pauseDistribution.thinking / report.pauseDistribution.total * 100)}%)
- **Deliberation (5-30s)**: ${report.pauseDistribution.deliberation}s (${Math.round(report.pauseDistribution.deliberation / report.pauseDistribution.total * 100)}%)
- **Roadblocks / Idle (>30s)**: ${report.pauseDistribution.longIdle}s (${Math.round(report.pauseDistribution.longIdle / report.pauseDistribution.total * 100)}%)

## Detected C++ Constructs
${conceptsList.map(c => `- ${c}`).join('\n') || '- (None detected)'}

## Milestone Timeline Progression
${report.milestones.map(m => `- Milestone ${m.percentage}% (${m.timestampSec}s): ${m.files.map(f => `${f.name} (${f.lines} lines, ${f.chars} chars)`).join(', ')}`).join('\n')}

## Final Code Output
${fileEntries}

---

## Required Output Structure
Please structure your response in clear, encouraging markdown with the following sections:
1. **Executive Summary & Overall Assessment** (Novice, Developing, Competent, or Proficient with justification)
2. **Behavioral & Cognitive Flow Insights** (Interpret edit efficiency, pause distribution, and struggle episodes)
3. **C++ Knowledge & Concept Mastery Matrix** (Demonstrated strengths vs knowledge gaps)
4. **Diagnostic Findings & Antipatterns** (Explain any specific mistakes, compiler struggles, or non-idiomatic patterns)
5. **Actionable Recommendations & Next Coding Drill** (Tailored exercises and best practices)
`;
  }

  // ── UI Modal & Renderer ──────────────────────────────────────────────

  let dialogEl = null;

  function ensureDialog() {
    if (dialogEl) return dialogEl;
    dialogEl = document.getElementById('ai-analysis-dialog');
    if (!dialogEl) return null;

    const closeBtn = document.getElementById('ai-analysis-close');
    const doneBtn = document.getElementById('ai-analysis-done');
    const copyBtn = document.getElementById('ai-analysis-copy-prompt');
    const runBtn = document.getElementById('ai-analysis-run-btn');

    if (closeBtn) closeBtn.addEventListener('click', () => dialogEl.close());
    if (doneBtn) doneBtn.addEventListener('click', () => dialogEl.close());

    dialogEl.addEventListener('click', (e) => {
      const rect = dialogEl.getBoundingClientRect();
      const inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
        && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!inDialog) dialogEl.close();
    });

    return dialogEl;
  }

  function open(item, events) {
    const dialog = ensureDialog();
    if (!dialog) return;

    let evts = events;
    let meta = {};
    if (!evts && item && item.bytes) {
      try {
        const decoded = window.CppRec.decode(item.bytes);
        evts = decoded.events;
        meta = decoded.meta || {};
      } catch (err) {
        alert('Failed to decode recording: ' + err.message);
        return;
      }
    } else if (item) {
      meta = { title: item.title, started: item.created };
    }

    if (!evts || !evts.length) {
      alert('This recording does not contain any event data to analyze.');
      return;
    }

    const report = analyzeRecording(meta, evts);
    renderModalContent(report);
    dialog.showModal();
  }

  function promptFallback(text) {
    if (typeof window !== 'undefined' && window.prompt) {
      window.prompt('Copy AI Analysis Prompt:', text);
    }
  }

  function renderModalContent(r) {
    const body = document.getElementById('ai-analysis-body');
    if (!body) return;
    body.innerHTML = '';

    // Header info
    const sessionMeta = document.createElement('div');
    sessionMeta.className = 'ai-session-meta';
    sessionMeta.innerHTML = `
      <div class="ai-meta-item"><strong>Title:</strong> ${escapeHtml(r.meta.title)}</div>
      <div class="ai-meta-item"><strong>Duration:</strong> ${r.meta.durationFormatted}</div>
      <div class="ai-meta-item"><strong>Events:</strong> ${r.metrics.totalEvents.toLocaleString()}</div>
      <div class="ai-meta-item"><strong>Author:</strong> ${escapeHtml(r.meta.users.join(', ') || 'Anonymous')}</div>
    `;
    body.appendChild(sessionMeta);

    // Scorecard cards
    const scorecard = document.createElement('div');
    scorecard.className = 'ai-scorecard-grid';

    const effPct = Math.round(r.metrics.editEfficiencyRatio * 100);
    const effClass = r.metrics.editEfficiencyRatio >= 0.70 ? 'good' : (r.metrics.editEfficiencyRatio >= 0.45 ? 'warn' : 'crit');

    scorecard.innerHTML = `
      <div class="ai-card">
        <div class="ai-card-lbl">Knowledge Level</div>
        <div class="ai-card-val"><span class="ai-level-badge" style="color:${r.overallLevel.color}; background:${r.overallLevel.bg};">${r.overallLevel.tier}</span></div>
        <div class="ai-card-sub">${r.workflowArchetype.name}</div>
      </div>
      <div class="ai-card">
        <div class="ai-card-lbl">Edit Efficiency</div>
        <div class="ai-card-val ${effClass}">${effPct}%</div>
        <div class="ai-card-sub">${r.metrics.netCodeLength} net / ${r.metrics.totalCharsInserted} typed</div>
      </div>
      <div class="ai-card">
        <div class="ai-card-lbl">Typing Velocity</div>
        <div class="ai-card-val">${r.metrics.typingVelocityNetWpm} <small>WPM</small></div>
        <div class="ai-card-sub">${r.metrics.typingVelocityGrossWpm} gross WPM</div>
      </div>
      <div class="ai-card">
        <div class="ai-card-lbl">Struggle Points</div>
        <div class="ai-card-val ${r.metrics.struggleEpisodeCount === 0 ? 'good' : 'warn'}">${r.metrics.struggleEpisodeCount}</div>
        <div class="ai-card-sub">${r.metrics.largeDeletionsCount} block deletions</div>
      </div>
    `;
    body.appendChild(scorecard);

    // Pause breakdown bar
    const pauseSection = document.createElement('div');
    pauseSection.className = 'ai-section';
    const pTot = r.pauseDistribution.total;
    const pAct = Math.round((r.pauseDistribution.active / pTot) * 100);
    const pThk = Math.round((r.pauseDistribution.thinking / pTot) * 100);
    const pDel = Math.round((r.pauseDistribution.deliberation / pTot) * 100);
    const pIdl = Math.max(0, 100 - (pAct + pThk + pDel));

    pauseSection.innerHTML = `
      <div class="ai-section-title">Cognitive Pause & Flow Distribution</div>
      <div class="ai-flow-bar" title="Active: ${pAct}%, Thinking: ${pThk}%, Deliberation: ${pDel}%, Idle: ${pIdl}%">
        <div class="ai-flow-seg active" style="width: ${pAct}%;"></div>
        <div class="ai-flow-seg thinking" style="width: ${pThk}%;"></div>
        <div class="ai-flow-seg deliberation" style="width: ${pDel}%;"></div>
        <div class="ai-flow-seg idle" style="width: ${pIdl}%;"></div>
      </div>
      <div class="ai-flow-legend">
        <span><i class="dot active"></i> Active Flow (${pAct}%)</span>
        <span><i class="dot thinking"></i> Micro-Planning (${pThk}%)</span>
        <span><i class="dot deliberation"></i> Deep Thinking (${pDel}%)</span>
        <span><i class="dot idle"></i> Roadblocks (${pIdl}%)</span>
      </div>
    `;
    body.appendChild(pauseSection);

    // Concepts Grid
    const conceptsSection = document.createElement('div');
    conceptsSection.className = 'ai-section';
    let conceptsHtml = '';
    Object.values(r.conceptCategories).forEach(cat => {
      if (cat.items.length) {
        conceptsHtml += `<div class="ai-cat-group">
          <div class="ai-cat-title">${cat.name}</div>
          <div class="ai-badges-wrap">
            ${cat.items.map(it => `<span class="ai-concept-badge">${escapeHtml(it)}</span>`).join('')}
          </div>
        </div>`;
      }
    });
    if (!conceptsHtml) {
      conceptsHtml = '<p class="ai-empty-text">No complex C++ structures detected.</p>';
    }
    conceptsSection.innerHTML = `
      <div class="ai-section-title">Demonstrated C++ Concept Mastery</div>
      ${conceptsHtml}
    `;
    body.appendChild(conceptsSection);

    // AI Generation & Prompt area
    const aiSection = document.createElement('div');
    aiSection.className = 'ai-section ai-prompt-section';

    const savedKey = (typeof localStorage !== 'undefined' && localStorage.getItem('cppwasm.geminiApiKey')) || '';
    aiSection.innerHTML = `
      <div class="ai-section-title">✨ AI Diagnostic Evaluation</div>
      <div class="ai-api-row">
        <input type="password" id="ai-api-key-input" class="ai-api-input" placeholder="Enter Gemini API Key (optional)" value="${escapeHtml(savedKey)}" />
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="ai-key-link">Get free key ↗</a>
      </div>
      <div class="ai-report-output" id="ai-report-output" hidden></div>
    `;
    body.appendChild(aiSection);

    // Wire up copy prompt button
    const copyBtn = document.getElementById('ai-analysis-copy-prompt');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const promptText = generateAiPrompt(r);
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(promptText).then(() => {
            const prev = copyBtn.textContent;
            copyBtn.textContent = '✓ Copied to Clipboard!';
            copyBtn.classList.add('ok');
            setTimeout(() => {
              copyBtn.textContent = prev;
              copyBtn.classList.remove('ok');
            }, 2000);
          }).catch(() => {
            promptFallback(promptText);
          });
        } else {
          promptFallback(promptText);
        }
      };
    }

    // Wire up Gemini API button
    const runBtn = document.getElementById('ai-analysis-run-btn');
    const keyInput = document.getElementById('ai-api-key-input');
    const outBox = document.getElementById('ai-report-output');

    if (runBtn && keyInput && outBox) {
      runBtn.onclick = async () => {
        const key = keyInput.value.trim();
        if (!key) {
          alert('Please enter a Google Gemini API Key, or use "Copy AI Prompt" to paste into Gemini / ChatGPT.');
          keyInput.focus();
          return;
        }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('cppwasm.geminiApiKey', key);
        }

        outBox.hidden = false;
        outBox.textContent = 'Generating AI progress analysis...';
        runBtn.disabled = true;

        try {
          const prompt = generateAiPrompt(r);
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
          });

          if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error((errJson.error && errJson.error.message) || `HTTP error ${response.status}`);
          }

          const resData = await response.json();
          const candidateText = resData.candidates && resData.candidates[0] && resData.candidates[0].content && resData.candidates[0].content.parts[0] && resData.candidates[0].content.parts[0].text;
          if (candidateText) {
            outBox.innerHTML = renderSimpleMarkdown(candidateText);
          } else {
            outBox.textContent = 'No response generated from the model.';
          }
        } catch (err) {
          outBox.innerHTML = `<span class="ai-error-text">AI Evaluation failed: ${escapeHtml(err.message)}</span>`;
        } finally {
          runBtn.disabled = false;
        }
      };
    }
  }

  function renderSimpleMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.*$)/gim, '<h4>$1</h4>')
      .replace(/^## (.*$)/gim, '<h3>$1</h3>')
      .replace(/^# (.*$)/gim, '<h2>$1</h2>')
      .replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n+/g, '<br><br>');
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function downloadSkillZip() {
    try {
      const res = await fetch('skills/cpp-recording-analysis.zip');
      if (res.ok) {
        const blob = await res.blob();
        triggerDownload(blob, 'cpp-recording-analysis.zip');
        return;
      }
    } catch (_) {}

    try {
      const res = await fetch('skills/cpp-recording-analysis.skill');
      if (res.ok) {
        const blob = await res.blob();
        triggerDownload(blob, 'cpp-recording-analysis.zip');
        return;
      }
    } catch (_) {}

    alert('Could not download skill zip file. Please check that skills/cpp-recording-analysis.zip exists.');
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  window.CppLearnerAnalysis = {
    analyzeRecording,
    generateAiPrompt,
    open,
    downloadSkillZip
  };
})();

---
name: cpp-recording-analysis
description: Analyze user coding sessions and C++ knowledge progression from .cpprec recording files or decoded event streams. Use when evaluating a learner's programming habits, typing dynamics, debugging patterns, concept mastery, or common mistakes in cpp.wasm recordings.
---

# C++ Recording Analysis

Evaluate learner progress, programming behavior, and C++ knowledge acquisition from `cpp.wasm` session recordings (`.cpprec` or JSON events).

## Core Capabilities

1. **Typing & Keystroke Dynamics**: Quantify edit efficiency ($E_{eff} = \text{Net} / \text{Gross}$), backspace ratio, and struggle episodes.
2. **Cognitive Load & Flow Analysis**: Categorize pause durations into active flow ($<2$s), micro-planning ($2-5$s), deep deliberation ($5-30$s), and roadblocks ($>30$s).
3. **C++ Knowledge Progression**: Map demonstrated code structures against the 4-tier C++ concept mastery taxonomy (Novice $\rightarrow$ Proficient).
4. **Behavioral Archetype Classification**: Identify architectural planning (Top-Down), iterative development (Bottom-Up), or trial-and-error (Groping).

---

## Analysis Workflow

Follow this 4-step sequence when presented with a recording file or event stream:

### Step 1: Extract Metrics with the Bundled Parser

Run the bundled parser script to extract key metrics without overflowing the LLM context window:

```powershell
node skills/cpp-recording-analysis/scripts/parse_cpprec.cjs "<path-to-recording.cpprec>" --json
```

*For quick markdown overview:*
```powershell
node skills/cpp-recording-analysis/scripts/parse_cpprec.cjs "<path-to-recording.cpprec>"
```

The script extracts:
- Session metadata and duration
- Gross vs net characters and edit efficiency ratio
- Pause distribution buckets
- High-churn struggle episodes ($\ge 40$ chars deleted in 10s)
- Milestone code snapshots ($25\%$, $50\%$, $75\%$, $100\%$)
- Detected C++ language constructs

---

### Step 2: Evaluate Behavioral Dynamics

Cross-reference extracted metrics with `references/metrics-rubric.md`:

1. **Edit Efficiency Ratio ($E_{eff}$)**:
   - $> 0.80$: Highly fluent, pre-planned architecture.
   - $0.55 - 0.80$: Iterative normal, healthy incremental debugging.
   - $0.35 - 0.55$: Uncertain, exploratory, syntax hesitation.
   - $< 0.35$: Frustration, major rewrites, high churn.

2. **Pause Patterns**:
   - Compare active typing vs deliberation vs long idle.
   - If long idle ($>30$s) is immediately followed by a high-churn deletion, flag as a **conceptual roadblock**.

3. **Workflow Archetype**:
   - Review milestone snapshots to determine whether the user drafted declarations first (Top-Down), wrote monolithically in `main()` (Bottom-Up), or wrote and erased fragmented lines (Speculative).

---

### Step 3: Assess C++ Knowledge & Concept Mastery

Cross-reference detected code with `references/cpp-concept-taxonomy.md`:

1. **Identify Current Mastery Tier**:
   - **Level 1 (Novice)**: Scalar types, loops, 1D arrays, basic I/O.
   - **Level 2 (Developing)**: User functions, 2D arrays, basic structs, vectors, pass-by-value.
   - **Level 3 (Competent)**: Pass-by-reference (`&`), STL algorithms/maps, scope discipline.
   - **Level 4 (Proficient)**: Templates, lambdas, memory management, complexity awareness.

2. **Diagnose Antipatterns**:
   - Inspect milestone transitions for common pitfalls:
     - Semicolons terminating `for(...)` or `if(...)` headers.
     - Pass-by-value copying when mutation was intended.
     - 1-based indexing on 0-indexed arrays.
     - Incomplete multi-dimensional array dimensions.
     - Uninitialized accumulation variables.

---

### Step 4: Deliver the Structured Learner Progress Report

Generate a clear, constructive report following this markdown structure:

```markdown
# 📊 Learner Progress & Knowledge Analysis

## 🎯 Executive Summary
- **Overall Level**: [Novice | Developing | Competent | Proficient]
- **Session Duration**: [Xm Ys] | **Total Events**: [N]
- **Primary Strength**: [Key strength observed]
- **Primary Growth Area**: [Key area needing improvement]

## ⌨️ Behavioral & Cognitive Dynamics
- **Edit Efficiency**: [0.XX] ([Fluency Category])
- **Typing Velocity**: [X] net WPM / [Y] gross WPM
- **Cognitive Flow**:
  - Active Typing: [X]% | Deliberation: [Y]% | Roadblock/Idle: [Z]%
- **Workflow Archetype**: [Top-Down Architecture | Bottom-Up Iterative | Speculative]
- **Struggle Points**: [Describe specific struggle episodes or note if smooth]

## 🧠 C++ Concept Mastery Matrix
| Category | Concepts Demonstrated | Status |
| :--- | :--- | :--- |
| **Data Types & Memory** | [e.g. 2D Arrays, Pointers] | [Mastered / In Progress] |
| **Control Flow & Idioms** | [e.g. Range-based loops] | [Mastered / In Progress] |
| **Functions & Parameter Passing** | [e.g. Pass-by-value vs Reference] | [Needs Review / Sound] |
| **STL & Data Structures** | [e.g. std::vector, std::map] | [Emerging / Fluent] |

## 🔍 Diagnostic Findings & Antipatterns
- **[Finding 1 Title]**: [Explanation of what happened in the recording and why it occurred]
- **[Finding 2 Title]**: [Explanation]

## 🚀 Tailored Next Steps & Practice
1. **[Immediate Drill]**: [Concrete exercise targeting the diagnosed gap]
2. **[Best Practice to Adopt]**: [Idiomatic C++ habit to replace an observed antipattern]
3. **[Suggested Reading / Visualizer Experiment]**: [Specific feature or visualizer step to run]
```

# Learner Metrics & Cognitive Rubric

This reference defines quantitative thresholds and qualitative indicators for interpreting typing dynamics, pause patterns, and edit behavior in `cpp.wasm` recordings.

---

## 1. Edit Efficiency Ratio ($E_{eff}$)

Defined as:
$$\text{Edit Efficiency} = \frac{\text{Net Final Code Length}}{\text{Total Inserted Characters}}$$

| Range | Classification | Interpretation |
| :--- | :--- | :--- |
| **$> 0.80$** | **High Fluency** | Confident writing with minimal false starts or structural rewrites. Code was planned ahead. |
| **$0.55 - 0.80$** | **Iterative Normal** | Healthy development cycle. Common refactoring, local syntax adjustments, and expected typing corrections. |
| **$0.35 - 0.55$** | **Exploratory / Struggling** | Frequent backtracking, repeated line deletion, trial-and-error typing. Often indicates syntax uncertainty. |
| **$< 0.35$** | **High Churn / Distress** | Major rewrites, discarding large blocks, persistent struggle with compiler errors or algorithmic approach. |

---

## 2. Cognitive Pause Distribution

Time intervals between user actions (edits, cursor navigation) reveal cognitive states:

### A. Active Flow ($< 2$ seconds)
- **State**: Typing from muscle memory, typing known syntax, or immediate code drafting.
- **Healthy benchmark**: 30% - 60% of total session time.

### B. Micro-Planning ($2 - 5$ seconds)
- **State**: Brief pause to recall syntax, variable names, or the next statement in sequence.
- **Healthy benchmark**: 15% - 25% of total session time.

### C. Algorithmic Deliberation ($5 - 30$ seconds)
- **State**: Problem-solving, mentally tracing loops/branches, formulating data structures.
- **Healthy benchmark**: 15% - 30% of total session time.

### D. Roadblock / Distraction ($> 30$ seconds)
- **State**: Potential confusion, researching external documentation, reading compiler error messages, or distraction.
- **Indicator**: Multiple $> 30$s pauses immediately followed by large deletions indicate frustration with an approach.

---

## 3. Deletion Dynamics & Struggle Episodes

- **High-Churn Episode**: $\ge 40$ characters deleted within a rolling 10-second window.
- **Block Wipes**: Deleting $> 15$ characters at once (selecting and deleting blocks, or holding Backspace).
- **Oscillating Cursor Movements**: Rapid cursor jumps between header/declarations and the current function indicate confusion about variable scope or types.

---

## 4. Problem-Solving Workflow Archetypes

1. **Architectural (Top-Down)**:
   - Includes and global/struct definitions written first.
   - Helper function signatures laid out with dummy returns.
   - Main function ties components together.
   - *Characteristic*: High planning pauses, high edit efficiency ($>0.70$).

2. **Procedural (Bottom-Up)**:
   - Writes everything in `main()` initially.
   - Later refactors pieces into functions or structs.
   - *Characteristic*: Lower initial efficiency, noticeable refactoring phase near 60-70% milestone.

3. **Groping / Speculative**:
   - Types fragments, deletes them immediately.
   - Jumps between multiple lines without completing expressions.
   - *Characteristic*: Low edit efficiency ($<0.45$), high churn episodes.

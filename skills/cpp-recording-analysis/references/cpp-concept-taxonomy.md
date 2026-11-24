# C++ Concept Mastery Taxonomy & Antipatterns

This reference maps C++ programming concepts to learning stages and identifies common learner misconceptions detectable from session recordings.

---

## 1. Concept Mastery Stages

### Level 1: Novice
- **Core Concepts**: Basic types (`int`, `float`, `char`, `bool`), standard I/O (`cin`, `cout`), basic conditionals (`if`/`else`), loops (`for`, `while`), 1D fixed-size arrays.
- **Indicators**:
  - Linear execution in `main()`.
  - Manual index counters instead of standard idioms.
  - Hardcoded bounds.

### Level 2: Developing
- **Core Concepts**: User-defined functions, 2D arrays, basic structs, `std::string`, `std::vector` (basic `push_back`, indexing), pass-by-value vs basic pointers (`*`, `&`).
- **Indicators**:
  - Modularity beginning to appear.
  - Awareness of separation of concerns.
  - Occasional confusion between array indexing and array size.

### Level 3: Competent
- **Core Concepts**: Pass-by-reference (`&`, `const&`), multi-dimensional arrays, STL containers (`map`, `set`, `pair`), basic algorithms (`std::sort`, `std::reverse`), class member functions, scope discipline.
- **Indicators**:
  - Intentional use of references to avoid copying.
  - Effective use of standard library data structures.
  - Clean error checking and boundary handling.

### Level 4: Proficient / Advanced
- **Core Concepts**: Templates, custom comparators, lambda expressions, dynamic memory (`new`/`delete`, smart pointers), recursion with memoization, time/space complexity optimization.
- **Indicators**:
  - Idiomatic modern C++ (auto, range-based loops, const-correctness).
  - Algorithmic efficiency ($O(n \log n)$ vs $O(n^2)$).

---

## 2. Common Learner Antipatterns & Diagnostic Signals

| Antipattern | Recording Symptoms | Remediation Advice |
| :--- | :--- | :--- |
| **Semicolon on Loops/Ifs** | Types `for (...);` or `if (...);` followed by curly braces `{...}`, followed by long pause and deletions when logic fails. | Explain that `;` forms an empty body, decoupling the block. |
| **Pass-by-Value Copy Bug** | Modifies parameter inside function expecting caller variable to change, then adds print statements when it doesn't. | Introduce pass-by-reference (`T& param`) or visualizer pointer inspect. |
| **1-Based vs 0-Based Indexing** | Loops from `i = 1; i <= n` with array declared as `arr[n]`, causing out-of-bounds corruption. | Emphasize 0-indexing `0 .. n-1` or `std::vector::at()`. |
| **VLA / Array Size Misconception** | Attempts to pass 2D array with incomplete dimensions (e.g. `int arr[][]`), encounters compiler error, deletes frantically. | Clarify row-major layout and the requirement for fixed trailing dimensions (`arr[][N]`) or `std::vector<std::vector<T>>`. |
| **Uninitialized Variable Use** | Declares `int sum;` without `= 0`, then accumulates in loop `sum += x;`. | Promote direct initialization (`int sum = 0;`). |
| **Heavy Header Hesitation** | Spends minutes typing `#include <...>`, repeatedly deleting and switching between `<conio.h>`, `<stdlib.h>`, `<bits/stdc++.h>`. | Recommend standard modern headers (`<iostream>`, `<vector>`, `<algorithm>`). |

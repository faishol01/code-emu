# Handover Document: Multi-Dimensional Array Visualization

**Project:** `cpp-emu` (C++ WebAssembly Emulator & Visualizer)  
**Feature:** Multi-Dimensional Array Support & Execution Visualization  
**Target Files:**
- `src/js/visualizer.js` (AST instrumentation, C++ runtime header, state engine, UI rendering)
- `src/css/style.css` (Variables pane matrix styling)

---

## 1. Overview & Problem Statement

Prior to this implementation, the `cpp-emu` C++ execution visualizer only supported one-dimensional arrays (e.g., `int arr[5]`). Any attempt to declare, modify, pass, or visualize multi-dimensional arrays (such as 2D matrices `int grid[2][3]` or 3D tensors `int cube[2][3][4]`) resulted in one or more of the following issues:

1. **Type Inaccuracy**: Array declarations were hardcoded to append a single `[]` (`type + '[]'`), causing 2D and 3D arrays to be registered as 1D arrays (`int[]`).
2. **Parameter Rejection**: Function parameter parsing rejected multi-bracket syntax like `void solve(int grid[2][3])` or reference-to-array types `void solve(int (&grid)[2][3])`.
3. **C++ Compilation Failure (`no matching function for call to 'arr_decl'`)**:
   - Passing multi-dimensional arrays caused pointer decay to `int (*)[M]`, which cannot implicitly convert to `const T*` due to C++ multi-level qualification conversion rules.
   - `reinterpret_cast<uintptr_t>(arr)` was called directly on array reference lvalues, which is ill-formed in standard C++.
4. **Variable Length Array (VLA) Template Rejection**:
   - In competitive programming and educational exercises, users frequently declare VLAs:
     ```cpp
     int N;
     cin >> N;
     int num[N];
     int multi[N][N];
     ```
   - In C++ (Clang extension), VLAs have **variably modified types**. Under C++ standard rule `[temp.arg.type]`, a variably modified type cannot be used as a template argument. Any template taking `T` or `T&&` caused Clang to emit:
     `substitution failure: variably modified type 'int (&)[N][N]' cannot be used as a template argument`.
5. **Flattened Visuals**: Serialized arrays lacked readable formatting for nested matrices, rendering them as compressed single-line strings.

---

## 2. End-to-End Architecture

```
User C++ Code
      │
      ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. AST Parser (visualizer.js)                                  │
│    - parseDecl: Counts bracket pairs -> type[][]...            │
│    - parseParam: Extracts N-D array & reference parameters     │
│    - Registers names in knownArrays (Map / Set)                │
└────────────────────────────────┬───────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. Code Instrumentation (visualizer.js)                        │
│    - Emits __viz::arr_decl(name, type, arr, size, line)        │
│    - Emits __viz::arr_set(name, arr, size, line)               │
│    - Emits __viz::arr_io_input_event(...)                      │
└────────────────────────────────┬───────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. Internal C++ Runtime Header (<visualizer-internal>)         │
│    - to_s(const T (&arr)[N]): Recursive JSON serialization    │
│    - Universal templates: arr_decl(name, type, T&&, S, ln)     │
│    - Non-template VLA fallback: arr_decl(..., const void*, ln) │
│    - serialize_vla: Flat contiguous memory unpacker            │
│    - std::addressof memory resolution                          │
└────────────────────────────────┬───────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. Visualizer Engine & UI Rendering                            │
│    - computeState: Diff & frame-scoped change highlights       │
│    - formatVarValue: Multi-line matrix layout                  │
│    - CSS: white-space: pre-wrap                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Implementation

### 3.1. Parsing & AST Detection (`src/js/visualizer.js`)

#### Local & Global Declarations (`parseDecl`)
Calculates the number of bracket pairs in the declaration and constructs the canonical multi-dimensional type:
```javascript
const dimMatches = d.match(/\[[^\]]*\]/g);
const dimCount = dimMatches ? dimMatches.length : 0;
const isArray = dimCount > 0;
const arrType = isArray ? (type + '[]'.repeat(dimCount)) : type;
vars.push({ name: varMatch[1], isArray: isArray, dimCount: dimCount, arrType: arrType });
```

#### Function Parameter Parsing (`parseParam`)
Handles both decayed pointer array parameters (`type name[dim1][dim2]`) and exact reference-to-array parameters (`type (&name)[dim1][dim2]`):
```javascript
// Reference to array: type (&name)[dim1][dim2]...
const refArrMatch = pTrim.match(/^(.+?)\s*\(\s*&\s*([a-zA-Z_0-9]+)\s*\)\s*(\[[^\]]*\](?:\s*\[[^\]]*\])*)$/);
if (refArrMatch) {
  const rawType = refArrMatch[1].trim();
  const name = refArrMatch[2].trim();
  const brackets = refArrMatch[3].match(/\[[^\]]*\]/g);
  const dims = '[]'.repeat(brackets ? brackets.length : 1);
  return { type: rawType + '&' + dims, name: name, isArray: true };
}

// Standard array param: type name[dim1][dim2]...
const arrMatch = pTrim.match(/^(.+?)\s+([*&]?)\s*([a-zA-Z_0-9]+)\s*(\[[^\]]*\](?:\s*\[[^\]]*\])*)$/);
if (arrMatch) { ... }
```
When parsed, array parameter names are registered in `knownArrays` to ensure subsequent element assignments (`grid[i][j] = ...`) emit `__viz::arr_set`.

#### Multi-Dimensional Assignments & Modifications
To capture assignments (`grid[i][j] = val`), increments (`grid[i][j]++`), method calls, and swaps on multi-dimensional arrays, the parser regexes support repeated bracket pairs `(?:\s*\[[^\]]*\])+`:
```javascript
// Array assignments: arr[i] = val, grid[i][j] = val, etc.
const arrAssignRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)/g;

// Array inc/dec: arr[i]++, grid[i][j]++, etc.
const arrIncDecRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+\s*(\+\+|--)|(?:^|[;{}(,\s])(\+\+|--)\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+/g;

// Container swap: swap(a, b), swap(grid[i][j], grid[k][l])
const swapRe = /(?:^|[;{}(,\s])(?:std::)?swap\s*\(\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])*\s*,\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])*\s*\)/g;
```
Declared array types are stored in `knownArrayTypes = new Map()`, allowing `__viz::arr_set` and `__viz::arr_io_input_event` to pass the exact type string (e.g. `"int[][]"`) so runtime serializers know the exact matrix dimensions.

---

### 3.2. C++ Runtime Header (`<visualizer-internal>`)

#### Recursive Array Serialization (`to_s`)
Recursively traverses array dimensions until reaching base scalars:
```cpp
template<typename T, size_t N>
inline std::string to_s(const T (&arr)[N]) {
  std::ostringstream ss;
  ss << "[";
  for (size_t i = 0; i < N && i < 15; ++i) {
    if (i > 0) ss << ", ";
    ss << to_s(arr[i]);
  }
  if (N > 15) ss << ", ...";
  ss << "]";
  return ss.str();
}
```
*Forward declarations for `to_s(const T&)` and `to_s(const T (&)[N])` are placed at the top of the internal namespace to ensure proper two-phase template lookup.*

#### Address Resolution (`get_addr`)
To prevent `reinterpret_cast from array type to uintptr_t` errors, array references take the address via `std::addressof(arr)` before casting:
```cpp
template<typename T, size_t N>
inline uintptr_t get_addr(const T (&arr)[N]) {
  return reinterpret_cast<uintptr_t>(std::addressof(arr));
}
```

#### Multi-Tier Dispatch: Fixed Arrays vs. VLAs vs. Decayed Pointers
To avoid template ambiguity and adhere to C++ standard constraints:

1. **Fixed-Size Compile-Time Arrays** match exact reference templates:
   ```cpp
   template<typename T, size_t N>
   inline void arr_decl(const char* name, const char* type, const T (&arr)[N], size_t, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_decl\",\"name\":\"" << name << "\",\"type\":\"" << type
        << "\",\"val\":\"" << escape_json(to_s(arr))
        << "\",\"addr\":\"" << get_addr(arr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }

   template<typename T, size_t N>
   inline void arr_set(const char* name, const char* type, const T (&arr)[N], size_t, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_set\",\"name\":\"" << name
        << "\",\"val\":\"" << escape_json(to_s(arr))
        << "\",\"addr\":\"" << get_addr(arr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }
   ```
2. **Variable Length Arrays (VLAs)** trigger substitution failure on array reference templates (SFINAE) and automatically fall back to the concrete non-template `const void*` overload:
   ```cpp
   inline void arr_decl(const char* name, const char* type, const void* ptr, size_t size, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_decl\",\"name\":\"" << name << "\",\"type\":\"" << type
        << "\",\"val\":\"" << escape_json(serialize_vla(ptr, type, size))
        << "\",\"addr\":\"" << reinterpret_cast<uintptr_t>(ptr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }

   inline void arr_set(const char* name, const char* type, const void* ptr, size_t size, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_set\",\"name\":\"" << name
        << "\",\"val\":\"" << escape_json(serialize_vla(ptr, type, size))
        << "\",\"addr\":\"" << reinterpret_cast<uintptr_t>(ptr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }
   ```
3. **Decayed Array Pointers** match explicit pointer overloads:
   ```cpp
   template<typename T>
   inline void arr_decl(const char* name, const char* type, const T* ptr, size_t size, int ln);
   ```
3. **VLA Memory Deserializer (`serialize_vla`)**:
   Traverses contiguous row-major memory for 1D and 2D VLAs using the element type (`int`, `long long`, `double`, `float`, `char`, `bool`):
   ```cpp
   inline std::string serialize_vla(const void* ptr, const char* type, size_t size);
   ```

---

### 3.3. Tabular UI Presentation, Index Explorer & Granular Highlights

#### 1. Tabular View for 1D and 2D Arrays/Vectors
For arrays and vectors (`<= 2` dimensions), `renderVarValue` dynamically creates structured tables with visible index headers:
- **1D Arrays/Vectors**:
  - Top header row with column indices: `[0]`, `[1]`, `[2]`, ...
  - Bottom data row with cell values.
- **2D Arrays/Vectors (Matrices)**:
  - Top header row with column indices `[0]`, `[1]`, `[2]`, ...
  - Left header column with row indices `[0]`, `[1]`, ...
  - Matrix data cells corresponding to `grid[r][c]`.
- **3D Arrays (Tensors)**:
  - Slice selector tab bar (`Slice [0]`, `Slice [1]`, ...) rendering the active slice as a 2D matrix table.

#### 2. Interactive Index Explorer
Each array/vector variable includes an interactive explorer toolbar:
- **Interactive Index Inputs Row (`.viz-array-inputs-row`)**: Features `idx:` input fields (`[ i ]` for 1D, `[ r ] [ c ]` for 2D, or `[ d1 ] [ d2 ] [ d3 ]` for 3D) alongside a `Raw` view toggle button.
- **Dedicated Inspect Row Underneath (`.viz-inspect-row`)**: Displays `.viz-inspect-badge` directly under the index fields (e.g. `grid[0][1] = 99`), auto-hiding via `:empty` when no element is inspected.
- **Hover Inspection & Mouseleave Reset**:
  - Hovering over any cell in the table immediately synchronizes the input coordinates, highlights the cell (`.viz-cell-inspected`), and reveals the inspect badge.
  - When the mouse leaves the cell or table (`mouseleave`), the inspection state resets: cell highlight is removed, the inspect badge is cleared, and the input fields are cleared (unless the user has focused them to type).
- **Raw View Toggle**: Allows switching between the interactive tabular layout and formatted JSON text view.

#### 3. Granular Element-Level Change Highlights
When an array element is modified (via assignment, increment/decrement, or input reading):
- `computeState` runs `computeArrayDiff(prevVal, currVal)` and registers the changed coordinate keys (e.g. `"0,1"` or `"2"`) in `changedVars.elementDiffs`.
- When rendering:
  - The variable's container row (`tr`) **does NOT** glow with `viz-changed`.
  - **Only the specific updated cell(s)** in the tabular grid is highlighted with `.viz-cell-changed` and a dedicated `@keyframes viz-cell-flash` animation.
  - The updated cell is automatically focused in the Index Explorer.

#### 4. Call Stack & Variables Resizing
- A draggable vertical splitter (`.viz-split-resizer`) is positioned between `.viz-stack` and `.viz-vars` in `.viz-body`.
- Supports pointer capture dragging with min/max safety limits (minimum 90px stack, minimum 130px variables).
- Synchronously re-renders SVG reference parameter arrows (`drawRefArrows()`) during and after drag.
- Double-click resets to default width (220px); left/right arrow keys allow keyboard resizing.
- Persisted to `localStorage['cppwasm.vizStackWidth']`.

#### 5. Rightmost Pass-by-Reference Arrow Routing
- To ensure vertical reference arrow trunks never cross over intermediate variables (especially wide tabular/multi-dimensional array variables):
  - `drawRefArrows()` scans all rows and content elements (`tr`, `.viz-vars-table`, `.viz-array-view`) to determine `maxContentX` (the absolute maximum right edge of all variable content).
  - Establishes `baselineRight = Math.max(maxContentX + 10, visibleRightX + 6)`.
  - Positions each vertical arrow trunk strictly in the rightmost gutter (`maxX = baselineRight + offset`), cleanly clearing all intermediate tables before turning horizontally into the target variable hook.

#### 6. Array Elements Passed as Reference Parameters
- When an element of an array is passed by reference (e.g., `modify(arr[0])`, `modify(arr[2])`, `modify(grid[1][0])`):
  - In C++, the address of element 0 (`&arr[0]`) equals the array's base address (`&arr`). Previously, aliased synchronization (`syncAliasedVars`) blindly replaced the entire array variable's value with the parameter's scalar value (e.g. `arr.val = 99`).
  - Added `getArrayElementByAddr(vobj, targetAddr)` and `updateArrayElementByAddr(vobj, targetAddr, newVal)`. When a scalar is written to an aliased address matching or falling inside an array's memory range, the visualizer calculates the linear index (`(targetAddr - baseAddr) / elemSize`), locates the exact 1D or multi-dimensional element (`arr[i]` or `grid[r][c]`), and updates only that element in the array's JSON representation.
  - `resolveRefInfo` records both `refVar` (e.g., `'arr[2]'`) and `refBaseVar` (`'arr'`), properly routing visualizer arrows to the parent array row while displaying the exact indexed element.

---

## 4. Summary of Common Pitfalls & C++ Compiler Nuances Solved

| Issue | C++ Rule / Root Cause | Resolution |
| :--- | :--- | :--- |
| Array variable overwritten with scalar when element passed by reference | `&arr[0]` has the same memory address as `&arr`, causing `syncAliasedVars` to replace `arr.val` with the scalar value. | Implemented `updateArrayElementByAddr` to update only the specific element index within the array data without collapsing the array structure. |
| `no matching function for call to 'arr_decl'` on 2D arrays | Multi-level qualification conversion: `int (*)[3]` does not implicitly convert to `const int (*)[3]`. | Used forwarding references (`T&& arr`) and array references (`const T (&arr)[N]`). |
| `reinterpret_cast from 'int[2][3]' to 'uintptr_t' is not allowed` | In C++, `reinterpret_cast` does not perform array-to-pointer decay on array lvalues. | Replaced `reinterpret_cast<uintptr_t>(arr)` with `reinterpret_cast<uintptr_t>(std::addressof(arr))`. |
| `variably modified type cannot be used as a template argument` | Clang C++ VLA extension: runtime dimensions cannot be deduced as template parameters (`[temp.arg.type]`). | Provided non-template `const void* ptr` overloads that accept decayed VLA pointers via SFINAE fallback. |
| Two-phase lookup failure for nested array `to_s` | Inner array dimensions call `to_s(arr[i])` before the template definition is visible. | Forward-declared `template<typename T, size_t N> std::string to_s(const T (&)[N]);`. |

---

## 5. Maintenance & Extension Guidelines

1. **Adding Support for Greater Dimensions (>2D for VLAs)**:
   - Compile-time arrays already support arbitrary dimensions recursively via `to_s(const T (&arr)[N])`.
   - To extend VLA support beyond 2D, update `serialize_vla` in `src/js/visualizer.js` to inspect `[][][]` and compute dimension strides.
2. **Modifying Internal C++ Signatures**:
   - If adding or changing methods in `namespace __viz`, always provide both the template overload for fixed arrays and the `const void*` overload for VLAs.
   - Do not remove `#include <memory>` or `#include <cstdint>`, as `std::addressof` and `uintptr_t` are mandatory for type-safe address logging.
3. **Checking JS Syntax**:
   - Always run `node --check src/js/visualizer.js` after making modifications.

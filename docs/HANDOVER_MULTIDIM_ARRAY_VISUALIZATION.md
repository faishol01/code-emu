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

#### Address Resolution (`get_arr_addr` / `get_addr`)
To prevent `reinterpret_cast from array type to uintptr_t` errors, array references take the address via `std::addressof(arr)` before casting:
```cpp
template<typename T, size_t N>
inline uintptr_t get_arr_addr(const T (&arr)[N]) {
  return reinterpret_cast<uintptr_t>(std::addressof(arr));
}
```

#### Dual-Dispatch Strategy: Fixed-Size Arrays vs. VLAs
To resolve the C++ standard constraint that variably modified types cannot be template arguments:

1. **Compile-Time Fixed Arrays** match universal forwarding references:
   ```cpp
   template<typename T, typename S>
   inline void arr_decl(const char* name, const char* type, T&& arr, S size, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_decl\",\"name\":\"" << name << "\",\"type\":\"" << type
        << "\",\"val\":\"" << escape_json(serialize_arr(arr, size))
        << "\",\"addr\":\"" << get_arr_addr(arr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }
   ```
2. **Variable Length Arrays (VLAs)** trigger substitution failure on `T&& arr` (SFINAE) and automatically fall back to the concrete non-template `const void*` overload:
   ```cpp
   inline void arr_decl(const char* name, const char* type, const void* ptr, size_t size, int ln) {
     std::ostringstream ss;
     ss << "{\"e\":\"var_decl\",\"name\":\"" << name << "\",\"type\":\"" << type
        << "\",\"val\":\"" << escape_json(serialize_vla(ptr, type, size))
        << "\",\"addr\":\"" << reinterpret_cast<uintptr_t>(ptr)
        << "\",\"line\":" << ln << "}";
     emit(ss.str());
   }
   ```
3. **VLA Memory Deserializer (`serialize_vla`)**:
   Traverses contiguous row-major memory for 1D and 2D VLAs using the element type (`int`, `long long`, `double`, `float`, `char`, `bool`):
   ```cpp
   inline std::string serialize_vla(const void* ptr, const char* type, size_t size);
   ```

---

### 3.3. UI Presentation & Formatting

#### Matrix Formatting (`formatVarValue`)
Converts serialized 2D JSON arrays (`[[1, 2], [3, 4]]`) into multi-line matrix representations:
```javascript
function formatVarValue(val) {
  if (typeof val !== 'string') return String(val || '');
  if (val.startsWith('[[') && val.endsWith(']]')) {
    return val.replace(/\], ?\[/g, '],\n [');
  }
  return val;
}
```

#### CSS Styling (`src/css/style.css`)
In `.viz-vars-table td:nth-child(3)`:
- Set `white-space: pre-wrap;` to allow multi-line matrix rows to wrap cleanly inside table cells while preserving line breaks and indentation.

---

## 4. Summary of Common Pitfalls & C++ Compiler Nuances Solved

| Issue | C++ Rule / Root Cause | Resolution |
| :--- | :--- | :--- |
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

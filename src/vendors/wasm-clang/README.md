# Clang and LLD in WebAssembly (Clang 22)

Prebuilt Clang 22 and LLD toolchain compiled to WebAssembly for WASI, from `@live-codes/clang-wasm` (0.3.0).

## Files

- `clang`: Clang 22 compiler, compiled to wasm targeting `wasm32-wasi`
- `lld`: wasm-ld linker, compiled to wasm targeting `wasm32-wasi`
- `memfs`: WASI implementation of in-memory filesystem
- `sysroot.tar`: C++ standard headers (libc++) and libraries
- `runtime-manifest.v1.json`: Toolchain configuration and asset manifest

## Upstream

Packaged from: https://www.npmjs.com/package/@live-codes/clang-wasm
Repository: https://github.com/live-codes/clang-wasm

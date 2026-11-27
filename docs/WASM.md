# Strength chart renderer

Rep Journal renders the estimated one-rep-max chart using svgplot. Its C++ code computes chart geometry, formats the axis labels and produces SVG. The JavaScript bindings use the module’s exported linear memory to exchange coordinates and results. The vendored package includes the renderer sources under `renderer-source/`, including the axis formatter, bindings, SVG backend and build recipe. [Upstream svgplot repository](https://github.com/vincentlaucsb/svgplot)

| Shipped component | Provenance |
| --- | --- |
| npm dependency | [Vendored svgplot-wasm 1.1.1 package](../vendor/svgplot-wasm-1.1.1.tgz), pinned by SHA-512 in `package-lock.json` |
| Compiler | Emscripten 6.0.0, using single-file output and Closure dead-code elimination for the embedded loader |
| WASM payload | 526,165 bytes, shared by the embedded and standalone loaders |
| WASM SHA-256 | `c8776280e50aaef89e4c2e27a5226b68ac8799a4a99ad85ef5324f2758ccafa8` |

The Obsidian plugin imports `svgplot-wasm/embedded`. On the first draw it decodes the bundled bytes and instantiates the renderer. The standalone browser app uses the default package entry and loads `/svgplot/line-engine.wasm` from its loopback server.

`npm run build` checks the installed binary’s hash, finds its exact bytes in the generated plugin, and checks the JavaScript for network API references. To verify a release candidate on Windows, run `npm run test:offline-chart` after building, with Obsidian 1.15.0 installed. The test blocks HTTP(S), logs a weighted set and verifies a plotted point with zero fetch attempts. The tag workflow runs this check against the same plugin files it attests and publishes. [Obsidian fixture setup](UI-TESTING.md)

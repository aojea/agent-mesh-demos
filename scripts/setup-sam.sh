#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Downloads the tagged sam-one binary from GitHub Releases and installs the
# matching @sam-mesh/sdk version from npm.
#
# Parameters (environment variables):
#   SAM_REPO     GitHub repository (default: google/sam)
#   SAM_VERSION  Release tag, e.g. v0.1.0-rc.7 or "latest" (default: latest)
#   SAM_BIN_DIR  Where to place sam-one (default: ./.sam-bin)

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SAM_REPO="${SAM_REPO:-google/sam}"
SAM_VERSION="${SAM_VERSION:-latest}"
SAM_BIN_DIR="${SAM_BIN_DIR:-${ROOT_DIR}/.sam-bin}"

OS="$(uname -s)"
case "${OS}" in
  Linux*)  OS_NAME="Linux" ;;
  Darwin*) OS_NAME="Darwin" ;;
  *)       echo "Unsupported OS: ${OS}" >&2; exit 1 ;;
esac

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64*)  ARCH_NAME="x86_64" ;;
  aarch64*) ARCH_NAME="arm64" ;;
  arm64*)   ARCH_NAME="arm64" ;;
  *)        echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

if [[ "${SAM_VERSION}" == "latest" ]]; then
  echo "Resolving latest release tag from ${SAM_REPO}..."
  SAM_VERSION=$(curl -fsSL "https://api.github.com/repos/${SAM_REPO}/releases?per_page=1" | grep '"tag_name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
fi

if [[ -z "${SAM_VERSION}" ]]; then
  echo "Error: Could not resolve SAM_VERSION from ${SAM_REPO}" >&2
  exit 1
fi

TAR_NAME="sam_${OS_NAME}_${ARCH_NAME}.tar.gz"
DOWNLOAD_URL="https://github.com/${SAM_REPO}/releases/download/${SAM_VERSION}/${TAR_NAME}"

mkdir -p "${SAM_BIN_DIR}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading sam-one and sam-node (${SAM_VERSION}) from ${DOWNLOAD_URL}..."
curl -fsSL -o "${TMP_DIR}/${TAR_NAME}" "${DOWNLOAD_URL}"
tar -xzf "${TMP_DIR}/${TAR_NAME}" -C "${TMP_DIR}"
mv "${TMP_DIR}/sam-one" "${SAM_BIN_DIR}/sam-one"
chmod +x "${SAM_BIN_DIR}/sam-one"
if [[ -f "${TMP_DIR}/sam-node" ]]; then
  mv "${TMP_DIR}/sam-node" "${SAM_BIN_DIR}/sam-node"
  chmod +x "${SAM_BIN_DIR}/sam-node"
fi
echo "${SAM_VERSION}" > "${SAM_BIN_DIR}/VERSION"

NPM_VER="${SAM_VERSION#v}"
echo "Installing @sam-mesh/sdk@${NPM_VER}..."
(cd "${ROOT_DIR}" && npm install --registry=https://registry.npmjs.org --no-audit --no-fund "@sam-mesh/sdk@${NPM_VER}")

echo "Bundling @sam-mesh/sdk@${NPM_VER} + @a2a-js/sdk for browser into ${SAM_BIN_DIR}/sdk..."
(cd "${ROOT_DIR}" && SAM_BIN_DIR="${SAM_BIN_DIR}" node --input-type=module -e '
import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const outdir = join(process.env.SAM_BIN_DIR, "sdk");

const wasmModules = {
  name: "wasm-esm",
  setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, (args) => ({ path: join(args.resolveDir, args.path), namespace: "wasm-esm" }));
    build.onLoad({ filter: /.*/, namespace: "wasm-esm" }, async (args) => {
      const bytes = await readFile(args.path);
      const module = new WebAssembly.Module(bytes);
      const importModules = [...new Set(WebAssembly.Module.imports(module).map((imp) => imp.module))];
      const exports = WebAssembly.Module.exports(module).map((exp) => exp.name);
      const lines = [];
      const imports = [];
      importModules.forEach((mod, i) => {
        if (mod.startsWith("./") || mod.startsWith("../")) {
          lines.push(`import * as m${i} from ${JSON.stringify(mod)};`);
          imports.push(`${JSON.stringify(mod)}: m${i}`);
        } else {
          imports.push(`${JSON.stringify(mod)}: { performance_now: () => performance.now() }`);
        }
      });
      lines.push(`const url = new URL(${JSON.stringify(basename(args.path))}, import.meta.url);`);
      lines.push(`const { instance } = await WebAssembly.instantiateStreaming(fetch(url), { ${imports.join(", ")} });`);
      for (const name of exports) {
        lines.push(`export const ${name} = instance.exports[${JSON.stringify(name)}];`);
      }
      return { contents: lines.join("\n"), loader: "js", resolveDir: dirname(args.path), watchFiles: [args.path] };
    });
  },
};

const result = await esbuild.build({
  stdin: {
    contents: `
      export * from "@sam-mesh/sdk";
      export * as a2a from "@a2a-js/sdk";
      export * as a2aClient from "@a2a-js/sdk/client";
      export * as a2aServer from "@a2a-js/sdk/server";
    `,
    resolveDir: process.cwd(),
    sourcefile: "index.js",
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(outdir, "index.js"),
  assetNames: "[name]",
  sourcemap: true,
  plugins: [wasmModules],
  metafile: true,
  logLevel: "error",
});

await mkdir(outdir, { recursive: true });
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.startsWith("wasm-esm:")) {
    const file = input.slice("wasm-esm:".length);
    await copyFile(file, join(outdir, basename(file)));
  }
}
')

echo "Ready: sam-one & sam-node (${SAM_VERSION}) at ${SAM_BIN_DIR} and @sam-mesh/sdk@${NPM_VER}"

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
#   SAM_VERSION  Release tag, e.g. v0.1.0-rc.6 or "latest" (default: latest)
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

echo "Downloading sam-one (${SAM_VERSION}) from ${DOWNLOAD_URL}..."
curl -fsSL -o "${TMP_DIR}/${TAR_NAME}" "${DOWNLOAD_URL}"
tar -xzf "${TMP_DIR}/${TAR_NAME}" -C "${TMP_DIR}"
mv "${TMP_DIR}/sam-one" "${SAM_BIN_DIR}/sam-one"
chmod +x "${SAM_BIN_DIR}/sam-one"
echo "${SAM_VERSION}" > "${SAM_BIN_DIR}/VERSION"

NPM_VER="${SAM_VERSION#v}"
echo "Installing @sam-mesh/sdk@${NPM_VER}..."
(cd "${ROOT_DIR}" && npm install --no-audit --no-fund "@sam-mesh/sdk@${NPM_VER}")

echo "Ready: sam-one (${SAM_VERSION}) at ${SAM_BIN_DIR}/sam-one and @sam-mesh/sdk@${NPM_VER}"

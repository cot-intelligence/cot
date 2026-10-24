# Toolchain for building cot's Linux bundles (.deb, .AppImage) from any host,
# used by scripts/build-linux.sh. Ubuntu 22.04, so the bundles run on glibc
# 2.35 and newer: the frozen collector only runs on a glibc as new as the one
# it was built against.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates git pkg-config xz-utils \
      software-properties-common gpg-agent \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libssl-dev libxdo-dev xdg-utils \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3.12-venv python3.12-dev \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24.22.1
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# linuxdeploy (the AppImage step) is itself an AppImage; containers have no FUSE.
ENV APPIMAGE_EXTRACT_AND_RUN=1

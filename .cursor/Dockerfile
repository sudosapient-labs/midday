FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      fuse3 \
      fuse-overlayfs \
      iptables \
      iproute2 \
      postgresql-client \
      sudo \
      unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

RUN mkdir -p /etc/docker \
    && echo '{"storage-driver":"fuse-overlayfs"}' > /etc/docker/daemon.json

RUN echo 'net.bridge.bridge-nf-call-iptables = 0' > /etc/sysctl.d/99-docker-bridge.conf \
    && echo 'net.bridge.bridge-nf-call-ip6tables = 0' >> /etc/sysctl.d/99-docker-bridge.conf

RUN usermod -aG docker ubuntu || true

USER ubuntu
WORKDIR /workspace

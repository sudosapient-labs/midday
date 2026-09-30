#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    sudo modprobe br_netfilter 2>/dev/null || true
    sudo sysctl -w net.bridge.bridge-nf-call-iptables=0 >/dev/null || true
    sudo sysctl -w net.bridge.bridge-nf-call-ip6tables=0 >/dev/null || true

    if ! pgrep -x dockerd >/dev/null 2>&1; then
      sudo dockerd >/tmp/dockerd.log 2>&1 &
      for _ in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
    fi

    if docker info >/dev/null 2>&1; then
      sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
    fi
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not running" >&2
  exit 1
fi

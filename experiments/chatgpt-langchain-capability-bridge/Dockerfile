FROM python:3.13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8765 \
    BRIDGE_ALLOWED_ROOTS=/workspace \
    BRIDGE_STATE_DB=/state/checkpoints.sqlite \
    BRIDGE_COMMAND_TIMEOUT_SECONDS=300 \
    PATH=/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        nodejs \
        npm \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory /workspace

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN python -m pip install --no-cache-dir . pytest

WORKDIR /workspace
EXPOSE 8765
CMD ["chatgpt-langchain-bridge"]

FROM golang:1.25-bookworm AS ggyssh-builder

ARG GGYSSH_REPO=https://github.com/PeishuenWu/ggyssh.git
ARG GGYSSH_REF=main

RUN git clone "${GGYSSH_REPO}" /src/ggyssh \
    && cd /src/ggyssh \
    && git checkout "${GGYSSH_REF}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ggyssh . \
    && mkdir -p /out/static \
    && cp -a static/. /out/static/

FROM debian:12

ARG NODE_MAJOR=22
ARG CODEX_NPM_VERSION=latest
ARG HOST_UID=1000
ARG HOST_GID=1000

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       openssh-server \
       ca-certificates \
       curl \
       gnupg \
       git \
       sqlite3 \
       bubblewrap \
       screen \
       locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \
    && ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm i -g @openai/codex@${CODEX_NPM_VERSION} ws \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

RUN if getent group "${HOST_GID}" > /dev/null; then \
      COD_GROUP="$(getent group "${HOST_GID}" | cut -d: -f1)"; \
    else \
      groupadd -g "${HOST_GID}" codex; \
      COD_GROUP="codex"; \
    fi \
    && useradd -m -s /bin/bash -u "${HOST_UID}" -g "${COD_GROUP}" codex \
    && passwd -d codex \
    && mkdir -p /home/codex/workspace /home/codex/.ssh /var/run/sshd \
    && chown -R codex:"${COD_GROUP}" /home/codex

RUN sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?UsePAM .*/UsePAM no/' /etc/ssh/sshd_config \
    && printf '\nAllowUsers codex\nAuthorizedKeysFile .ssh/authorized_keys\n' >> /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
COPY bash_profile /home/codex/.bash_profile
COPY .screenrc /home/codex/.screenrc
COPY src/ /home/codex/src/
COPY package.json /home/codex/package.json
COPY chat_bridge.js /home/codex/chat_bridge.js
COPY memory_store.js /home/codex/memory_store.js
COPY scheduler_store.js /home/codex/scheduler_store.js
COPY chat_context_store.js /home/codex/chat_context_store.js
COPY --from=ggyssh-builder /out/ggyssh /home/codex/ggyssh/ggyssh
COPY --from=ggyssh-builder /out/static/ /home/codex/ggyssh/static/
COPY ggyssh/config.json /home/codex/ggyssh/config.json

RUN cd /home/codex && npm install --omit=dev

RUN chmod +x /entrypoint.sh /home/codex/chat_bridge.js /home/codex/memory_store.js /home/codex/scheduler_store.js /home/codex/chat_context_store.js /home/codex/ggyssh/ggyssh \
    && chown -R codex:codex /home/codex/

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]

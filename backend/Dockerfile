# GitHub Actions builds this for linux/amd64 on an amd64 runner.
FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libsqlite3-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml ./
# After your first `cargo build`, commit generated Cargo.lock and add COPY Cargo.lock ./ for reproducible builds.
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 apes && useradd -u 10001 -g apes -M -s /usr/sbin/nologin apes \
    && mkdir -p /data && chown apes:apes /data
COPY --from=builder /build/target/release/threeapes-mvp /usr/local/bin/threeapes-mvp
USER 10001:10001
ENV BIND_ADDRESS=0.0.0.0:8080 SQLITE_PATH=/data/3apes.db
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/threeapes-mvp"]

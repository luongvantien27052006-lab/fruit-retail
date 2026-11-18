# syntax=docker/dockerfile:1.7
# PostgreSQL 17 + PostGIS 3.5 + WAL-G (backup full + WAL liên tục, khôi phục theo thời điểm — SPEC §3.6, §15).
# WAL-G v3.0.9 bản build Ubuntu 20.04 (glibc 2.31, khớp Debian bullseye của image gốc); kiểm sha256 khi build.
FROM postgis/postgis:17-3.5
ADD --checksum=sha256:51ec330530f98fc3eb4f008fa539d291a2cac51e7076b256472862e45ceff0bd \
    https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-20.04-amd64.tar.gz /tmp/wal-g.tar.gz
RUN tar -xzf /tmp/wal-g.tar.gz -C /tmp \
    && install -m 0755 /tmp/wal-g-pg-20.04-amd64 /usr/local/bin/wal-g \
    && rm -f /tmp/wal-g.tar.gz /tmp/wal-g-pg-20.04-amd64 \
    && wal-g --version
COPY infra/postgres/restore-entrypoint.sh /usr/local/bin/restore-entrypoint.sh
# /backups thuộc postgres để volume mới tạo có đúng chủ (WALG_FILE_PREFIX ở local).
RUN chmod 0755 /usr/local/bin/restore-entrypoint.sh && mkdir -p /backups/wal-g && chown -R postgres:postgres /backups && chmod -R 700 /backups

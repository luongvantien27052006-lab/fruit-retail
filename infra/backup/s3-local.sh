#!/usr/bin/env bash
# Kho S3 cục bộ (SeaweedFS) CHỈ để diễn tập đường S3 ở máy dev — KHÔNG dùng cho staging/production (§3.6 đòi nhà
# cung cấp khác). Mở 127.0.0.1:18333; container truy cập qua host.docker.internal:18333 (Docker Desktop / có --add-host).
#   bash infra/backup/s3-local.sh up      # in ra các biến WALG_* để ghép vào file env diễn tập
#   bash infra/backup/s3-local.sh down
set -euo pipefail
export MSYS_NO_PATHCONV=1
NAME=fruit-drill-s3
IMG=chrislusf/seaweedfs:3.97
BUCKET=walg-drill
case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    AK=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'); SK=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    CFG=$(printf '{"identities":[{"name":"walg","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' "$AK" "$SK")
    docker run -d --name "$NAME" -p 127.0.0.1:18333:8333 --entrypoint sh "$IMG" -c \
      "printf '%s' '$CFG' > /etc/s3.json && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/s3.json -master.volumeSizeLimitMB=64 -volume.max=20" >/dev/null
    for i in $(seq 1 60); do
      if docker exec "$NAME" sh -c 'echo "s3.bucket.create -name '"$BUCKET"'" | weed shell -master=localhost:9333' >/dev/null 2>&1 \
         && docker exec "$NAME" sh -c 'echo "s3.bucket.list" | weed shell -master=localhost:9333' 2>/dev/null | grep -q "$BUCKET"; then
        break
      fi
      sleep 1
    done
    docker exec "$NAME" sh -c 'echo "s3.bucket.list" | weed shell -master=localhost:9333' 2>/dev/null | grep -q "$BUCKET" \
      || { echo "Không tạo được bucket $BUCKET"; docker logs "$NAME" | tail -20; exit 1; }
    echo "WALG_S3_PREFIX_DRILL=s3://$BUCKET/drill"
    echo "WALG_AWS_ACCESS_KEY_ID=$AK"
    echo "WALG_AWS_SECRET_ACCESS_KEY=$SK"
    echo "WALG_AWS_ENDPOINT=http://host.docker.internal:18333"
    echo "WALG_AWS_REGION=us-east-1"
    echo "WALG_AWS_S3_FORCE_PATH_STYLE=true"
    ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "Dùng: $0 up|down"; exit 2 ;;
esac

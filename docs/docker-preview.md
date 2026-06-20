# Docker Preview

This setup is for quickly previewing the current project locally.
It is separate from the NAS / production deployment files in this repo.

## Start

Run from the project root:

```bash
docker compose -f docker-compose.preview.yml up --build
```

Run in background:

```bash
docker compose -f docker-compose.preview.yml up --build -d
```

Then open:

```text
http://localhost:7777
```

## Stop

```bash
docker compose -f docker-compose.preview.yml down
```

Remove preview database data too:

```bash
docker compose -f docker-compose.preview.yml down -v
```

## Notes

- The `app` service builds the current workspace code, not a remote `ghcr` image.
- On first start it runs `prisma db push` so the preview environment can boot quickly.
- PostgreSQL is mapped to `5433`, and the web app is mapped to `7777`.
- This is a preview environment first, not a hardened production deployment.

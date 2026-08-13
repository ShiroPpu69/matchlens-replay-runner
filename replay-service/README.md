# Match Lens replay service

This directory contains the independent Dota 2 DEM replay worker used by Match
Lens. It combines a pinned `odota/parser` Java runtime with an authenticated
Node.js queue gateway.

## What it extracts

When the replay contains the required entities, the worker returns verified:

- hero kills and death timestamps;
- assist counter changes, with explicit ambiguity for same-second deaths;
- hero position samples;
- purchases and ability upgrades;
- economy and experience snapshots;
- damage and healing events;
- wards, runes, buybacks, and map objectives.

The service does not invent events missing from the replay or parser.

## Required environment

| Variable | Purpose |
| --- | --- |
| `SERVICE_TOKEN` | Bearer token used by the web app to submit and read jobs |
| `CALLBACK_TOKEN` | Bearer token used to authenticate callbacks |
| `CALLBACK_BASE_URL` | Public origin of the Match Lens web application |
| `DATA_DIR` | Persistent job storage directory; recommended value: `/data` |

`SITES_BYPASS_TOKEN` is optional and only needed for a hosting platform that
protects server-to-server callback routes with an additional owner token.

All token values are secrets. Configure them through the deployment platform;
never add them to this repository or a Docker image.

## Run locally

From the repository root:

```bash
docker build -f replay-service/Dockerfile -t match-lens-replay .
docker run --rm -p 8080:8080 \
  -e SERVICE_TOKEN=local-development-only \
  -e CALLBACK_TOKEN=local-development-only \
  -e CALLBACK_BASE_URL=http://host.docker.internal:3000 \
  -e DATA_DIR=/data \
  match-lens-replay
```

Use a long random token outside local development.

## Production notes

- Attach persistent storage at `DATA_DIR`.
- Keep one or more always-available consumers for reliable queue throughput.
- Expose the health endpoint to your platform's health check.
- Allow only HTTPS replay URLs matching Valve replay hosts.
- Set memory and execution time for large matches.
- Keep callback and service tokens independent.
- Monitor terminal job errors and stale leases.

The included GitHub Actions runner can also claim queued work. Configure the
repository variables and secrets described in `.github/workflows/replay-parser.yml`.

## Accuracy boundary

Exact assists are reported only when a counter change can be assigned to one
death. If multiple heroes die in the same replay interval and assignment is not
unique, the result is marked ambiguous. Death coordinates come from the
victim's closest verified position sample; derived map labels are calculated by
the web application, not by AI.

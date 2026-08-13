# Match Lens Replay Runner

Public, resource-isolated DEM parsing runner for [棱镜 Match Lens](https://www.matchlens.dpdns.org/).

This repository intentionally contains only the replay parser service and GitHub Actions runner. The Match Lens application, production database configuration, AI prompts, billing logic, user data, and credentials remain in a private repository.

## Runtime

- GitHub-hosted `ubuntu-latest` runner for a public repository
- 4 CPU cores
- 16 GB RAM
- 14 GB temporary SSD
- Up to three isolated parser slots; one DEM stays within one runner

Every run verifies and prints its actual CPU, memory, and root-disk capacity before accessing the production queue. Production tokens are GitHub Actions secrets and are never committed.

## Security

- Workflow dispatch and repository administration remain owner-controlled.
- Pull requests do not receive production secrets.
- Parser callbacks require separate runner and callback bearer tokens.
- The main website can retain its private runner as a rollback target.
Public 4-core GitHub Actions runner for Match Lens Dota 2 replay parsing

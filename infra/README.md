# Hikyaku infrastructure

Two decoupled Docker Compose projects that talk to each other over a private
bridge network. The API can be redeployed without touching the heavy, slow-to-
build spatial stack, and nothing spatial is exposed to the internet.

| File | Compose project | Services |
|------|-----------------|----------|
| `docker-compose.yml` | `hikyaku-api` | `hikyaku` (+ `cloudflare_tunnel` in prod) |
| `spatial-docker-compose.yml` | `hikyaku-spatial` | `valhalla`, `vroom`, `photon` |

## How they connect

Both projects attach to an **external** Docker network, `hikyaku-net`. Docker's
embedded DNS resolves services by name across projects, so `hikyaku` reaches the
spatial services as `http://valhalla:8002` etc. — no host ports, no IPs.

The spatial services publish **no** host ports, so they are reachable only by
containers on `hikyaku-net` — not from localhost, the LAN, or the internet.
See [Optional: LAN / tailnet access](#optional-lan--tailnet-access) to change that.

![architecture](hikyaku-architecture.png)

## One-time setup

1. **Create the shared network**:

   ```bash
   docker network create hikyaku-net
   ```

2. **Provide the files the compose stacks expect**:

   | Path | Used by | Notes |
   |------|---------|-------|
   | `.env.prod` | `hikyaku` | API secrets + the spatial URLs below |
   | `vroom-conf/config.yml` | `vroom` | point `routingServers.valhalla` at `http://valhalla:8002` |
   | `photon/photon-1.1.0.jar` + `photon/photon_data/` | `photon` | jar and prebuilt index (see Photon mount below) |
   | `valhalla_tiles/` | `valhalla` | created automatically on first boot |

### `.env.prod` — wiring the API to the spatial services

The API resolves each spatial service from an env var. Set them to the service
names; they resolve over `hikyaku-net`:

```dotenv
VALHALLA_URL=http://valhalla:8002
VROOM_URL=http://vroom:3000
PHOTON_URL=http://photon:2322
```

## Running

```bash
# spatial stack
docker compose -f spatial-docker-compose.yml up -d

# api stack
docker compose up -d
```

> **First boot is slow.** Valhalla downloads the Australia-Oceania PBF and builds
> routing tiles before it answers — VROOM and the API will error until that
> finishes. Watch `docker compose -f spatial-docker-compose.yml logs -f valhalla`.

## Recommendations

### 1. Keep the Photon mount scoped

`spatial-docker-compose.yml` mounts `./photon:/app` rather than `./:/app`, so the
geocoder sees only its own jar and index — not the rest of `infra/`, which
includes `.env.prod`. **Don't widen it back:** a `./:/app` mount would hand the
API's Stripe/Supabase/DB secrets to the Photon container for no reason. The jar
and index therefore live in `infra/photon/`:

```
infra/photon/photon-1.1.0.jar
infra/photon/photon_data/      # prebuilt index — Photon won't serve without it
```

### 2. Optional: LAN / tailnet access

To reach the spatial services from other machines, publish the port **bound to a
specific interface** — the bind address decides how far it's exposed:

| `ports:` entry | Reachable from | Internet? |
|----------------|----------------|-----------|
| *(none — default)* | `hikyaku` container only | no |
| `"127.0.0.1:8002:8002"` | the host only | no |
| `"<host-LAN-IP>:8002:8002"` | your LAN | no |
| `"<tailscale-IP>:8002:8002"` | your tailnet | no |
| `"8002:8002"` (= `0.0.0.0`) | LAN **+ internet if host has a public IP** | ⚠️ maybe |

Caveats:

- `"8002:8002"` binds all interfaces; on a public-IP host that **is** internet
  exposure. Bind to a specific IP to make "LAN-only" intentional.
- **Docker bypasses `ufw`/`firewalld`** — a published port punches through the OS
  firewall. Control exposure with the bind address, not the firewall.
- The spatial services have **no auth**; anyone who can reach the port can use
  them. Prefer a Tailscale-IP bind for private cross-machine access.

Ports: `valhalla` 8002, `vroom` 3000, `photon` 2322.

# Deploying SiteRecon to the GCP VM

**Status of this guide.** Everything below is written and the shell scripts pass a syntax check, but none of it has been run against a real VM, the container image has not been built, and the GitHub workflows have never executed. Treat the first deploy as a test, do it in the order below, and stop at any failed check.

The target is the same e2-micro VM that runs RepoRecon (1 GB RAM, shared CPU). SiteRecon is sized to share it: the web app is capped at 256 MB of heap and 320 MB in total, the fetch container at 700 MB, one scan runs at a time, and a browser only starts when 400 MB is free.

## 0. Before you start

- A GitHub account that can make a **public** repository (public repos get free Actions minutes and free container hosting).
- Access to the VM over SSH, and to your Cloudflare DNS.
- Check the VM first: `free -m` and `swapon --show`. If RepoRecon's Semgrep scans already push it into swap, expect browser renders to be skipped often (the report then says so). The fix is to move only `fetch-service` to another free host with more memory. Nothing else changes.

## 1. Put the code on GitHub

```bash
cd siterecon
gh repo create siterecon --public --source . --push      # or create it in the GitHub UI and push master
```

In the repo settings, under Actions > General, allow workflows to read and write packages. The `Build fetch service image` workflow then publishes `ghcr.io/<you>/siterecon-fetch:latest`; make that package public so the VM can pull it without a login.

## 2. One-time VM setup

```bash
git clone https://github.com/<you>/siterecon.git ~/siterecon && cd ~/siterecon
sudo DEPLOY_USER=$USER bash deploy/vm/setup.sh
```

This adds swap only if the VM has none, creates the `siterecon-fetch` Docker network, installs the firewall rules, writes `/etc/siterecon/siterecon.env` with a fresh shared secret, and installs the systemd unit. It does not start anything and does not touch RepoRecon. Read the script first.

Then:

1. **Edit `/etc/siterecon/siterecon.env`** and add your keys (all optional): `NVIDIA_NIM_API_KEY`, `GEMINI_API_KEY`, `PAGESPEED_API_KEY`, `TAVILY_API_KEY`, `MLFLOW_URL`. Use a Google project with **billing off**, and sign up for Tavily without a card, so nothing can charge you.
2. **Caddy:** add `deploy/vm/Caddyfile.snippet` to the Caddyfile and `sudo systemctl reload caddy`.
3. **DNS:** in Cloudflare add `siterecon` as an A record to the VM's address, **DNS only** (grey cloud), the same as `reporecon`.
4. **Prove the firewall works:** `bash deploy/vm/verify-egress.sh`. Every private target must say `PASS blocked` and the public internet `PASS open`. **Do not start the fetch service if any line says FAIL.**

## 3. Add the GitHub deployment settings

Under Settings > Secrets and variables > Actions:

| Kind | Name | Value |
|---|---|---|
| Variable | `GCP_WORKLOAD_IDENTITY_PROVIDER` | The same provider RepoRecon's deploy uses |
| Variable | `GCP_SERVICE_ACCOUNT` | The same service account |
| Variable | `GCP_VM_NAME`, `GCP_VM_ZONE` | The VM's name and zone |
| Variable | `DEPLOY_USER` | The Linux user that owns `~/siterecon` |
| Secret | `GCP_SSH_PRIVATE_KEY` | The key RepoRecon's deploy uses |

The workload identity pool has to trust this repository as well as RepoRecon's. Add it in the pool's provider settings (the attribute condition currently names RepoRecon's repository).

## 4. First deploy and smoke test

Run the **Deploy to VM** workflow by hand. It builds, restarts the app, pulls and starts the fetch container, then calls `/api/accuracy` and prints `DEPLOY_OK`. Afterwards, from your own machine:

```bash
curl -s https://siterecon.georgemridun.dev/api/accuracy            # {"ok":true, ...}
curl -sN "https://siterecon.georgemridun.dev/api/scan/stream?url=georgemridun.dev" | head -40
```

Open the site, scan your own domain, and check that the **Browser** and **Social** steps do not say "skipped". Then check the logs: `journalctl -u siterecon -n 50` and `docker logs siterecon-fetch`.

### Check the rate limits see real visitors

`TRUST_PROXY=true` is only safe because Caddy replaces the visitor's `X-Forwarded-For` header. Prove it. From one machine, send six scans of six different sites, each with a different forged header:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Forwarded-For: 10.0.0.$i" \
    "https://siterecon.georgemridun.dev/api/scan/stream?url=example$i.com"
done
```

The limit is five scans an hour per visitor. If the sixth request answers **429**, the forged headers were ignored, as they should be. If all six succeed, the header is being trusted: set `TRUST_PROXY=false` in the env file, restart, and fix the Caddy block before going further. (Run this against throwaway domains; each accepted request can start a real scan.)

## 5. Turn on the portfolio section

In the Vercel project for the portfolio, set `NEXT_PUBLIC_SITERECON_URL=https://siterecon.georgemridun.dev` and redeploy. The section is invisible until that variable exists, so merging the portfolio code earlier is safe. The CORS allowlist in `lib/cors.ts` already includes `georgemridun.dev`.

## 6. Operating it

- **Update:** push to `master`. CI runs, and the deploy workflow starts only if it passed.
- **Roll back:** on the VM, `cd ~/siterecon && git checkout <good commit> && npm ci && npm run build && sudo systemctl restart siterecon`.
- **Daily limits** are in the env file (`RL_*`, `QUOTA_*`). Counters survive restarts, in `data/siterecon.db`.
- **Cost watch:** set a US$1 budget alert on the GCP project. The free tier includes 1 GB a month of outbound transfer, excluding China and Australia, so traffic to Australian visitors is billed. If it ever shows up on the bill, put Cloudflare's proxy in front of the static assets.

## Known risks

- **Chromium's sandbox is off.** Playwright starts it that way by default. The container is the boundary: no capabilities, read-only root, memory, CPU and process caps, and the egress rules. Do not weaken those.
- **`--cap-drop=ALL` plus a read-only root has not been tried with Chromium.** If `docker logs siterecon-fetch` shows the browser failing to start, relax one flag at a time in `run-fetch.sh` (`--shm-size` first), and keep the egress rules.
- **Memory is tight.** A scan needs the web app (about 150 MB), the fetch service (about 100 MB), and Chromium (300 to 400 MB) at the same time as RepoRecon. The guard skips the browser step rather than risk the VM, but if RepoRecon itself is near the limit, expect skips.

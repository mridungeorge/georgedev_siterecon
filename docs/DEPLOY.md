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

First install what the firewall rules need to survive a reboot (answer No when it offers to save the current rules), and check that the deploy user can run Docker (RepoRecon's deploy user already can):

```bash
sudo apt install iptables-persistent
id -nG $USER | tr ' ' '
' | grep -x docker      # must print: docker
```

```bash
git clone https://github.com/<you>/siterecon.git ~/siterecon && cd ~/siterecon
sudo DEPLOY_USER=$USER bash deploy/vm/setup.sh
```

This adds swap only if the VM has none, creates the `siterecon-fetch` Docker network, installs the firewall rules, writes two environment files, and installs the systemd unit. `/etc/siterecon/siterecon.env` is for the web app and holds your API keys. `/etc/siterecon/fetch.env` is for the browser container and holds only the shared secret, because that container opens hostile pages with Chromium's sandbox off and must never hold anything worth stealing. It does not start anything and does not touch RepoRecon. Read the script first.

Then:

1. **Edit `/etc/siterecon/siterecon.env`** and add your keys (all optional): `NVIDIA_NIM_API_KEY`, `GEMINI_API_KEY`, `PAGESPEED_API_KEY`, `TAVILY_API_KEY`, `MLFLOW_URL`. Use a Google project with **billing off**, and sign up for Tavily without a card, so nothing can charge you.
2. **Caddy:** add `deploy/vm/Caddyfile.snippet` to the Caddyfile and `sudo systemctl reload caddy`.
3. **DNS:** in Cloudflare add `siterecon` as an A record to the VM's address, **DNS only** (grey cloud), the same as `reporecon`.
4. **Prove the firewall works:** `bash deploy/vm/verify-egress.sh`. A probe passes as "blocked" only when the connection times out, so an unrelated failure cannot pass for a working firewall. The metadata server, RepoRecon and this VM's own address must say `PASS blocked`, and the public internet `PASS open`. Run it **again after the first deploy**: it then also checks that the web app can reach the container on `127.0.0.1:8787`. **If any line says FAIL, stop the container (`docker rm -f siterecon-fetch`) and fix it first.**

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

`TRUST_PROXY=true` is only safe because Caddy replaces the visitor's `X-Forwarded-For` header. Prove it. The limit is five scans an hour per visitor. From one machine, send six requests, each with a different forged header, using `--max-time 3` so each one starts a scan and then hangs up straight away (the scan is cancelled, but the request still counts). Use domains you own, because each accepted request does begin a real scan of that site:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -m 3 -w "%{http_code}
" -H "X-Forwarded-For: 10.0.0.$i"     "https://siterecon.georgemridun.dev/api/scan/stream?url=site$i.yourdomain.com"
done
```

The first five time out (printing `000`) because you hung up. If the sixth answers **429**, the forged headers were ignored, as they should be. If it also prints `000`, the header is being trusted: set `TRUST_PROXY=false` in the env file, restart, and fix the Caddy block before going further.

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
- **After a VM reboot the fetch container stays down** until the next deploy, or until you run `bash deploy/vm/run-fetch.sh`. That is deliberate: Docker can start containers before the firewall rules are loaded, and the script refuses to start the container without them. Until then reports say the browser and social steps could not run.
- **npm must be on systemd's PATH.** The unit starts the app with `/usr/bin/env npm`. If node comes from nvm, add `Environment=PATH=...` to the unit.
- **DNS inside the container** uses 1.1.1.1 and 8.8.8.8 (`--dns` in `run-fetch.sh`), because the VM's own resolver is the metadata server, which the firewall blocks.
- **The browser filter is best effort.** The firewall is the boundary, which is why the deploy refuses to start the container without it.
- **Memory is tight.** A scan needs the web app (about 150 MB), the fetch service (about 100 MB), and Chromium (300 to 400 MB) at the same time as RepoRecon. The guard skips the browser step rather than risk the VM, but if RepoRecon itself is near the limit, expect skips.

## Optional: Instagram through Meta's official API

Without this, Instagram links are read through the fetch service, and Instagram usually answers with a login wall. With it, SiteRecon reads the public follower count, post count and latest post of any Instagram **business or creator** account that a site links to. Personal accounts cannot be read through the API, and the report says so.

1. In the Instagram app, switch the account you will connect to a **Business** or **Creator** account, and link it to a Facebook Page.
2. In the Meta developer dashboard, create an app with the Instagram API use case, add the Facebook-login setup, and give it the permissions `instagram_basic`, `pages_show_list`, `pages_read_engagement` and `business_management`.
3. Generate a user access token for that account with those permissions, using Graph API Explorer on **graph.facebook.com**. Then run `me/accounts?fields=name,instagram_business_account` and note the Instagram `id` it returns.
4. On the VM, edit `/etc/siterecon/siterecon.env` yourself (never paste the token into a chat or a ticket) and set `META_IG_USER_ID` and `META_ACCESS_TOKEN`, then `sudo systemctl restart siterecon`.
5. Scan a site that links a business Instagram account. The report should show its follower count under Social media.

The token lasts about 60 days. When it expires, the Instagram line in the report says "the Instagram access token has expired or was revoked, so it needs renewing" and everything else carries on. Generate a new token the same way and replace the value.

Status: written and tested against fakes. It has not yet been run against the real Instagram API.

## Optional: MLflow, to track scans over time

MLflow is a free, open-source dashboard for experiment tracking. It needs no API key: it is a small server, and SiteRecon only needs its address. SiteRecon then records one run per finished scan (overall and per-module scores, duration, findings, pages read) in an experiment called `siterecon`. Cached results are not logged. It changes nothing in the report.

MLflow has **no login**, so it listens on the VM's loopback address only. Never publish port 5000. If another app on a different host should log to it, put a login in front of it first (Caddy basic auth, or a private network such as Tailscale).

```bash
docker run -d --name mlflow --restart unless-stopped \
  --memory=350m --memory-swap=350m --cpus=0.5 \
  -p 127.0.0.1:5000:5000 \
  -v mlflow-data:/mlflow \
  ghcr.io/mlflow/mlflow:v2.18.0 \
  mlflow server --host 0.0.0.0 --port 5000 --workers 1 \
  --backend-store-uri sqlite:////mlflow/mlflow.db \
  --default-artifact-root /mlflow/artifacts
curl -s http://127.0.0.1:5000/health    # prints OK
```

Then set `MLFLOW_URL=http://127.0.0.1:5000` in `/etc/siterecon/siterecon.env` and restart `siterecon`. To see the dashboard, open an SSH tunnel from your own computer (`ssh -L 5000:127.0.0.1:5000 <vm>`) and browse to http://localhost:5000. Back up the `mlflow-data` volume now and then: it holds the only copy of the history.

Checked on the real VM on 2026-10-10: the `siterecon` experiment was created and a run was recorded for a live scan. Memory use was about 230 MB of the 350 MB cap.

# Deploy `agentclass` to a VPS for Claude.ai testing

Claude.ai (browser) requires MCP servers reachable via **HTTPS** to register them as Custom Connectors. This guide gets you from a fresh VPS to a working connector in ~15 min.

## Prereqs

- Ubuntu 22.04+/Debian 12+ VPS
- Root or sudo access
- A domain pointed at the VPS IP (an `A` record like `agentclass.yourdomain.com`)
- Node 20+ on the VPS

## Steps

### 1. Provision the VPS

```bash
# As root
apt update && apt install -y git curl nginx certbot python3-certbot-nginx ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
useradd -m -s /bin/bash mcp
```

### 2. Clone + install

```bash
# As mcp
cd /opt
git clone <your-repo-url> mcp-agentclass
cd mcp-agentclass
npm install
cp .env.example .env
nano .env   # fill in PANDA_API_KEY, OPENAI_API_KEY
```

Generate the bearer token Claude.ai will use to authenticate:

```bash
openssl rand -hex 32
```

Paste it into `.env` as `MCP_AUTH_TOKEN=<the-hex>`.

### 3. Ingest the course

Either copy `data/` from your local machine:

```bash
# On your local machine
scp -r data/lessons.json data/transcripts data/vectors.db mcp@<vps-ip>:/opt/mcp-agentclass/data/
```

OR run the ingestion on the VPS (`npm run ingest:all` — ~30min, costs ~$0.60 OpenAI).

### 4. Install the systemd service

```bash
# As root
cp /opt/mcp-agentclass/deploy/agentclass.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agentclass
systemctl status agentclass         # should be "active (running)"
curl http://127.0.0.1:3333/health    # should return {"ok":true,...}
```

### 5. Front it with nginx + HTTPS

```bash
# As root
cp /opt/mcp-agentclass/deploy/nginx.conf.example /etc/nginx/sites-available/agentclass.conf
# Edit the file: replace `agentclass.yourdomain.com` with your real domain
nano /etc/nginx/sites-available/agentclass.conf
ln -s /etc/nginx/sites-available/agentclass.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Issue cert + auto-configure HTTPS
certbot --nginx -d agentclass.yourdomain.com
```

You should now be able to:

```bash
curl https://agentclass.yourdomain.com/health
```

### 6. Register as a Custom Connector in Claude.ai

1. Open https://claude.ai/customize/connectors
2. Click **Add Custom Connector**
3. Name: `agentclass`
4. URL: `https://agentclass.yourdomain.com/mcp`
5. Authentication: **Bearer token** → paste the `MCP_AUTH_TOKEN` value
6. Save and click **Connect**

Once connected, the 5 tools (`list_lessons`, `get_lesson`, `search_course`, `excerpt_transcript`, `play_lesson`) become available in any Claude.ai chat.

### Troubleshooting

- **502 from nginx:** `systemctl status agentclass` — usually a missing env var
- **CORS error in claude.ai console:** the `setCORS` helper covers `*` origins; if your nginx strips headers, check `proxy_pass_request_headers on;`
- **Tools call but no response:** check `journalctl -u agentclass -f` for errors during a tool call
- **Player still doesn't render inline:** that's a client-side question; the resource is being sent correctly (verify with `npm run inspect` locally)

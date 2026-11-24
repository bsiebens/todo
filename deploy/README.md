# Running the ToDo server at home

One container serves the web app and keeps your devices in sync. It sits next to a Postgres container and a small backup container. Devices outside your home reach it over HTTPS through your reverse proxy.

```
iPhone / iPad / office PC / home Mac
        │  HTTPS (and a WebSocket for live updates)
        ▼
reverse proxy with a certificate  ──►  app :8080  ──►  db (Postgres)
                                                       backup (nightly dump)
```

## 1. Start it

On the home server, with Docker and Docker Compose installed:

```sh
git clone https://github.com/bsiebens/todo.git
cd todo/deploy
cp .env.example .env
nano .env          # set APP_URL and POSTGRES_PASSWORD at least
docker compose up -d --build
docker compose logs app
```

The log ends with a line like:

```
Not set up yet. Open https://todo.example.com, go to Settings > Sync and enter the setup code: VNRR-M84W
```

Keep that code for step 3.

Data lives in `deploy/data/postgres`, backups in `deploy/backups`.

### Settings in `.env`

| Setting | What |
| --- | --- |
| `APP_URL` | The address you open the app at, for example `https://todo.example.com`. Passkeys are tied to this host name, so choose it once. |
| `POSTGRES_PASSWORD` | Any long random string. |
| `PORT` | Port on the home server for the reverse proxy to forward to. Default 8080. |
| `SETUP_CODE` | Optional. Your own code for setting up the first device. Otherwise one is generated and shown in the log. |
| `OWNER_EMAIL`, `SMTP_URL`, `MAIL_FROM` | Optional. Turns on "Email me a code". Only `OWNER_EMAIL` can receive codes. `SMTP_URL` looks like `smtps://user:password@smtp.example.com:465`. |

## 2. Reverse proxy

Forward your HTTPS name to `http://<home-server>:8080`. WebSockets must be passed through (most proxies do this by default; nginx needs the two `Upgrade` lines).

Caddy:

```
todo.example.com {
    reverse_proxy 192.168.1.10:8080
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name todo.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://192.168.1.10:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}
```

Nginx Proxy Manager: add a proxy host for the name, forward to port 8080, tick "Websockets Support" and request a certificate.

Cloudflare Tunnel or Tailscale Funnel work too: point them at `http://localhost:8080`.

> If you already run the phase-2 web app at this address, replace that container with this one and keep the same address. The tasks already stored in your browsers belong to that address and are uploaded at the first sign-in. On a different address the browser starts empty.

## 3. Sign in your devices

1. **First device**: open the app, go to **Settings**, enter the setup code from the log under **Sync and sign-in**, press **Set up**. Anything already on this device is uploaded.
2. **Add a passkey** (recommended): on that device press **Add a passkey on this device**. Passkeys made on an iPhone, iPad or Mac sync through iCloud Keychain, so those devices can then use **Sign in with a passkey**.
3. **Other devices**: either **Sign in with a passkey**, or on a signed-in device press **Show a one-time code** and type the code on the new device. The code works once and for 10 minutes. This is the easiest route for the office PC if passkeys are not allowed there.
4. **iPhone and iPad**: open the address in Safari, then Share, **Add to Home Screen**, and open the app from the Home Screen before signing in. The Home Screen app has its own storage, separate from Safari, and only the Home Screen app can show notifications.

Each device can be signed out from any other device under **Signed-in devices**.

**Locked out?** (lost all devices and passkeys) On the server run

```sh
docker compose exec app node server.cjs signin-code
```

It prints a one-time code that is valid for an hour.

## 4. Reminders

Reminders are Web Push notifications sent by the server, so they arrive while the app is closed.

- Turn them on per device: **Settings, Reminders, Turn on**, then **Send a test**.
- **Due time**: a notification when a task with a due time is due, or 5 to 60 minutes before.
- **Morning summary**: at a set time, how many tasks are due today and overdue.
- These two settings sync to all devices. Times are read in the time zone of the device that most recently turned notifications on.
- iPhone and iPad need iOS/iPadOS 16.4 or later and the app added to the Home Screen.

## Backups and restore

The `backup` container writes `backups/todo-YYYY-MM-DD.sql.gz` every 24 hours and keeps the newest 14. Copy that folder off the server now and then. Each device also has a full copy, and **Settings, Data, Export everything as JSON** works at any time.

To restore a dump into an empty database:

```sh
docker compose stop app
gunzip -c backups/todo-2026-11-24.sql.gz | docker compose exec -T db psql -U todo -d todo
docker compose start app
```

## Updating

```sh
cd todo && git pull
cd deploy && docker compose up -d --build
```

Database changes run automatically at start.

## How sync works, briefly

Every edit on a device is stored as small field changes ("title of task X is now ...") stamped with a hybrid logical clock. Devices push those changes and pull what is new since their last visit. When two devices change the same field while offline, the later change wins; changes to different fields of the same task both survive. Notes never conflict. The server re-checks two rules that two offline devices could break together: a dependency loop and a project moved inside itself. It undoes the change that closed the loop, and that device shows "This link was undone because it created a loop."

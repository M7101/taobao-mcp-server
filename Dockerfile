# Official Playwright image ships every system library Chromium needs
# (glib, nss, etc.) — Railway's default Nixpacks build ran `playwright
# install --with-deps chromium` but that silently failed to install those
# libraries (Nixpacks' base image isn't the apt-based one --with-deps
# expects), leaving Chromium unable to even start. This sidesteps that
# entirely instead of fighting Nixpacks' package manager.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# xvfb: local testing confirmed the Taobao session only stays stable when
# Chromium runs headed (headless has a detectable, distinct fingerprint even
# from an otherwise identical, correctly-restored browser profile) — but a
# Railway container has no real display at all. Xvfb fakes one entirely in
# software, so a real headed Chromium can run on a headless server; xvfb-run
# is the wrapper that starts it, sets DISPLAY, and runs the actual command.
# xauth: xvfb-run's "-a" auto-display mode generates an X11 auth cookie via
# xauth — without it installed, xvfb-run can hang indefinitely waiting for
# the display to become ready instead of failing loudly.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:ts

# The actual logged-in session — a real Chromium profile directory (cookies,
# localStorage, IndexedDB, Service Worker state, device fingerprint), not a
# storageState() snapshot. storageState() never captures IndexedDB, which is
# where part of Taobao's own risk-control device identity lives; sessions
# built that way kept dying within minutes regardless of IP or pacing. This
# means updating the session now means logging in locally again (login_taobao
# / complete_taobao_login against PROFILE_DIR in src/taobao.ts) and
# redeploying, not just setting an env var.
COPY browser-profile ./browser-profile

ENV NODE_ENV=production
# The only log line ever seen from the container was Railway's own
# "Starting Container" — nothing from the app itself, for the entire
# lifetime of a long-running server that logs immediately on startup. That
# pattern (not even one line, ever) fits output getting fully buffered
# somewhere in the xvfb-run wrapper chain far more than an actual hang — a
# genuine hang during Chromium/Xvfb startup would still have let the
# earlier synchronous logs (bearer token, etc.) through first. stdbuf forces
# line buffering; the leading echo is a real unbuffered canary — if that
# alone doesn't show up either, the problem isn't in the app or Xvfb at all.
CMD ["sh", "-c", "echo CONTAINER_SHELL_STARTED; stdbuf -oL -eL xvfb-run -a --server-args=-screen\\ 0\\ 1280x1024x24 node dist/httpServer.js"]

# X user auth (official OAuth 2.0)

Local PKCE login for **your** X account. This is the supported way to let
scripts post or read as you. It is **not** Grok and **not** a password
collector.

The cloud agent cannot finish this login for you. You must create an X app
and run `login` on a machine where you can open a browser.

## 1. Create an X app

1. Go to [developer.x.com](https://developer.x.com) → Project → App.
2. User authentication settings → **OAuth 2.0**.
3. Type: **Web App** (confidential) or native (public + PKCE).
4. Callback / redirect URI (must match exactly):

   `http://127.0.0.1:8787/callback`

5. Website URL can be your GitHub profile.
6. Copy **Client ID**. For a confidential app, also copy **Client Secret**.
7. App permissions: **Read and write** (needed to post).

Do not paste those values into chat.

## 2. Login on your laptop

```bash
cd tools/x-auth
export X_CLIENT_ID='your_client_id'
export X_CLIENT_SECRET='your_client_secret'   # omit only for a public PKCE app
export X_REDIRECT_URI='http://127.0.0.1:8787/callback'

python3 xauth.py login
python3 xauth.py me
```

Default scopes: `tweet.read tweet.write users.read offline.access`.

Tokens are written to `~/.config/x-user/tokens.json` (mode `0600`).
Refresh happens automatically on `me` / `post`.

## Alternative: OAuth 1.0a (no Safari window)

If `login` keeps failing, use Access Token + Secret from the console:

1. App → **Settings** → permissions **Read and write** → save.
2. **Keys and tokens** → **Access Token and Secret** → **Generate**.
3. On your Mac:

```bash
export X_API_KEY='Consumer Key'
export X_API_SECRET='Consumer Secret'
export X_ACCESS_TOKEN='Access Token'
export X_ACCESS_TOKEN_SECRET='Access Token Secret'
python3 xauth.py login-v1
python3 xauth.py me
```

## 3. Post the intern tweet

```bash
python3 xauth.py post --file ../../examples/release-watch-py/SOCIAL.md
```

Free-tier X still caps post length at 280 characters. `SOCIAL.md` is longer —
shorten it or use a Premium account. Example short post:

```bash
python3 xauth.py post --text "$(cat <<'EOF'
Release Watch on Solari (browser + sandbox + desktop):
https://github.com/mangeshraut712/solari-cookbook/tree/main/examples/release-watch-py
@harrychow_ @getsolari
EOF
)"
```

## 4. Logout

```bash
python3 xauth.py logout
```

## What this will never do

- Ask for your X password
- Read DMs unless you add `dm.read` yourself (do not, unless you need it)
- Upload tokens to git

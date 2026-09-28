// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { bareUrls, fileSignals, keysSignal, modeSignal, nameSignal, pemSignal, topLevelKeys, urlSignal } from "../src/index.js";

describe("credential shape", () => {
  it("name patterns: token and secret as whole words, env files, npmrc, pypirc, git-credentials, dotted credentials", () => {
    const yes = ["credentials.db", ".credentials.json", "auth.json", "hosts.yml", "access-token", "server.pem", "atuin.key", "key", "id_rsa", ".netrc", "token.txt", "my_secret", "stored_tokens", "access_tokens.db", ".secrets", ".env", ".env.local", ".env.production", ".npmrc", ".pypirc", ".git-credentials", "7a66_tokens.json", "client_secret.json"];
    expect(yes.map(nameSignal)).toEqual(Array<boolean>(yes.length).fill(true));
    const no = ["credentials.go", "auth.json.example", "id_rsa.pub", "token.ts", "config.yml", "settings.json", "README.md", "tokenizer.json", "tokenizer_config.json", "known_hosts", ".viminfo", ".CFUserTextEncoding", ".z", "zsh_history", ".env.example", ".envrc", "secretary.txt"];
    expect(no.map(nameSignal)).toEqual(Array<boolean>(no.length).fill(false));
  });

  it("mode: owner-only and under 100 KB, never empty", () => {
    const e = { kind: "file" as const, mtime: 0 };
    expect(modeSignal({ ...e, mode: 0o600, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o400, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o644, bytes: 100 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 0 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 200 * 1024 })).toBe(false);
  });

  it("key names at any depth of JSON, YAML, TOML and KEY=value files", () => {
    expect(topLevelKeys('{"token":"x","user":{"password":"y"}}')).toEqual(["token", "user", "password"]);
    expect(topLevelKeys("github.com:\n    oauth_token: x\nclient-secret: y\n")).toEqual(["github.com", "oauth_token", "client-secret"]);
    expect(topLevelKeys('[registry]\napi_key = "x"\n')).toEqual(["api_key"]);
    expect(topLevelKeys("//registry.npmjs.org/:_authToken=x\nregistry=https://r\n")).toEqual(["_authToken", "registry"]);
    expect(topLevelKeys('// settings\n{\n  "theme": "dark",\n  "vim_mode": true,\n}\n')).toEqual(["theme", "vim_mode"]);
    expect(keysSignal('{"access_token":"x"}')).toBe(true);
    expect(keysSignal("client-secret: y\n")).toBe(true);
    expect(keysSignal('{"claudeAiOauth":{"accessToken":"x"}}')).toBe(true);
    expect(keysSignal('{"auths":{}}')).toBe(true);
    expect(keysSignal("ANTHROPIC_API_KEY=sk-x\n")).toBe(true);
    expect(keysSignal("//registry.npmjs.org/:_authToken=x\n")).toBe(true);
    expect(keysSignal('{"theme":"dark","editor":{"fontSize":13}}')).toBe(false);
    expect(keysSignal('{"model_max_length":512}')).toBe(false);
    expect(keysSignal('{"os_crypt":{"encrypted_key":"x"},"sort_key":1,"max_tokens":3,"key":"pub"}')).toBe(false);
    expect(keysSignal("sort_key=46\nhide_kernel_threads=1\n")).toBe(false);
    expect(keysSignal('{"packages":{"node_modules/password-prompt":{"version":"1"}}}')).toBe(false);
    expect(keysSignal('["token"]')).toBe(false);
    const crlf = "API_KEY=sk-live-000fake\r\nPASSWORD=hunter2\r\n";
    expect(topLevelKeys(crlf)).toEqual(["API_KEY", "PASSWORD"]);
    expect(keysSignal(crlf)).toBe(true);
    expect(keysSignal("github.com:\r\n    oauth_token: ghp_000fake\r\n")).toBe(true);
    expect(keysSignal('[registry]\r\napi_key = "xaat-000-fake"\r\n')).toBe(true);
    expect(keysSignal('api_key = "${AXIOM_TOKEN}"\r\n')).toBe(false);
  });

  it("a value that points at a secret is not one: a workflow's template reference, a compose or toml environment reference, a placeholder, an empty value", async () => {
    const workflow = "name: ci\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.GITHUB_TOKEN }}\n";
    expect(keysSignal(workflow)).toBe(false);
    for (const reference of ["password: ${DB_PASSWORD}\n", 'api_key = "${AXIOM_TOKEN}"\n', "SECRET_KEY=$SECRET_KEY\n", "API_TOKEN=<your-token>\n", "API_TOKEN=\n", '{"token":""}', '{"token":"${TOKEN}"}', 'access_key = "${AWS_ACCESS_KEY_ID:-none}"\n', 'api_key = "${AXIOM_TOKEN}" # set in CI\n', "api_key: ${AXIOM_TOKEN} # prod\n", "token: ${{ secrets.X }}   # ci\n", "password: # not set\n"]) {
      expect(keysSignal(reference), reference).toBe(false);
    }
    for (const held of ["API_KEY=sk-live-000fake\n", 'api_key = "sk-live-000fake"\n', '{"token":"sk-ant-x"}', "password: hunter2\n", "API_KEY=abc#def\n", "password: hunter2 # note\n"]) {
      expect(keysSignal(held), held).toBe(true);
    }
    const compose = "services:\n  api:\n    environment:\n      DATABASE_URL: postgres://u:${PW}@db:5432/app\n";
    expect(urlSignal(compose)).toBe(false);
    expect(bareUrls(compose)).toEqual({ text: compose, urls: [] });
    for (const reference of ["DATABASE_URL=postgres://u:$PW@db:5432/app\n", "DATABASE_URL=postgres://u:<password>@db:5432/app\n", "REDIS_URL=redis://:${REDIS_PASSWORD}@cache:6379\n"]) {
      expect(urlSignal(reference), reference).toBe(false);
      expect(bareUrls(reference)).toEqual({ text: reference, urls: [] });
    }
    expect(urlSignal("DATABASE_URL=postgres://u:s3cr3t@db:5432/app\n")).toBe(true);
    const read = (name: string, text: string) => fileSignals(name, { bytes: Buffer.byteLength(text), mode: 0o644 }, async () => text, false);
    expect(await read("ci.yml", workflow)).toBeUndefined();
    expect(await read("docker-compose.yml", compose)).toBeUndefined();
    expect(await read("vector.toml", '[sinks.axiom]\napi_key = "${AXIOM_TOKEN}"\n')).toBeUndefined();
    expect(await read(".env", "API_KEY=sk-live-000fake\n")).toEqual(["name", "keys"]);
    expect(await read(".env", "API_KEY=sk-live-000fake\r\n")).toEqual(["name", "keys"]);
  });

  it("PEM header", () => {
    expect(pemSignal("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n")).toBe(true);
    expect(pemSignal("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
    expect(pemSignal("-----BEGIN CERTIFICATE-----\n")).toBe(false);
    expect(pemSignal("ssh-ed25519 AAAA\n")).toBe(false);
  });

  it("URL credentials: a password in the userinfo anywhere in the text; a username alone, a bare host or an scp path is not one", async () => {
    const config = '[remote "origin"]\n\turl = https://x-access-token:ghp_fake_token_000@github.com/example/proj.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[http]\n\tproxy = http://dev:fakepw@proxy.local:3128\n';
    expect(urlSignal(config)).toBe(true);
    expect(bareUrls(config)).toEqual({
      text: '[remote "origin"]\n\turl = https://github.com/example/proj.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[http]\n\tproxy = http://proxy.local:3128\n',
      urls: ["https://github.com/example/proj.git", "http://proxy.local:3128"],
    });
    for (const clean of ["url = https://github.com/example/proj.git\n", "url = https://dev@github.com/example/proj.git\n", "url = git@github.com:example/proj.git\n", "url = ssh://git@github.com/example/proj.git\n", "listen = http://localhost:8080/@me\n"]) {
      expect(urlSignal(clean), clean).toBe(false);
      expect(bareUrls(clean)).toEqual({ text: clean, urls: [] });
    }
    expect(bareUrls('url = "https://dev:fakepw@github.com/example/proj.git"\n')).toEqual({ text: 'url = "https://github.com/example/proj.git"\n', urls: ["https://github.com/example/proj.git"] });
    for (const empty of ["url = https://:ghp_fake_token_000@github.com/o/r\n", "REDIS_URL=redis://:fakepw@cache.local:6379\n"]) expect(urlSignal(empty), empty).toBe(true);
    expect(bareUrls("url = https://:ghp_fake_token_000@github.com/o/r\n")).toEqual({ text: "url = https://github.com/o/r\n", urls: ["https://github.com/o/r"] });
    const read = (text: string) => fileSignals("config", { bytes: Buffer.byteLength(text), mode: 0o644 }, async () => text, false);
    expect(await read(config)).toEqual(["url"]);
    expect(await read("[remote \"origin\"]\n\turl = https://github.com/example/proj.git\n[credential]\n\thelper = osxkeychain\n")).toBeUndefined();
    expect(await read("https://dev:ghp_fake@github.com\n")).toEqual(["url"]);
  });
});

# frozen_string_literal: true
#
# Sandbox quickstart — run untrusted code in a fresh microVM.
#
# A sandbox is a full Linux VM that boots from a memory snapshot, so it's
# usually ready in about a second. Nothing you run inside can touch your
# machine or another customer's.
#
# There is no Ruby SDK yet, so this talks to the HTTP API directly. That turns
# out to be the whole story for commands: `POST /sandboxes/:id/exec` is a
# deliberate fast path that skips the control-channel handshake, so a useful
# sandbox program needs nothing beyond net/http and json from stdlib.

require "net/http"
require "json"
require "uri"

BASE = "https://api.getsolari.com"
KEY  = ENV.fetch("SOLARI_API_KEY")

def api(method, path, body = nil)
  uri = URI("#{BASE}#{path}")
  klass = { post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
  req = klass.new(uri)
  req["Authorization"] = "Bearer #{KEY}"
  req["Accept"] = "application/json"
  if body
    req["Content-Type"] = "application/json"
    req.body = JSON.generate(body)
  end

  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
  # Error bodies echo the request, so scrub anything key-shaped before it can
  # reach a terminal or a log.
  raw = res.body.to_s.gsub(/slr_[a-z]+_[A-Za-z0-9._\-]+/, "slr_***")
  raise "HTTP #{res.code}: #{raw[0, 300]}" unless res.code.to_i.between?(200, 299)

  raw.empty? ? {} : JSON.parse(raw)
end

# Run one binary. `cmd` is NOT shell-interpreted — argv goes in `args`. For
# pipes, globs or redirection, run a shell explicitly (see `sh` below).
def exec_in(id, cmd, *args)
  api(:post, "/sandboxes/#{URI.encode_www_form_component(id)}/exec",
      { cmd: cmd, args: args.map(&:to_s) })
end

def sh(id, script) = exec_in(id, "/bin/sh", "-c", script)

sandbox = api(:post, "/sandboxes", {
  template: "base",
  # Rolling IDLE window — it resets on every use, it is not a hard deadline.
  timeoutMs: 5 * 60_000
})
id = sandbox.fetch("sandboxId")
puts "sandbox: #{id[0, 24]}..."

begin
  out = exec_in(id, "python3", "-c", "print(sum(range(101)))")
  puts "exit: #{out['exitCode']} stdout: #{out['stdout'].strip}"

  sh(id, "printf 'written over the HTTP API\n' > /tmp/hello.txt")
  puts "file  : #{sh(id, 'cat /tmp/hello.txt')['stdout'].strip}"
  puts "ls    : #{sh(id, 'ls /tmp')['stdout'].split.join(' ')}"
ensure
  # DELETE destroys the remote VM. Dropping your local connection alone would
  # leave it running until the idle timeout expires.
  api(:delete, "/sandboxes/#{URI.encode_www_form_component(id)}")
  puts "killed."
end

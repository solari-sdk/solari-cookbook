// SPDX-License-Identifier: AGPL-3.0-only
//! URLs a terminal prints, read as the node daemon reads them. A sign-in URL's redirect_uri names the callback port
//! the host forwards; a plain local URL names a port the host forwards to the laptop's loopback. Escapes are
//! stripped first, and a typed line readline wrapped at the pty width is joined back into one before matching.

use wsp_frames::is_http_url;
use wsp_frames::{numbers, RelayPort};

/// Hosts a sign-in's redirect comes back to on the machine itself.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
/// Hosts a dial of localhost on the machine reaches: the loopback names and the wildcard binds servers print.
const LOCAL_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"];
/// How much of a pty's output the scanner keeps so a URL split across chunks still matches.
const TAIL_CHARS: usize = 2048;

struct Url {
    hostname: String,
    port: Option<u16>,
    query: String,
}

/// Enough of a URL to read its host, port and query: the scheme, an authority without userinfo, the port when it is
/// explicit and not the scheme's default, and the query without the fragment.
fn parse_url(s: &str) -> Option<Url> {
    let at = s.find("://")?;
    let scheme = s[..at].to_ascii_lowercase();
    let mut letters = scheme.chars();
    if !letters.next()?.is_ascii_alphabetic() || !letters.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let rest = &s[at + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host_port.is_empty() {
        return None;
    }
    let (hostname, port) = if let Some(inner) = host_port.strip_prefix('[') {
        let close = inner.find(']')?;
        let tail = &inner[close + 1..];
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p),
            None if tail.is_empty() => None,
            None => return None,
        };
        (format!("[{}]", inner[..close].to_ascii_lowercase()), port)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (host_port.to_ascii_lowercase(), None),
        }
    };
    let port = match port {
        None | Some("") => None,
        Some(p) => {
            if !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 65535 {
                return None;
            }
            Some(n as u16)
        }
    };
    let port = match (scheme.as_str(), port) {
        ("http", Some(80)) | ("https", Some(443)) => None,
        (_, p) => p,
    };
    let after = rest[end..].split('#').next().unwrap_or("");
    let query = after.split_once('?').map(|(_, q)| q.to_owned()).unwrap_or_default();
    Some(Url { hostname, port, query })
}

/// Percent-decoding as a query string is read: a plus is a space.
fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Url {
    fn query_param(&self, name: &str) -> Option<String> {
        self.query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(k) == name).then(|| form_decode(v))
        })
    }
}

fn valid_port(n: u32) -> Option<u16> {
    u16::try_from(n).ok().and_then(RelayPort::new).map(RelayPort::get)
}

/// Which port on the machine a sign-in URL's redirect_uri names, for the forward to bind on the laptop: absent when
/// the page does not come back to the machine, when the redirect names no explicit port, or when the port is one
/// the laptop could not bind.
pub(crate) fn callback_port_of(url: &str) -> Option<u16> {
    let target = parse_url(&parse_url(url)?.query_param("redirect_uri")?)?;
    if !LOOPBACK_HOSTS.contains(&target.hostname.as_str()) {
        return None;
    }
    valid_port(u32::from(target.port?))
}

/// The port a plain local URL names: http or https, a local host and an explicit port. The open socket's road reads
/// it for a URL a tool asked to open.
pub(crate) fn localhost_port_of(url: &str) -> Option<u16> {
    let parsed = parse_url(url)?;
    if !is_http_url(url) || !LOCAL_HOSTS.contains(&parsed.hostname.as_str()) {
        return None;
    }
    valid_port(u32::from(parsed.port?))
}

/// A host the WHATWG parser behind node's URL would refuse: empty, or carrying a code point no host may (a percent
/// sign, an angle bracket, a backslash, a caret, a bar, a control character).
fn host_ok(hostname: &str) -> bool {
    !hostname.is_empty() && !hostname.chars().any(|c| matches!(c, '%' | '<' | '>' | '\\' | '^' | '|') || c.is_control())
}

/// The protocol's isHttpUrl as the open socket applies it: http or https with nothing unprintable, at most
/// OPEN_URL_MAX characters as a JavaScript string counts them, and a URL the parser can read a host out of.
pub(crate) fn is_open_url(url: &str) -> bool {
    if url.encode_utf16().count() > numbers::OPEN_URL_MAX || !is_http_url(url) {
        return false;
    }
    parse_url(url).is_some_and(|u| host_ok(u.hostname.trim_start_matches('[').trim_end_matches(']')))
}

/// The end of an OSC, DCS or APC string started at `from`: the body runs to the first BEL or ESC; a BEL ends it,
/// and so does an ESC followed by a backslash; any other ESC leaves the sequence unmatched and its bytes visible.
fn string_end(chars: &[char], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j < chars.len() {
        match chars[j] {
            '\x07' => return Some((j, j + 1)),
            '\x1b' => return (chars.get(j + 1) == Some(&'\\')).then_some((j, j + 2)),
            _ => j += 1,
        }
    }
    None
}

/// The end of a CSI started at `from`: parameter bytes, intermediates, one final byte.
fn csi_end(chars: &[char], from: usize) -> Option<usize> {
    let mut j = from;
    while j < chars.len() && ('0'..='?').contains(&chars[j]) {
        j += 1;
    }
    while j < chars.len() && (' '..='/').contains(&chars[j]) {
        j += 1;
    }
    (j < chars.len() && ('@'..='~').contains(&chars[j])).then_some(j + 1)
}

/// The URI an OSC 8 body carries, `8;<params>;<uri>` with no semicolon in the params.
fn osc8_uri(body: &[char]) -> Option<String> {
    let rest = body.strip_prefix(&['8', ';'])?;
    let semi = rest.iter().position(|&c| c == ';')?;
    Some(rest[semi + 1..].iter().collect())
}

/// Each hyperlink escape replaced by the URI it carried (the visible text may be a word), every other OSC, DCS and
/// APC string dropped, colour and bold gone.
fn strip_escapes(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\x1b' || i + 1 >= chars.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let taken = match chars[i + 1] {
            ']' => string_end(chars, i + 2).map(|(body_end, next)| {
                if let Some(uri) = osc8_uri(&chars[i + 2..body_end]) {
                    if !uri.is_empty() {
                        out.extend(uri.chars());
                        out.push(' ');
                    }
                }
                next
            }),
            'P' | '_' => string_end(chars, i + 2).map(|(_, next)| next),
            '[' => csi_end(chars, i + 2),
            _ => None,
        };
        match taken {
            Some(next) => i = next,
            None => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Terminal text as a URL matcher must see it. With a width known, a space and a bare carriage return exactly at
/// the width since the last line break is readline's soft wrap of a typed line and is removed; anywhere else, or
/// with no width known, it is a redraw and stays. Positions count UTF-16 units, as the node daemon counts them.
pub(crate) fn clean_terminal_text(text: &str, cols: Option<usize>) -> String {
    let chars: Vec<char> = text.chars().collect();
    let flat = strip_escapes(&chars);
    let Some(cols) = cols else { return flat.into_iter().collect() };
    let mut out = String::with_capacity(flat.len());
    let mut line_start = 0usize;
    let mut at = 0usize;
    let mut i = 0;
    while i < flat.len() {
        let c = flat[i];
        if c == ' ' && flat.get(i + 1) == Some(&'\r') && flat.get(i + 2) != Some(&'\n') && at - line_start == cols {
            at += 2;
            line_start = at;
            i += 2;
            continue;
        }
        out.push(c);
        at += c.len_utf16();
        if c == '\n' || c == '\r' {
            line_start = at;
        }
        i += 1;
    }
    out
}

fn starts_with_ci(chars: &[char], at: usize, word: &str) -> bool {
    let mut j = at;
    for w in word.chars() {
        match chars.get(j) {
            Some(c) if c.eq_ignore_ascii_case(&w) => j += 1,
            _ => return false,
        }
    }
    true
}

/// http or https URLs in text, as char ranges: the scheme and then everything up to whitespace, a quote, an angle
/// bracket, a BEL or an ESC.
fn urls_in(chars: &[char]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let scheme = if starts_with_ci(chars, i, "https://") {
            8
        } else if starts_with_ci(chars, i, "http://") {
            7
        } else {
            i += 1;
            continue;
        };
        let mut j = i + scheme;
        while j < chars.len() && !matches!(chars[j], '"' | '\'' | '`' | '<' | '>' | '\x07' | '\x1b') && !chars[j].is_whitespace() {
            j += 1;
        }
        if j == i + scheme {
            i += 1;
            continue;
        }
        found.push((i, j));
        i = j;
    }
    found
}

fn without_trailing_punctuation(url: &str) -> &str {
    url.trim_end_matches(['.', ',', ';', '!', '?', ')'])
}

/// Callback ports named by URLs that end before the text does: a URL still running at the end may be cut mid-port,
/// so it waits for the next chunk.
pub(crate) fn settled_callback_ports(text: &str, cols: Option<usize>) -> Vec<u16> {
    let clean: Vec<char> = clean_terminal_text(text, cols).chars().collect();
    let mut ports = Vec::new();
    for (start, end) in urls_in(&clean) {
        if end == clean.len() {
            continue;
        }
        let url: String = clean[start..end].iter().collect();
        if let Some(port) = callback_port_of(without_trailing_punctuation(&url)) {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

/// Callback ports named by URLs anywhere in a text.
#[cfg(test)]
pub(crate) fn callback_ports_in(text: &str, cols: Option<usize>) -> Vec<u16> {
    settled_callback_ports(&format!("{text} "), cols)
}

struct LocalUrl {
    end: usize,
    scheme: bool,
    localhost: bool,
    digits: String,
}

/// A local host and a port, with an optional scheme, not preceded by a character that would make it the tail of a
/// longer address and not followed by another digit.
fn local_urls_in(chars: &[char]) -> Vec<LocalUrl> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i > 0 && (chars[i - 1].is_ascii_alphanumeric() || matches!(chars[i - 1], '_' | '.' | '-' | '/' | '@' | ':' | '%')) {
            i += 1;
            continue;
        }
        let scheme = if starts_with_ci(chars, i, "https://") {
            Some(8)
        } else if starts_with_ci(chars, i, "http://") {
            Some(7)
        } else {
            None
        };
        let host_at = i + scheme.unwrap_or(0);
        let Some(host) = LOCAL_HOSTS.iter().find(|h| starts_with_ci(chars, host_at, h)) else {
            i += 1;
            continue;
        };
        let mut j = host_at + host.chars().count();
        if chars.get(j) != Some(&':') {
            i += 1;
            continue;
        }
        j += 1;
        let digits_at = j;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        let count = j - digits_at;
        if count == 0 || count > 5 {
            i += 1;
            continue;
        }
        found.push(LocalUrl {
            end: j,
            scheme: scheme.is_some(),
            localhost: host.eq_ignore_ascii_case("localhost"),
            digits: chars[digits_at..j].iter().collect(),
        });
        i = j;
    }
    found
}

/// Ports named by local URLs that end before the text does. Without a scheme only the numeric forms count, since
/// "localhost:5432" in an error line is a socket address, not a link a person clicks.
pub(crate) fn settled_local_ports(text: &str, cols: Option<usize>) -> Vec<u16> {
    let clean: Vec<char> = clean_terminal_text(text, cols).chars().collect();
    let mut ports = Vec::new();
    for m in local_urls_in(&clean) {
        if m.end == clean.len() || (!m.scheme && m.localhost) {
            continue;
        }
        if let Some(port) = m.digits.parse::<u32>().ok().and_then(valid_port) {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

/// Ports named by local URLs anywhere in a text.
#[cfg(test)]
pub(crate) fn localhost_ports_in(text: &str, cols: Option<usize>) -> Vec<u16> {
    settled_local_ports(&format!("{text} "), cols)
}

pub(crate) type Extract = fn(&str, Option<usize>) -> Vec<u16>;

/// Keeps the tail of a pty's output so a URL split across chunks still matches; the extractor decides which ports a
/// text names, and reads the pty's width at scan time so a wrapped typed line is joined.
pub(crate) struct TerminalUrlScanner {
    tail: String,
    extract: Extract,
}

impl TerminalUrlScanner {
    pub(crate) fn new(extract: Extract) -> TerminalUrlScanner {
        TerminalUrlScanner { tail: String::new(), extract }
    }

    /// Ports newly seen in this chunk, with the kept tail in front of it.
    pub(crate) fn feed(&mut self, chunk: &str, cols: Option<usize>) -> Vec<u16> {
        let text = format!("{}{chunk}", self.tail);
        let before = (self.extract)(&self.tail, cols);
        let keep = text.chars().count().saturating_sub(TAIL_CHARS);
        self.tail = text.chars().skip(keep).collect();
        (self.extract)(&text, cols).into_iter().filter(|p| !before.contains(p)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // URLs as the tools build them (measurement 2026-09-03); state and challenge values are placeholders.
    const WRANGLER: &str = "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
    // A flow whose redirect is a hosted page the person copies a code from: no callback port on the machine.
    const HOSTED_CALLBACK: &str = "https://accounts.example/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.example%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
    const MCP_REMOTE: &str = "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";

    const GH_DEVICE: &str = "https://github.com/login/device";

    fn callback(text: &str) -> Vec<u16> {
        callback_ports_in(text, None)
    }

    fn local(text: &str) -> Vec<u16> {
        localhost_ports_in(text, None)
    }

    #[test]
    fn strips_osc8_hyperlinks_so_a_linked_url_is_seen_once() {
        let linked = format!("\x1b]8;;{WRANGLER}\x1b\\{WRANGLER}\x1b]8;;\x1b\\");
        assert_eq!(clean_terminal_text(&linked, None), format!("{WRANGLER} {WRANGLER}"));
        assert_eq!(callback(&linked), [8976]);
        let bel = format!("\x1b]8;id=1;{WRANGLER}\x07{WRANGLER}\x1b]8;;\x07");
        assert_eq!(clean_terminal_text(&bel, None), format!("{WRANGLER} {WRANGLER}"));
        assert_eq!(callback(&bel), [8976]);
    }

    #[test]
    fn finds_callback_ports_in_printed_output_and_ignores_urls_without_one() {
        let out = format!("Visit this link to authenticate: {WRANGLER}\r\nIf the browser didn't open, visit: {HOSTED_CALLBACK}\r\nhttp://localhost:3000/ is your dev server.");
        assert_eq!(callback(&out), [8976]);
        assert!(callback("nothing here").is_empty());
    }

    #[test]
    fn strips_sgr_colour_and_bold_inside_a_url_and_joins_readlines_soft_wrap_before_matching() {
        assert_eq!(callback(&format!("Visit \x1b[36m{WRANGLER}\x1b[39m\n")), [8976]);
        assert_eq!(callback(&format!("{}\n", WRANGLER.replace("%3A8976", "%3A\x1b[1m8976\x1b[22m"))), [8976]);
        let head_len = WRANGLER.find("%3A8976").unwrap() + "%3A89".len();
        let head = &WRANGLER[..head_len];
        let wrapped = format!("{head} \r{}", &WRANGLER[head_len..]);
        assert_eq!(callback_ports_in(&format!("{wrapped}\n"), Some(head_len)), [8976]);
        assert!(callback_ports_in(&format!("{wrapped}\n"), Some(head_len + 1)).is_empty());
        // Without the width, or at another width, the carriage return is a redraw and the URL ends at the space.
        assert!(callback(&format!("{wrapped}\n")).is_empty());
        assert!(callback_ports_in(&format!("{wrapped}\n"), Some(80)).is_empty());
        // An OSC 8 hyperlink whose visible text is a word: the URL is in the parameter.
        assert_eq!(callback(&format!("\x1b]8;;{WRANGLER}\x07Open\x1b]8;;\x07\n")), [8976]);
    }

    #[test]
    fn matches_a_url_split_across_chunks_once_through_the_kept_tail() {
        let mut s = TerminalUrlScanner::new(settled_callback_ports);
        let cut = WRANGLER.find("redirect_uri").unwrap() + 20;
        assert!(s.feed(&format!("Visit: {}", &WRANGLER[..cut]), None).is_empty());
        assert_eq!(s.feed(&format!("{}\r\n", &WRANGLER[cut..]), None), [8976]);
        assert!(s.feed("Waiting for the callback...\r\n", None).is_empty());
    }

    #[test]
    fn a_chunk_ending_inside_the_port_digits_is_not_reported_until_the_url_is_complete() {
        for (url, up_to, port) in [(WRANGLER, "%3A8", 8976u16), (MCP_REMOTE, "%3A22", 22227)] {
            let mut s = TerminalUrlScanner::new(settled_callback_ports);
            let cut = url.find(up_to).unwrap() + up_to.len();
            assert!(s.feed(&format!("Visit: {}", &url[..cut]), None).is_empty());
            assert!(s.feed(&url[cut..], None).is_empty());
            assert_eq!(s.feed("\r\n", None), [port]);
            assert!(s.feed("\r\n", None).is_empty());
        }
    }

    #[test]
    fn localhost_port_of_a_url_a_tool_asked_to_open() {
        for (url, port) in [
            ("http://localhost:5173", 5173u16),
            ("http://localhost:5173/", 5173),
            ("http://localhost:8123/docs/index.html?x=1#top", 8123),
            ("http://127.0.0.1:8123", 8123),
            ("http://[::1]:8123/x", 8123),
            ("http://0.0.0.0:8123/", 8123),
            ("http://[::]:8123/", 8123),
            ("HTTP://LOCALHOST:3000/", 3000),
            ("http://localhost:1024", 1024),
            ("http://localhost:65535", 65535),
            ("https://localhost:8443/", 8443),
            ("https://127.0.0.1:3443/app", 3443),
        ] {
            assert_eq!(localhost_port_of(url), Some(port), "{url}");
        }
        for url in [
            "http://localhost/",
            "http://localhost:80/",
            "http://127.0.0.1:1023",
            "http://localhost:65536",
            "http://localhost:70000",
            "http://192.168.1.5:3000/",
            "http://example.com:8080/",
            "http://10.0.0.1:8123",
            "http://[::ffff:127.0.0.1]:8123/",
            "http://localhost.example:8123/",
            "http://%",
            "ftp://localhost:2121/",
            "",
        ] {
            assert_eq!(localhost_port_of(url), None, "{url}");
        }
    }

    #[test]
    fn callback_port_of_reads_the_redirect_uri_as_the_protocol_does() {
        assert_eq!(callback_port_of(WRANGLER), Some(8976));
        assert_eq!(callback_port_of(HOSTED_CALLBACK), None);
        assert_eq!(callback_port_of(MCP_REMOTE), Some(22227));
        assert_eq!(
            callback_port_of("http://localhost:54321/auth/v1/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb"),
            Some(3000)
        );
        assert_eq!(callback_port_of("https://x.test/a?redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback"), None);
        assert_eq!(callback_port_of("https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A631%2Fcb"), None);
        assert_eq!(callback_port_of("https://x.test/a?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8976%2Fcb"), Some(8976));
        assert_eq!(callback_port_of("https://x.test/a?redirect_uri=http%3A%2F%2Fexample.com%3A8976%2Fcb"), None);
        assert_eq!(callback_port_of("not a url"), None);
    }

    #[test]
    fn localhost_ports_in_text_a_pty_printed() {
        for (name, text, ports) in [
            ("python http.server on the wildcard", "Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...", vec![8123u16]),
            ("python 3.12 dual stack", "Serving HTTP on :: port 8123 (http://[::]:8123/) ...", vec![8123]),
            ("vite", "  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose", vec![5173]),
            ("next", "- Local:        http://localhost:3000", vec![3000]),
            ("bare 127.0.0.1", "listening on 127.0.0.1:8123", vec![8123]),
            ("bare [::1]", "listening on [::1]:8123", vec![8123]),
            ("with a path and a trailing period", "Open http://127.0.0.1:8123/admin/.", vec![8123]),
            ("in quotes and brackets", "url=\"http://localhost:4000/\" [http://localhost:4001]", vec![4000, 4001]),
            ("the same port twice is one", "http://localhost:8123/ and again http://localhost:8123/x", vec![8123]),
            ("OSC 8 hyperlink around it", "\x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07\n", vec![5173]),
            (
                "mixed with a sign-in URL that encodes its port",
                "https://dash.example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb and http://localhost:3000/",
                vec![3000],
            ),
            ("https on loopback", "  ➜  Local:   https://localhost:8443/", vec![8443]),
            (
                "vite's coloured line, bold port",
                "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n",
                vec![5173],
            ),
            ("a bold-wrapped URL", "Open \x1b[1mhttp://127.0.0.1:8123/\x1b[22m now\n", vec![8123]),
            ("a real CRLF after a URL is a line end, not a wrap", "curl http://localhost:6173 \r\n0/\n", vec![6173]),
            ("a progress redraw after a URL is not a wrap", "Local: http://localhost:1234 \r5% done\n", vec![1234]),
            ("an OSC 8 hyperlink whose text is not the URL", "\x1b]8;;http://localhost:5173/\x1b\\link\x1b]8;;\x1b\\\n", vec![5173]),
        ] {
            assert_eq!(local(text), ports, "{name}");
        }
    }

    #[test]
    fn readlines_soft_wrap_is_joined_only_where_the_line_before_it_is_exactly_the_pty_width() {
        let line = "bash-5.2$ curl http://localhost:6173";
        let cols = line.len();
        assert_eq!(localhost_ports_in(&format!("{line} \r0/\n"), Some(cols)), [61730]);
        assert_eq!(localhost_ports_in(&format!("{line} \r0/\n"), Some(cols + 1)), [6173]);
        assert_eq!(localhost_ports_in(&format!("{line} \r0/\n"), Some(cols - 1)), [6173]);
        assert_eq!(local(&format!("{line} \r0/\n")), [6173]);
        assert_eq!(localhost_ports_in("Local: http://localhost:1234 \r5% done\n", Some(80)), [1234]);
        // The width is the visible text: colour around the prompt does not count.
        assert_eq!(localhost_ports_in("\x1b[32mbash-5.2$\x1b[39m curl http://localhost:6173 \r0/\n", Some(cols)), [61730]);
        // Nor does a window title or a prompt mark, which a prompt emits under xterm.
        assert_eq!(localhost_ports_in(&format!("\x1b]0;root@wsp: ~\x07{line} \r0/\n"), Some(cols)), [61730]);
        assert_eq!(localhost_ports_in(&format!("\x1b]133;A\x1b\\{line} \r0/\n"), Some(cols)), [61730]);
        assert_eq!(localhost_ports_in(&format!("\x1b]2;title\x07{line} \r0/\n"), Some(cols)), [61730]);
        // Nor a CSI with private parameter bytes (what a TUI leaves on the line it exits to), a DCS or an APC.
        for esc in ["\x1b[>4;2m", "\x1b[>1u", "\x1b[=c", "\x1b[?2004h", "\x1bPq#0;2;0;0;0\x1b\\", "\x1b_Gf=100\x1b\\"] {
            assert_eq!(localhost_ports_in(&format!("{esc}{line} \r0/\n"), Some(cols)), [61730], "{esc:?}");
        }
        // Only the text since the last line break counts.
        assert_eq!(localhost_ports_in(&format!("some earlier line\n{line} \r0/\n"), Some(cols)), [61730]);
    }

    #[test]
    fn the_bytes_a_40_column_pty_under_bash_3_2_emitted_for_a_typed_url_verbatim() {
        let captured = "bash-5.2$ curl -sS http://localhost:6173 \r0/\n";
        assert_eq!(localhost_ports_in(captured, Some(40)), [61730]);
        assert_eq!(local(captured), [6173]);
    }

    #[test]
    fn the_bytes_a_40_column_pty_on_a_real_wsp_guest_emitted_for_the_same_url_verbatim() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/readline-wrap-guest.json");
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let text = |k: &str| fixture[k].as_str().unwrap().to_owned();
        let cols = fixture["cols"].as_u64().unwrap() as usize;
        let port = fixture["port"].as_u64().unwrap() as u16;
        assert!(text("bash").contains("GNU bash, version 5.2.15"));
        assert_eq!(text("term"), "xterm-256color");
        assert_eq!(text("sttySize"), "20 40");
        // Typed: readline wrapped after the 40th visible column with a space and a bare carriage return.
        assert_eq!(text("typed"), "curl -sS http://localhost:6173 \r0/");
        let typed = format!("{}{}\n", text("prompt"), text("typed"));
        assert_eq!(localhost_ports_in(&typed, Some(cols)), [port]);
        assert_eq!(localhost_ports_in(&typed, Some(cols - 1)), [6173]);
        // One write: readline echoed the whole line with no wrap at all on this guest.
        assert!(!text("oneWrite").contains('\r'));
        assert_eq!(localhost_ports_in(&format!("{}{}\n", text("prompt"), text("oneWrite")), Some(cols)), [port]);
    }

    #[test]
    fn ignores_what_is_not_a_local_url() {
        for (name, text) in [
            ("a bare localhost socket address in an error", "could not connect to server at localhost:5432"),
            ("a LAN host", "Network: http://192.168.1.5:5173/"),
            ("a public host", "Visit http://example.com:8080/"),
            ("no port", "Serving at http://localhost/"),
            ("below 1024", "http://localhost:80/ and 127.0.0.1:443"),
            ("out of range", "http://localhost:70000/ and 127.0.0.1:65536"),
            ("a mapped address", "::ffff:127.0.0.1:8123"),
            ("a longer dotted address", "10.127.0.0.1:8123"),
            ("a scheme-relative host", "//127.0.0.1:8123/"),
            ("a user info prefix", "http://user@127.0.0.1:8123/"),
            ("an encoded port", "localhost%3A8123"),
        ] {
            assert!(local(text).is_empty(), "{name}");
        }
    }

    #[test]
    fn a_url_that_ends_the_text_waits_its_port_may_be_cut() {
        assert!(settled_local_ports("Local: http://localhost:51", None).is_empty());
        assert!(settled_local_ports("Local: http://localhost:5173", None).is_empty());
        assert_eq!(settled_local_ports("Local: http://localhost:5173\n", None), [5173]);
        assert_eq!(local("Local: http://localhost:5173"), [5173]);
    }

    #[test]
    fn the_scanner_reads_the_pty_width_when_it_scans_so_a_resize_between_chunks_counts() {
        let mut s = TerminalUrlScanner::new(settled_local_ports);
        let line = "bash-5.2$ curl http://localhost:6173";
        assert_eq!(s.feed(&format!("{line} \r0/\n"), Some(line.len())), [61730]);
        assert_eq!(s.feed(&format!("{} \r0/\n", line.replace("6173", "7173")), Some(200)), [7173]);
    }

    #[test]
    fn matches_a_local_url_split_across_chunks_once_and_never_reports_a_cut_port() {
        let mut s = TerminalUrlScanner::new(settled_local_ports);
        assert!(s.feed("Serving HTTP on 0.0.0.0 port 8123 (http://0.0", None).is_empty());
        assert!(s.feed(".0.0:81", None).is_empty());
        assert_eq!(s.feed("23/) ...\n", None), [8123]);
        assert!(s.feed("Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...\n", None).is_empty());
        assert_eq!(s.feed("  Local: http://localhost:5173/\n", None), [5173]);
        // The cut lands after four digits of a five-digit port: 6173 is a port too, and not this one.
        assert!(s.feed("  Local: http://localhost:6173", None).is_empty());
        assert_eq!(s.feed("0/\n", None), [61730]);
    }

    #[test]
    fn a_non_loopback_host_in_the_same_stream_is_ignored() {
        let mut s = TerminalUrlScanner::new(settled_local_ports);
        assert_eq!(s.feed("  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/\n", None), [5173]);
        assert!(s.feed("  Network: http://10.0.0.7:4000/\n", None).is_empty());
    }
    #[test]
    fn callback_port_of_names_no_port_on_a_hosted_redirect_even_when_it_carries_one() {
        assert_eq!(callback_port_of(WRANGLER), Some(8976));
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=https%3A%2F%2Fplatform.example%3A8443%2Fcb"), None);
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=http%3A%2F%2Flocalhost%3A631%2Fcb"), None);
    }

    #[test]
    fn is_open_url_is_the_protocols_rule_with_the_parse_check_behind_it() {
        for url in [WRANGLER, GH_DEVICE, "HTTPS://X.TEST/A", "https://[::1]:8976/cb", "http://localhost:8123/"] {
            assert!(is_open_url(url), "{url}");
        }
        let long = format!("https://x.test/{}", "a".repeat(numbers::OPEN_URL_MAX));
        for url in [
            "https://%",
            "https://[::1",
            "https://exa%mple.com/x",
            "https://x.test/a b",
            "file:///etc/passwd",
            "http://",
            "http://:8080/",
            &long,
        ] {
            assert!(!is_open_url(url), "{url}");
        }
    }
}

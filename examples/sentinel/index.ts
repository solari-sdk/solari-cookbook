/**
 * Sentinel — a passive vendor security posture review that runs one Solari
 * browser and one Solari sandbox against a vendor's public surface.
 *
 * Public data only: everything it inspects is what any visitor or any DNS
 * resolver would already see. See README.md for the scope rules this example
 * holds itself to. The scan itself is not wired up yet, so this prints a stub.
 */

interface StubReport {
  domain: string
  scannedAt: string
  status: "stub"
  checks: string[]
}

// A DNS label starts and ends alphanumeric and is at most 63 characters, which
// is stricter than "letters, digits and hyphens". Spelling it out here is what
// refuses -acme.com and acme-.com, which a looser character class lets through.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
// The final label is a top level domain, so it is alphabetic. Allowing any label
// there would accept acme.123, the single letter acme.c and the quad-like
// 1.2.3.4.5, none of which are names anyone can actually resolve.
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,63}$`)
// Any scheme is stripped, not just http and https, so that ftp://acme.com and
// acme.com reach the same verdict rather than one failing the shape rule.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

function parseDomainArgument(raw: string | undefined): string {
  if (!raw) throw new Error("usage: npm start -- <domain>")
  const trimmed = raw.trim()
  if (trimmed.length > 300) {
    throw new Error("That input is too long to be a domain. Try example.com.")
  }
  // Credentials or whitespace survive the host extraction below, so an input
  // like "acme.com/a b" would otherwise be quietly trimmed down to acme.com.
  const withoutScheme = trimmed.replace(SCHEME, "")
  if (/[@\s]/.test(withoutScheme)) {
    throw new Error("Enter a bare domain with no credentials or spaces.")
  }
  // People paste whatever is in their address bar, so a full URL, a trailing
  // path, a query, a fragment, a port and a trailing dot are all accepted and
  // reduced to the host.
  const host = withoutScheme
    .toLowerCase()
    .replace(/[/?#].*$/, "")
    .replace(/:.*$/, "")
    .replace(/\.$/, "")
  if (!host || host.length > 253) {
    throw new Error(`"${raw}" does not look like a public domain. Try example.com.`)
  }
  // Refused rather than punycoded, so that one input has exactly one verdict.
  // The xn-- form passes the label rule unchanged.
  if ([...host].some((character) => character.charCodeAt(0) > 127)) {
    throw new Error(
      `"${host}" is an international domain. Enter its punycode form, for example xn--mnchen-3ya.de.`,
    )
  }
  // Checked ahead of the shape rule so an address is told it is an address.
  // Sentinel reviews a vendor's public domain surface, and pointing it at an
  // address is how you end up scanning something private.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new Error(`"${host}" is an IP address. Enter a domain name, for example acme.com.`)
  }
  if (!DOMAIN.test(host)) {
    throw new Error(`"${raw}" does not look like a public domain. Try example.com.`)
  }
  // Reserved and private names are refused because scanning them is neither
  // public nor meaningful, and this tool only ever looks at public data.
  if (/^(localhost|.*\.(local|internal|test|invalid|localhost|example|onion))$/.test(host)) {
    throw new Error(`"${host}" is a reserved or internal name and is out of scope.`)
  }
  return host
}

try {
  const domain = parseDomainArgument(process.argv[2])

  const report: StubReport = {
    domain,
    scannedAt: new Date().toISOString(),
    status: "stub",
    checks: [],
  }

  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  // A bad argument is a user error, not a crash, so it prints one line and
  // sets an exit code rather than unwinding a stack trace into the terminal.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

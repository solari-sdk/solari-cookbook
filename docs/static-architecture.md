# Static / no-hosting architecture

```text
+--------------------------- Browser origin ----------------------------+
|                                                                       |
|  Static analyst console                                               |
|  HTML + CSS + ES modules                                              |
|        |                    |                    |                     |
|        |                    |                    +--> Web Crypto       |
|        |                    |                         case encryption  |
|        |                    +--> IndexedDB / optional OPFS capability |
|        |                         cases, events, entities, evidence     |
|        |                                                             |
|        +--> Public CORS APIs                                          |
|        |      USGS now; additional adapters only when lawful/usable   |
|        |                                                             |
|        +--> Solari Browser / Sandbox / Desktop (future direct route)  |
|               only after browser/CORS support is verified             |
|               otherwise optional narrow credential broker            |
|                                                                       |
|  Service worker --> cached application shell for offline analysis     |
+-----------------------------------------------------------------------+

                         portable `.solari-case`
                                  |
                                  v
                    another browser / server mode
```

The static console and FastAPI deployment are separate runtime choices. Static mode has no application-server dependency. The long-term interoperability boundary is the normalized event/evidence semantics plus the versioned portable investigation format.

Direct Solari calls are intentionally shown as conditional/future routing; they are not claimed as browser-supported until provider behavior is verified.

import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { waitForHttp } from "../src/wait.js"

test("waits until a preview endpoint becomes healthy", async () => {
  let calls = 0
  const server = createServer((_req, res) => {
    calls += 1
    res.statusCode = calls < 3 ? 503 : 200
    res.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    await waitForHttp(`http://127.0.0.1:${address.port}`, 5, 5)
    assert.equal(calls, 3)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

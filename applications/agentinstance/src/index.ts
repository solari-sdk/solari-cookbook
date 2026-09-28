/**
 * agentinstance — file a task, close the laptop, get a pull request.
 *
 *   POST   /agents/<name>/tasks        {"repo": "owner/name", "goal": "...", "base"?: "branch"}
 *   GET    /agents/<name>              every task, newest last
 *   GET    /agents/<name>/tasks/<id>   one task, with the agent's output so far
 *   DELETE /agents/<name>/sandbox      kill the agent's sandbox now
 *
 * Every request needs `Authorization: Bearer $AGENT_TOKEN`: whoever can file
 * a task can spend your Solari, GitHub and Claude credentials.
 */
import type { Env } from "./agent.ts"

export { Agent } from "./agent.ts"

/** Constant-time compare, so the token can't be found a byte at a time. */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.AGENT_TOKEN) return new Response("AGENT_TOKEN is not set\n", { status: 500 })
    const auth = request.headers.get("authorization") ?? ""
    if (!sameToken(auth, `Bearer ${env.AGENT_TOKEN}`)) return new Response("unauthorized\n", { status: 401 })

    const [root, name, sub, id] = new URL(request.url).pathname.split("/").filter(Boolean)
    if (root !== "agents" || !name) return new Response("see src/index.ts for the routes\n", { status: 404 })
    const agent = env.AGENT.get(env.AGENT.idFromName(name))

    try {
      if (request.method === "POST" && sub === "tasks") {
        const body = (await request.json()) as { repo: string; goal: string; base?: string }
        return Response.json(await agent.file(name, body), { status: 202 })
      }
      if (request.method === "GET" && sub === "tasks" && id) {
        const task = await agent.get(id)
        return task ? Response.json(task) : new Response("no such task\n", { status: 404 })
      }
      if (request.method === "GET" && !sub) return Response.json({ agent: name, tasks: await agent.list() })
      if (request.method === "DELETE" && sub === "sandbox") return Response.json(await agent.releaseSandbox())
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 })
    }
    return new Response("see src/index.ts for the routes\n", { status: 404 })
  },
} satisfies ExportedHandler<Env>

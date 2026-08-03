/**
 * Test stub for https-proxy-agent.
 *
 * The real package ships ESM only, and Jest does not transform node_modules —
 * so any suite that transitively imports it (meet.test.ts → meet.ts →
 * api/methods.ts → proxy/toggle-proxy.ts) died at parse time with
 * "Cannot use import statement outside a module" before a single test ran.
 *
 * Nothing under test exercises proxying, so a constructor-shaped stand-in is
 * enough to keep the import graph loadable.
 */
export class HttpsProxyAgent {
  public readonly proxy: string

  constructor(proxy: string) {
    this.proxy = proxy
  }
}

export default HttpsProxyAgent

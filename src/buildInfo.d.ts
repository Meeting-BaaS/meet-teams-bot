// For buildInfo.json in server.ts
declare module "*.json" {
  const value: Record<string, unknown>
  export default value
}

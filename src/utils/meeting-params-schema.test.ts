const storageConfig = {
  endpoint: "https://storage.example.com",
  region: "us-east-1",
  access_key_id: "access-key",
  secret_access_key: "secret-key",
  artifacts_bucket: "artifacts",
  audio_chunks_bucket: "audio-chunks",
  logs_bucket: "logs"
}

describe("StorageConfigSchema", () => {
  const originalEnviron = process.env.ENVIRON

  afterEach(() => {
    process.env.ENVIRON = originalEnviron
    jest.resetModules()
  })

  const schemaFor = (environ: "local" | "preprod" | "prod") => {
    process.env.ENVIRON = environ
    jest.resetModules()
    return require("./meeting-params-schema").StorageConfigSchema
  }

  it("accepts HTTPS in prod", () => {
    expect(schemaFor("prod").safeParse(storageConfig).success).toBe(true)
  })

  it("rejects HTTP in prod", () => {
    expect(
      schemaFor("prod").safeParse({ ...storageConfig, endpoint: "http://storage.example.com" })
        .success
    ).toBe(false)
  })

  it("accepts HTTP outside prod", () => {
    expect(
      schemaFor("preprod").safeParse({ ...storageConfig, endpoint: "http://storage.example.com" })
        .success
    ).toBe(true)
  })

  it.each(["s3://storage.example.com", "file:///tmp/storage"])(
    "rejects unsupported endpoint %s",
    (endpoint) => {
      expect(schemaFor("local").safeParse({ ...storageConfig, endpoint }).success).toBe(false)
    }
  )

  it.each(["", ".", "..", "bucket/name", "bucket\\name"])(
    "rejects unsafe bucket name %s",
    (artifacts_bucket) => {
      expect(schemaFor("local").safeParse({ ...storageConfig, artifacts_bucket }).success).toBe(
        false
      )
    }
  )
})

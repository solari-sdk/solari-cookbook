# Optional S3-Compatible Artifact Storage

Server mode defaults to the local content-addressed artifact backend under `data/artifacts`. Deployments that need remote object storage can use `S3CompatibleArtifactBackend` from `app.artifacts` without changing the artifact manifest or integrity contract.

The backend stores bytes under:

`<prefix>/sha256/<first-two-hex>/<full-sha256>`

The application still verifies the SHA-256 digest after loading an artifact, so object storage does not become the source of truth for artifact identity.

## Credential boundary

The backend accepts an already configured S3-compatible client. It does not accept access-key or secret-key arguments and does not persist credentials in application records. Deployments should use the SDK/provider's normal environment, profile, workload-identity, or instance-role mechanism.

`app.artifacts.s3_backend_from_boto3(...)` is an optional convenience constructor when the deployment installs `boto3`. It accepts only bucket, prefix, endpoint URL, and region. Custom endpoints must use HTTPS except for loopback development, and endpoint URLs may not contain embedded credentials.

The core project does not require `boto3`; local/static demonstrations therefore do not acquire an unnecessary cloud dependency.

## S3-compatible services

The backend uses only `put_object` and `get_object` semantics and can be used with AWS S3 or compatible implementations that provide those operations through an SDK client. Endpoint/provider compatibility should be validated by the deployment operator before production use.

## Safety limits

The normal 50 MiB per-artifact application limit is applied before backend storage. Prefix traversal is rejected. Retrieved content is re-hashed before it is returned by `load_artifact`, and an integrity mismatch is a hard failure.

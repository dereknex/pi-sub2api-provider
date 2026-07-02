# Changelog

## 0.1.2

### Patch Changes

- 69c01fd: Fix quota update timeout crashing the pi agent.

  The sub2api usage endpoint could intermittently time out, surfacing as
  `DOMException [TimeoutError]: The operation was aborted due to timeout`
  followed by undici's `Aborted after 1 retry attempt`, which escaped as an
  unhandled promise rejection and crashed the pi session.

  - Add a `fetchWithRetry` wrapper with exponential backoff (up to 2 retries)
    that swallows the final network error and returns `null`, so a flaky
    endpoint never propagates to the extension top level.
  - Route `probeUsageEndpoint`, `updateQuota`, and `fetchModels` through it.
  - Wrap per-provider startup initialization in try/catch so one bad provider
    no longer blocks the others or aborts extension load.
  - Add `.catch()` to the fire-and-forget `updateQuota` calls in `model_select`
    and `turn_end`, and guard the subsequent `quotaProviders.get` against a
    concurrent clear, eliminating the unhandled rejection path entirely.

## 0.1.1

### Patch Changes

- e9b438a: Fix the incorrect context parameter configuration

## 0.1.0

### Minor Changes

- 7bd1d97: 完善为可发布的 pi package：补齐 npm 发布元信息、MIT LICENSE、GitHub Actions（check + changesets release）与发布文档。

本文件由 [Changesets](https://github.com/changesets/changesets) 在发布 PR 中自动更新。

首次发布前，版本说明记录在 `.changeset/initial-release.md`；合并 Changesets 生成的 release PR 后，这里会生成正式的版本条目。

---
"pi-sub2api-provider": patch
---

Fix quota update timeout crashing the pi agent.

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

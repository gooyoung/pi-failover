# Transparent Failover Retry Design

## Goal

When a provider attempt fails and `pi-failover` successfully selects another credential or provider, continue the same user request automatically. Intermediate provider errors must not appear in the transcript. If every configured option is exhausted, preserve and display the final real provider error.

## Scope

The behavior applies to every failure class already handled by `pi-failover`:

- `401` and `403` credential failures
- `429` credential rate limits
- `529` overloads
- `500`, `502`, `503`, and `504` provider failures
- recognized network and timeout failures

This design does not add new failure classifications, configuration fields, retry limits, or auth paths. Existing engine state continues to bound attempts by credential and provider availability.

## Chosen Approach

Use Pi's public extension continuation API.

After the failover engine selects and applies a new credential or provider, the `message_end` handler will:

1. consume the failed attempt so the same event cannot trigger a second switch;
2. replace the failed assistant message with an empty, non-error assistant message;
3. enqueue a hidden custom follow-up message through `pi.sendMessage()`;
4. let Pi continue the active agent run using the newly selected credential or provider.

The hidden custom message tells the agent to retry the current user request without mentioning the internal retry. It is not displayed to the user.

This approach is preferred over rewriting the error as a retryable status because it does not depend on Pi's internal error-text classifier. It is preferred over resending the user message because it preserves images, expanded prompts, and the existing conversation structure without creating a duplicate visible user entry.

## Runtime Flow

For a recoverable failure:

1. `before_provider_request` records the active provider and key slot.
2. `after_provider_response` records response status and `Retry-After`, when available.
3. `message_end` classifies the failure and clears the recorded attempt before executing failover.
4. The failover engine disables or cools the failed key/provider and selects the next candidate.
5. The runtime adapter applies the selected backup key or model/provider.
6. The extension emits exactly one redacted switch notification.
7. The extension replaces the intermediate assistant error with an empty non-error message and queues a hidden follow-up continuation.
8. Pi starts the next turn of the same agent run and sends the request with the selected credential/provider.

For exhaustion:

1. The engine reports `exhausted`.
2. Extension-owned runtime overrides are restored where required.
3. No continuation is queued.
4. The final assistant error is returned unchanged and remains visible.

For unrecognized or non-failover errors, the extension leaves the message unchanged and does not queue a continuation.

## State and Duplicate Prevention

The current attempt is consumed before asynchronous failover execution. A duplicate `message_end` event therefore cannot apply the same decision twice or emit duplicate switch notifications.

The failover engine remains responsible for disabled credentials, cooldowns, provider selection, and exhaustion. The extension does not introduce a separate retry counter. New `turn_start` events may reset per-turn visitation, while disabled and cooling state continues to prevent immediate reuse of a failed candidate.

## Message Handling

An intermediate failed assistant message is replaced by copying its required metadata and changing:

- `stopReason` to a successful terminal reason;
- `errorMessage` to `undefined`;
- `content` to an empty array.

The continuation is a custom message with `display: false`, delivered as a follow-up while the agent run is active. It contains no credential values or provider response body.

The original provider error is never copied into the continuation message, notifications, or logs.

## Error Handling

- If applying a backup key fails, the existing engine continues to the next provider. A continuation is queued only after a candidate is successfully applied.
- If no candidate can be applied, the attempt is exhausted and the real error remains visible.
- If the failure does not produce a switch decision, no continuation is queued and the message remains unchanged.
- Runtime cleanup and reload behavior remain unchanged.

## Tests

Extension-level regression tests will verify:

1. A `403 AccessDenied.Unpurchased` response applies the backup key, returns a hidden non-error replacement, and queues one hidden follow-up continuation.
2. A duplicated `message_end` for one attempt cannot apply the backup or notify twice.
3. A second failed attempt can continue walking to the next configured provider within the same user request.
4. Exhausting every credential/provider queues no continuation and preserves the final real error.
5. Retryable Pi errors such as `429` and `503` use the extension continuation path exactly once, preventing an extension-created duplicate continuation.
6. Continuation payloads, notifications, and status output contain no credentials or provider error bodies.

Existing engine, runtime adapter, model-planner, catalog, and lifecycle tests remain in place.

## Documentation

`README.md` and `README.zh-CN.md` will state that handled failures are retried transparently within the same user request. They will also state that only the final provider error is shown when all configured credentials and providers are exhausted.

`DEPLOY.md` requires review for release impact but does not need behavioral wording unless its existing release process becomes inaccurate.

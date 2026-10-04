# Resumable event delivery — issue #8

The separate WIT host is merged in PR #46. This change delivers post-commit
sequencer events without putting a plugin or delivery acknowledgement on the
PDS write path.

1. Add an opt-in Unix-socket range service under `service/pirs/`. Its parent
   directory must be private to the operator. Read persisted events in sequence
   order with fixed page count, byte and concurrent-request limits. Reject
   overload; leave unreturned events in the sequencer for a later request.
2. Add a separate host-side consumer that invokes the WIT runtime, then writes
   an atomic, synced cursor. Bind that cursor to a persistent stream identity.
   Retry transport failures; stop on plugin or cursor failures without skipping
   an event. Prevent simultaneous consumers sharing a cursor.
3. Qualify with a disposable PDS and loopback PLC: kill/restart the PDS and
   consumer mid-stream, check ordered coverage, exercise page and request
   overflow, reject public-listener access, and compare write latency while the
   consumer is stopped. Re-run the existing smoke and host adversarial gates.
4. Record local evidence in spec section 8 and a qualification record, commit,
   push, create/link a PR, and inspect actual hosted logs on its final head.

The cursor starts at zero for a new consumer. Delivery is at least once for
events retained by the upstream sequencer; deletion/invalidation and retention
are upstream boundaries. A crash between plugin success and durable cursor
storage can repeat that event. Plugins must tolerate duplicates. This work
does not add manifest grants, outbound networking, write rejection or deployment.

Local implementation and verification passed on October 4: 166 retained
sequences reached the WIT guest, sequence 156 replayed after a successful call
interrupted before cursor persistence, both delivery sides recovered from
SIGKILL, and all existing smoke and adversarial gates passed. Four focused
bridge checks and strict TypeScript checking passed. The updated sandbox
workflow repeats the process suite on pushes and PRs; final hosted results
will be linked from the delivery PR.

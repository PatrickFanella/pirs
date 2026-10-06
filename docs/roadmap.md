# Roadmap

Status: foundation demonstrations have run and the owner selected WIT components on 2026-10-03. The separate host passed adversarial checks, and retained PDS events passed local resumable delivery qualification on October 4. Section 8 of the spec and the qualification records describe the evidence. Tracking issue: [#37](https://git.subcult.tv/subculture-collective/pirs/issues/37).

Pirs aims to define how a PDS is extended and to prove it with a working distribution. The milestones follow the levels in the [hook-point spec](spec/hook-points.md): observe, serve, act, decide. M1 to M4 each end with a plugin that could not have been built at the level before.

Each issue is one demonstrable behaviour with its own acceptance criteria and verification. `ready-for-agent` means scoped for implementation once its blockers close. `needs-decision` means the owner has a choice to make. P0 gates its milestone, P1 completes it, P2 is later.

No dates are assigned. The first two milestones will show how fast this goes.

## Milestones

### M0 - Foundation

CI runs the smoke check, real account events are verified locally, the image builds, an upstream merge is rehearsed and the plugin interface is chosen.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#2](https://git.subcult.tv/subculture-collective/pirs/issues/2) Run the smoke check in Gitea CI | P0 | none |
| [#3](https://git.subcult.tv/subculture-collective/pirs/issues/3) Deliver commit and account events from a real local account | P0 | none |
| [#4](https://git.subcult.tv/subculture-collective/pirs/issues/4) Build and boot the Pirs container image | P0 | none |
| [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5) Rehearse an upstream release merge | P1 | [#2](https://git.subcult.tv/subculture-collective/pirs/issues/2) |
| [#6](https://git.subcult.tv/subculture-collective/pirs/issues/6) Choose the plugin interface with a measured spike | P0 | none |

### M1 - Observe

A sandboxed plugin in a separate host process receives PDS events with enforced limits. Exit demo: a commit webhook plugin.

The [commit webhook reference](qualification/commit-webhook.md) has source and
component checks. Its required successful local receiver demo conflicts with
#10's loopback/private destination prohibition and awaits an owner decision.
M1 has not passed its exit demonstration.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7) Run one plugin in a separate host process with enforced limits | P0 | [#6](https://git.subcult.tv/subculture-collective/pirs/issues/6) |
| [#8](https://git.subcult.tv/subculture-collective/pirs/issues/8) Deliver PDS events to the host with a resumable cursor | P0 | [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7), [#3](https://git.subcult.tv/subculture-collective/pirs/issues/3) |
| [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) Check a plugin manifest against its imports at install | P0 | [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7) |
| [#10](https://git.subcult.tv/subculture-collective/pirs/issues/10) Grant outbound requests only to allowed hosts | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#11](https://git.subcult.tv/subculture-collective/pirs/issues/11) Ship a commit webhook plugin | P0 | [#8](https://git.subcult.tv/subculture-collective/pirs/issues/8), [#10](https://git.subcult.tv/subculture-collective/pirs/issues/10) |
| [#12](https://git.subcult.tv/subculture-collective/pirs/issues/12) Run level 0 against an unmodified PDS | P1 | [#8](https://git.subcult.tv/subculture-collective/pirs/issues/8) |

### M2 - Serve

Plugins answer XRPC methods and HTTP routes and read public records and blobs. Exit demo: a static site hosting plugin.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#13](https://git.subcult.tv/subculture-collective/pirs/issues/13) Serve plugin XRPC methods through service proxying | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#14](https://git.subcult.tv/subculture-collective/pirs/issues/14) Serve plugin HTTP routes without sharing the PDS's origin | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#15](https://git.subcult.tv/subculture-collective/pirs/issues/15) Let plugins read public records and blobs | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#16](https://git.subcult.tv/subculture-collective/pirs/issues/16) Give each plugin quota-bound key-value storage | P1 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#17](https://git.subcult.tv/subculture-collective/pirs/issues/17) Ship a static site hosting plugin | P0 | [#14](https://git.subcult.tv/subculture-collective/pirs/issues/14), [#15](https://git.subcult.tv/subculture-collective/pirs/issues/15) |

### M3 - Act

An account holder grants a plugin scoped access and the plugin writes records for them under operator policy. Exit demo: an MCP server plugin.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#18](https://git.subcult.tv/subculture-collective/pirs/issues/18) Decide how an account holder grants a plugin access | P0 | [#13](https://git.subcult.tv/subculture-collective/pirs/issues/13) |
| [#19](https://git.subcult.tv/subculture-collective/pirs/issues/19) Write records for an account under a scoped grant | P0 | [#18](https://git.subcult.tv/subculture-collective/pirs/issues/18) |
| [#20](https://git.subcult.tv/subculture-collective/pirs/issues/20) Install, disable and remove plugins under operator policy | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#21](https://git.subcult.tv/subculture-collective/pirs/issues/21) Ship an MCP server plugin for an account's records | P0 | [#19](https://git.subcult.tv/subculture-collective/pirs/issues/19), [#14](https://git.subcult.tv/subculture-collective/pirs/issues/14) |

### M4 - Decide

A small tested patch set lets plugins reject requests before the PDS acts. Exit demo: a generic uniqueness rule replaces the hardcoded like, repost and follow dedup.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22) Carry a tested patch set against the PDS package | P0 | [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5) |
| [#23](https://git.subcult.tv/subculture-collective/pirs/issues/23) Accept or reject record writes through `record.validate` | P0 | [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22), [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7) |
| [#24](https://git.subcult.tv/subculture-collective/pirs/issues/24) Replace the hardcoded like, repost and follow dedup with `record.unique` | P0 | [#23](https://git.subcult.tv/subculture-collective/pirs/issues/23) |
| [#25](https://git.subcult.tv/subculture-collective/pirs/issues/25) Gate account creation through `account.create` | P1 | [#23](https://git.subcult.tv/subculture-collective/pirs/issues/23) |
| [#26](https://git.subcult.tv/subculture-collective/pirs/issues/26) Expose sign-in and authorisation checks as `auth.session` | P1 | [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22) |
| [#27](https://git.subcult.tv/subculture-collective/pirs/issues/27) Define ordering and failure rules for several deciding plugins | P0 | [#23](https://git.subcult.tv/subculture-collective/pirs/issues/23) |

### M5 - Standard

Spec draft 1 is published with a conformance suite, plugins are published as atproto records, and a second PDS implementation is tested.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#28](https://git.subcult.tv/subculture-collective/pirs/issues/28) Publish spec draft 1 from implementation evidence | P0 | [#12](https://git.subcult.tv/subculture-collective/pirs/issues/12), [#13](https://git.subcult.tv/subculture-collective/pirs/issues/13), [#18](https://git.subcult.tv/subculture-collective/pirs/issues/18), [#27](https://git.subcult.tv/subculture-collective/pirs/issues/27) |
| [#29](https://git.subcult.tv/subculture-collective/pirs/issues/29) Provide a conformance suite per level | P0 | [#28](https://git.subcult.tv/subculture-collective/pirs/issues/28) |
| [#30](https://git.subcult.tv/subculture-collective/pirs/issues/30) Publish and install plugins as atproto records compatible with EmDash's registry | P0 | [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9) |
| [#31](https://git.subcult.tv/subculture-collective/pirs/issues/31) Run levels 0 and 1 against a second PDS implementation | P1 | [#29](https://git.subcult.tv/subculture-collective/pirs/issues/29) |
| [#32](https://git.subcult.tv/subculture-collective/pirs/issues/32) Take the proposal to the community thread | P1 | [#28](https://git.subcult.tv/subculture-collective/pirs/issues/28) |
| [#33](https://git.subcult.tv/subculture-collective/pirs/issues/33) Cover Spaces in events and capabilities | P1 | [#28](https://git.subcult.tv/subculture-collective/pirs/issues/28) |

### M6 - Prichal runtime

The host is threat-modelled and reviewed, Pirs qualifies as an opt-in Prichal runtime, and the marketplace decision is made.

| Issue | Priority | Blocked by |
| --- | --- | --- |
| [#34](https://git.subcult.tv/subculture-collective/pirs/issues/34) Threat-model the host and review it before hosted use | P0 | [#20](https://git.subcult.tv/subculture-collective/pirs/issues/20), [#27](https://git.subcult.tv/subculture-collective/pirs/issues/27) |
| [#35](https://git.subcult.tv/subculture-collective/pirs/issues/35) Qualify Pirs as an opt-in Prichal runtime | P1 | [#34](https://git.subcult.tv/subculture-collective/pirs/issues/34), [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5) |
| [#36](https://git.subcult.tv/subculture-collective/pirs/issues/36) Decide whether to open a marketplace | P2 | [#30](https://git.subcult.tv/subculture-collective/pirs/issues/30), [#35](https://git.subcult.tv/subculture-collective/pirs/issues/35) |

## Order of work

The shortest path to a running plugin is [#6](https://git.subcult.tv/subculture-collective/pirs/issues/6), [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7), [#3](https://git.subcult.tv/subculture-collective/pirs/issues/3), [#8](https://git.subcult.tv/subculture-collective/pirs/issues/8), [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9), [#10](https://git.subcult.tv/subculture-collective/pirs/issues/10), [#11](https://git.subcult.tv/subculture-collective/pirs/issues/11). [#2](https://git.subcult.tv/subculture-collective/pirs/issues/2) and [#4](https://git.subcult.tv/subculture-collective/pirs/issues/4) have no blockers and can run alongside.

After [#9](https://git.subcult.tv/subculture-collective/pirs/issues/9), the serve issues ([#13](https://git.subcult.tv/subculture-collective/pirs/issues/13) to [#16](https://git.subcult.tv/subculture-collective/pirs/issues/16)), operator policy ([#20](https://git.subcult.tv/subculture-collective/pirs/issues/20)) and registry records ([#30](https://git.subcult.tv/subculture-collective/pirs/issues/30)) are independent of each other.

The patch track starts at [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5) and [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22) and does not depend on M2 or M3. Its first hook, [#23](https://git.subcult.tv/subculture-collective/pirs/issues/23), also needs the host from [#7](https://git.subcult.tv/subculture-collective/pirs/issues/7).

Milestone order is not a blocker by itself. Only the links in the tables are.

## Owner decisions

| Issue | Decision |
| --- | --- |
| [#6](https://git.subcult.tv/subculture-collective/pirs/issues/6) | WIT components selected on 2026-10-03 after the measured spike |
| [#18](https://git.subcult.tv/subculture-collective/pirs/issues/18) | Per-server or per-account installation, and the grant mechanism |
| [#28](https://git.subcult.tv/subculture-collective/pirs/issues/28) | Whether to make the repository public, and the licence for the spec text |
| [#32](https://git.subcult.tv/subculture-collective/pirs/issues/32) | The text posted to the community thread and the account it comes from |
| [#35](https://git.subcult.tv/subculture-collective/pirs/issues/35) | Whether Prichal offers Pirs as an opt-in runtime |
| [#36](https://git.subcult.tv/subculture-collective/pirs/issues/36) | Whether to open a marketplace |

## Risks

- **Upstream churn.** `@atproto/pds` released about 1.8 times a week between April and October 2026, and `context.ts`, which a patch set must touch, was its most-changed file. [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5) and [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22) measure the real cost before M4 commits to it.
- **Spaces.** Permissioned data is due for full launch late in 2026 and changes the PDS's storage and sync paths. [#33](https://git.subcult.tv/subculture-collective/pirs/issues/33) covers it; work before then should avoid assuming one repository per account.
- **No upstream signal.** Bluesky has not said it would accept hook points. The plan assumes Pirs carries its patches indefinitely.
- **Toolchain.** Nobody in the atproto ecosystem uses the WebAssembly component model yet. [#6](https://git.subcult.tv/subculture-collective/pirs/issues/6) decides on measurements, not preference.
- **A standard needs a second implementer.** [#31](https://git.subcult.tv/subculture-collective/pirs/issues/31) and [#32](https://git.subcult.tv/subculture-collective/pirs/issues/32) test whether anyone else can and will adopt the contract. If they fail, Pirs is a product feature, not a standard.

## Evidence

A milestone closes on demonstrations, not on merged code. Section 8 of the spec lists what has been run and is updated whenever a hook gains or loses evidence. Local runs do not prove behaviour on a public hostname, with real identities, or under hostile load.

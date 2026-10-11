# Repository planning

Gitea owns delivery outcomes, acceptance criteria, dependencies, and shared
status. Super Productivity owns personal work sessions and time tracking.

The [Active delivery board](https://git.subcult.tv/subculture-collective/-/projects/1)
contains selected current work across repositories. Keep future roadmap issues
in their repositories rather than adding every issue to this board.

Current pilot outcome: M1 Observe. The remaining #12 stock-PDS comparison follows the accepted local webhook evidence; later mutating hooks stay on their own milestones.

## Board rules

- Intake: selected work needing triage or an owner decision.
- Ready: result, acceptance criteria, owner, and prerequisites are clear.
- Doing: active execution confirmed by the worker. Limit two per worker.
- Review: implementation or qualification awaits acceptance. Record remaining gaps.
- Blocked: record the missing prerequisite, evidence, or decision and the next action.
- Done: acceptance criteria pass and the result is accepted.

Preserve existing area, priority, readiness, and status labels where tools use
them. Agent readiness describes who can act; it does not select the issue for
this week's delivery work.

## Milestones

Use milestones for outcomes or releases, not daily sessions. The current
milestone description records included work, exclusions, evidence, and its
exit gate. Close it only when the gate passes. Zero open issues prompts review;
it is not proof of deployment, qualification, or a release decision.

## Daily work in Super Productivity

Keep one intended automatic poller for each repository. Preserve providers
referenced by existing tasks. Redundant providers can remain available with
automatic polling and automatic import switched off.

For the pilot, issue import is manual. Backlog holds unselected roadmap tasks;
the project task list holds selected work. Choose one to three bounded work
sessions for Today and keep each Gitea issue link. Completion of a session may
leave the Gitea issue open. Verify provider completion behavior before relying
on automatic issue closure. Board moves and milestone changes are separate
Gitea operations unless a tested integration establishes otherwise.

## Weekly review

Review Ready, Doing, Review, and Blocked. Remove work no longer selected;
record blockers and next actions. Select work that fits the next one or two
weeks. Review milestone exit evidence and stale dependencies. Due dates
represent actual commitments. Add recurring automation only after the manual
pilot is useful.

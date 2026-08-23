# GitHub Project

Work planning lives in [LocalEmbed Project #4](https://github.com/users/gkissel/projects/4).
When an agent creates or updates an issue that belongs to the delivery plan, it
also adds or updates the corresponding Project item.

## Fields

- **Status**: `Todo`, `In Progress`, or `Done`.
- **Priority**: `P0 — Now`, `P1 — Next`, or `P2 — Later`.
- **Area**: `Foundation`, `Synchronization`, `API`, `Operations`,
  `Demonstration`, or `Evaluation`.
- **Effort**: `S`, `M`, or `L`.

Use the **Planning table** to inspect fields and the **Execution board** to work
by status. Add new work as `Todo`; set `In Progress` only when implementation
has actually begun.

## Blockers

Create native GitHub issue dependencies for blocking edges. Project fields are
for prioritization and visibility, not a duplicate blocker list.

## CLI

Use `gh project item-add 4 --owner gkissel --url <issue-url>` to add an issue.
Use `gh project item-edit 4 --owner gkissel --url <issue-url> --field <name>
--value <value>` to update a field. Check the result with `gh project item-list
4 --owner gkissel`.

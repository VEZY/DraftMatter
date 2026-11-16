# Manuscript history

## Browse before restoring

Open **History** and select a version. This displays a read-only preview without
replacing the working manuscript, creating a version, or deleting an older one.
You can move between saved versions and **Current manuscript** freely.

- **Preview** displays the saved manuscript text and formatting. Figures use
  placeholders; code and saved raw output are shown as inert text.
- **Changes** compares the selected version with the working manuscript. An
  edited paragraph is shown once with individual word additions and removals;
  unchanged surrounding text stays neutral. Entirely added or removed lines
  remain marked as complete changes. Very broad changes use a bounded fallback
  with a visible notice.
- **Source** displays the exact saved Markdown/Quarto source.
- **Back to current manuscript** closes the history window. The working text,
  selection and undo history have not been replaced by browsing.

Only **Restore this version** makes a selected version the working manuscript.
DraftMatter first preserves the current draft, keeps the selected original,
then records a distinct restored version. Other saved versions stay available.
Restoring does not truncate the timeline at the selected date or discard later
work. Apply or cancel pending source-editor edits before saving or restoring.

**Save version** always records the current working manuscript, even while an
older version is being previewed. Each explicit save is a new event with its own
identity and timestamp, including when its contents match an older version.
The preview does not jump to the new version automatically.

## Name and keep a version

Select any earlier version and choose **Name & keep version**. Enter a name such
as “Before co-author review”, then choose **Keep named version** or press Enter.
This creates a protected manual event containing that selected source and its
original date. It does not restore the old text or save the current draft in its
place. The original source remains unchanged. Named versions display a
**Named · kept** badge and survive automatic cleanup and reopening the project.

**Name current version** saves a named copy of the working manuscript. Ordinary
**Save version** remains a quick, unnamed manual save. Both are protected manual
checkpoints. Naming a version does not immediately delete intermediate versions.

## What is saved, and when?

This history stores complete copies of the manuscript source. It does not use
Git commits, branches or Git remotes. The comparison view is computed directly
from two saved texts without invoking Git.

Normal autosave and recoverable versions have different purposes:

| Mechanism | Trigger | Retention |
| --- | --- | --- |
| Working browser copy | About 380 ms after the latest edit | Current browser copy |
| Working desktop file | About 900 ms after the latest edit | Current file, saved atomically with external-change checks |
| Automatic recovery snapshot | About 1.8 seconds after editing pauses, or at most one minute of continuous pending edits; also certain open/save/conflict boundaries | Up to 100 unprotected automatic versions with recent and progressively spaced history; unchanged text creates no new version |
| Desktop safety backup | Before replacing a manuscript file; also the recovery deadline if continuous typing postpones the normal file save | Up to 100 unprotected automatic on-disk copies per manuscript |
| **Save version** | Explicit action | Kept as an immutable saved event |
| Restore safety copies | Explicit restoration | Previous draft, selected original and restored event kept separately |

The automatic recovery timer pauses while History is open. Merely selecting a
version does not save, restore or execute anything. Background autosave of edits
made before opening the window may still finish.

The timeline shows retained saved events and up to 100 unprotected automatic
snapshots. The latest eight automatic changes have priority. Older copies are
ranked by representatives from up to twelve active five-minute buckets,
twenty-four hourly buckets and fifty-six daily buckets; spare capacity keeps
additional detail. Buckets use fixed UTC boundaries. Days without edits do not
create versions, and simply reopening an inactive project does not expire its
history.

When automatic history reaches capacity, older intermediate copies strictly
between two manual checkpoints are the first group eligible for removal,
after protecting the latest eight. Within each group, temporal representatives
take priority over dense intermediate copies. Only automatic versions participate
in this cleanup. Manual saves, named versions, restore safety copies and selected
originals are outside the automatic count. Under browser byte/quota pressure,
the automatic count may be lower, using the same retention priorities.

An automatic snapshot used for a restoration or a named version is also kept.
Two explicit saved events remain distinct even if their source is identical.
Earlier scoped versions without a known kind are conservatively kept rather
than treated as disposable automatic snapshots.

## Storage and boundaries

Histories belong to a specific project and manuscript path. Two folders that
both contain `paper.md` do not share a history. Browser histories also include
the stable browser project identity. Collaboration identities include the
service, workspace, project and path.

On desktop, explicit versions are stored in the project's private
`.draftmatter/recovery/` archive, separately from rotating automatic backups.
The history list reads their metadata first; a selected version's source is
loaded and fingerprint-checked on demand. The archive supports 1,000 saved
events per manuscript and a 5 MiB source limit per event. At capacity, a new save
fails explicitly without deleting an old version. These are application limits,
not a promise of unlimited disk capacity.

In a browser, saved events share local storage with the working copy and other
project settings. Saved and restored events are not silently deleted to make
room. If they cannot fit, the save fails while retaining the existing history;
export a copy or use a desktop project for a durable archive. Browser data can
still be removed by clearing the browser profile.

This manuscript history is not a complete project backup: it does not version
the contents of separate images, bibliographies, datasets or environment files.
Keep independent project backups. Git can separately record deliberate project
milestones using the user's own Git tools.

Older global backups whose project/file identity cannot be verified remain
preserved separately. They are not guessed into the current manuscript's
timeline. Verified older on-disk backups for this manuscript remain browsable.

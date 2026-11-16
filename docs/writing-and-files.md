# Writing a paper and managing its files

You can write a complete paper in DraftMatter without running code. Write the
text, add citations, insert existing figures, edit tables, and preview equations
in the browser or the desktop app. Computation is an optional way to connect
figures, tables, and reported values to their analysis.

## Write, cite, and review

Place the cursor in the manuscript and choose **Cite** in the writing toolbar.
Search the project references or, on desktop with Zotero open, your local Zotero
library. Select the references and choose **Insert selected**. **⌘⇧C** on macOS
or **Ctrl+Shift+C** on Windows and Linux opens the same picker at the cursor.
**Insert → Citation** is another route to that picker.

The writing toolbar groups text style, bold, italic, links, citations and
insertions. It hides completely while idle. Hover or select **Writing tools** to
reveal it, then use the pin to keep it visible. Drag its handle to move it, or
choose **Position writing tools → Dock left / Dock right**. The pin and position
are remembered on this device. Touch and keyboard access keep the tools usable.

**Track changes** is in the main header. Its adjacent arrow opens **Changes
display**, including margin or inline changes and original/final previews.
Comments remain beside their text; select an anchor to open its conversation.

Use **Outline** on the left for the manuscript plan. Main sections are visible
by default; each arrow expands or collapses its subsections independently.
Searching reveals matching headings and their parent sections.

## Find text and recover a version

Press **⌘F** on macOS or **Ctrl+F** on Windows and Linux, or choose **Find in
document** on the left. Enter a phrase, then use **Enter / Shift+Enter** for the
next or previous match. The search includes the visible title and bibliography.
**Escape** closes it and returns to the manuscript without changing the text.

Choose **History** on the left to browse recovery versions for the current
manuscript only. Histories are identified by both project and manuscript path;
two projects containing `paper.md` have separate histories. On desktop, verified
on-disk backups for that same file are included. Older global backups without a
reliable project/file identity remain preserved separately and are not mixed in.
Selecting a version opens **Preview**, **Changes**, or **Source** in read-only
mode. It does not restore the version or change the working manuscript. Use
**Back to current manuscript** when finished, or explicitly choose **Restore this
version** to use it. Restoration preserves both the current draft and selected
original, and records a distinct restored version.

**Save version** adds a new saved event for the current working manuscript,
including when its contents match an older version. Saved events are kept;
recent automatic safety copies rotate separately. A full archive fails visibly
rather than deleting a saved version. The project menu also keeps **Recovery
history**. These versions are separate from Git commits and shared collaboration
checkpoints. See [Manuscript history](manuscript-history.md) for the exact timing,
retention and project-backup boundaries.

## Add figures, tables, and equations

- Choose **Insert → Figure** and pick an image, or drop an image directly into
  the manuscript. Add an accessible description and an optional caption. PNG,
  JPEG, SVG, GIF, and WebP images are supported, up to 2 MB each.
- Choose **Insert → Table** to add rows and columns, then edit the cells in the
  manuscript.
- Choose **Insert → Equation** and type the equation. Its preview updates as
  you type; inline and display equations are supported.
- Use **Cross-reference** to refer to a figure, table, equation, or section.
  Numbering follows the manuscript when you reorder its contents.

Imported images receive a stable filename in `figures/`. DraftMatter does not
rename the image to match its current figure number. Figure numbers appear
with the figures in the manuscript; the file tree keeps their stable names.

## Know where the files live

Choose **Files** on the left to browse folders without leaving the paper.
Select a file to see its available actions: open another manuscript, insert an
image, or download a copy when it lives online or only in this browser. Files
already in a local desktop project do not offer a redundant download. The
current manuscript is marked in the tree. Search
finds files inside closed folders. **Outline** switches the same pane back to
the manuscript plan.

| Workspace | Where a newly imported image is saved |
| --- | --- |
| Local desktop project | In the project's `figures/` folder on this computer. |
| Browser draft | In this browser, alongside the browser's saved draft. |
| Shared online paper | With the shared manuscript, so collaborators can see it. A connected desktop project also keeps its local copy. |

The Files view distinguishes local and online copies. The existence of both
copies does not establish that their contents match. Git is optional and separate from online sharing. Set it up with your preferred
Git client, IDE, or command line. DraftMatter does not inspect or manage your
repository, create commits, or contact Git remotes. Local recovery history remains
available without Git.

## Synchronize a selected part of a local project

Connect a local desktop project to its collaboration server, then open
**Files → Sharing & transfers**. The **Selective synchronization** panel follows the manuscript, figures, and
references by default. Select additional files individually. Explicit exclusions
are remembered, including for default files. New default files are discovered
when the project is compared again.

Synchronization runs while the linked project is open and connected, approximately
every ten seconds and when the window regains focus. **Sync now** starts a check
immediately. **Pause** or unselecting a file stops after the current file; choices
are kept for the next opening. This is not a separate background drive service.

Each path has a last common local fingerprint and online version. If only one
side changed, the other side is updated using a revision guard. If both changed,
that file pauses and the Files icon signals that attention is needed. Other
selected files can continue.

- **Compare copies** shows local and online text or supported image previews
  side by side without changing either copy. If a copy changes, compare again
  before applying a choice.
- **Keep local** preserves the online copy before publishing the local version.
- **Use online** preserves the local copy before downloading the online version.
- **Keep both** saves the local version as a separate conflict file, locally and
  online, and uses the online version at the original path.

Conflict copies have `.conflict-local-…` or `.conflict-online-…` in their names.
A choice is refused if either copy changed after the conflict was displayed.
An explicit project checkpoint cannot bypass unresolved synchronization problems;
resolve them in Files before writing that checkpoint.
Deleted or missing files require an explicit recovery or an exclusion; deletions
are never propagated automatically. Read-only collaborators can receive updates;
publishing and conflict resolutions that archive copies online need editing access.

This first sync implementation transfers up to **32 MiB per file**. Larger files
can still use the existing manual upload/download controls within the service's
quota. Private metadata, credential files, dependency installations, symlinks,
and paths outside the project are excluded. Synchronization never runs code.

The browser continues to edit the live manuscript and display shared figures and
references. The manuscript's live collaboration state remains authoritative;
DraftMatter does not maintain a competing manuscript in file storage. Ordinary
selected files use immutable server versions and guarded current-version heads.
An older server without these heads reports an upgrade requirement and does not
silently start synchronization.

Git remains an external, optional tool. DraftMatter does not initialize or probe
a repository, and its history icon opens local recovery snapshots. Existing
repositories stay intact; configure and use Git from your preferred tools.

## Share the paper, then choose any additional data

While collaborating, manuscript edits, inserted figures, and reference metadata
are shared with the paper. Other files, including analysis datasets, stay local
until you explicitly select them for synchronization or upload a version. You do not need to put a dataset online just
to insert a finished figure.

To share additional files, open **Files → Sharing & transfers → Shared data files**. Owners and editors
can choose a file and upload a version; collaborators with access can download
shared versions. These transfers are separate from inserting a figure and can
be paused and resumed. Uploading data makes a version available for download. A desktop collaborator
receives it automatically only if that path is followed in their local project.
Data transfer does not start an analysis.

Inserted images have a 2 MB per-image limit. Online figures and references share
an 8 MB total resource limit, measured after image encoding and including
reference metadata. This leaves less than 8 MB for the original image files.
Larger datasets belong in **Shared data files**, which uses separate storage.

## Take the complete example to desktop

In the browser example, **Download a copy** downloads a project ZIP containing
the manuscript, references, example datasets, saved figures, and project
settings. Extract the ZIP, open DraftMatter Desktop, and choose **Open project
folder** to open the extracted folder.

On desktop, **Make project copy** offers a normal saved folder or a temporary
working copy. Copying never runs code. The temporary option can be removed by
the operating system later, so choose a saved folder for work you want to keep.

Project copies of other browser papers include the manuscript and the figures
and references available to that paper. Separately shared data files are
downloaded through **Shared data files**; a project copy is not a backup of
every collaborator's files.

## Use computation when it helps

The **Code & computation** panel separates language environments from manuscript
calculations. **Installed only** means a runtime was found; **Kernel detected**
means an available execution connection was found and will be checked again
when you run a calculation.

A **shared setup** cell is optional. It holds imports, reusable functions or
shared data and runs before that language’s calculations in a fresh session.
A standalone calculation can run without a shared setup cell.

Use **Insert → Computed value** to put a named result inside a sentence. If it
needs a new calculation, choose **Create a calculation…** there. Calculations
and their source appear in Code & computation. **Reproducible figure** and
**Reproducible table** are also directly visible in Insert, under the
**Reproducibility** heading. Creating a calculation saves its source; use its
**Run** action when you want to execute it.


Python, R, and Julia run from an explicitly trusted local desktop project. On
the first **Run**, DraftMatter offers the required language setup, then
continues the computation you requested. Python can be acquired for the
project; R and Julia must already be installed. You can also choose **Prepare
environments** in **Code & computation** without running manuscript code.

The browser can inspect computation source and display saved results. It does
not edit or execute code, and the collaboration server does not run manuscript
code. A collaborator can refresh a result on desktop and share the updated
figure or value for others to read online.

Existing generated figures, tables, and named values, including supported MIME
output embeds, remain supported. Image insertion adds a simpler route for
figures made in another tool. Source code stays with the project; clean
publication exports show the saved results.

## Existing Git users

The old built-in Git workspace has been removed from normal project navigation.
The project menu’s **Recovery history** opens DraftMatter's local recovery journal. Existing `.git`
folders, commits, branches, configuration, and remotes are left untouched. Continue
using them through your own Git tools; no migration or repository setup is needed
to keep writing in DraftMatter.

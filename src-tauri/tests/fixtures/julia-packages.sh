#!/bin/sh
project=""
for argument in "$@"; do
  case "$argument" in --project=*) project="${argument#--project=}" ;; esac
done
[ "$project" = "." ] || { printf 'ERROR: Julia was not started with --project=.\n' >&2; exit 23; }
project_environment=$(cd "$JULIA_PROJECT" && pwd -P)
working_project=$(pwd -P)
[ "$project_environment" = "$working_project" ] || { printf 'ERROR: JULIA_PROJECT did not point to the working project.\n' >&2; exit 24; }
case "$*" in
  *dependency.is_stdlib*) printf 'ERROR: package inventory used the removed PackageInfo.is_stdlib field.\n' >&2; exit 25 ;;
esac
case "$*" in
  *DRAFTMATTER_ADD_PACKAGE*)
    touch "$project/Project.toml" "$project/Manifest.toml"
    printf 'DRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\nDRAFTMATTER_PACKAGE\tJuliaFormatter\t2.2.0\tpackage\n'
    ;;
  *DRAFTMATTER_REMOVE_PACKAGE*)
    printf 'DRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\n'
    ;;
  *DRAFTMATTER_LIST_PACKAGES*)
    touch "$project/Project.toml" "$project/Manifest.toml"
    printf 'DRAFTMATTER_PACKAGE\tStatistics\t1.11.0\tstdlib\nDRAFTMATTER_PACKAGE\tDataFrames\t1.7.0\tpackage\n'
    ;;
  *DRAFTMATTER_FORMAT_JULIA*)
    printf 'x = 1\n'
    ;;
esac

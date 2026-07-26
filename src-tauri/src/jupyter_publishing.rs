use crate::runtime::RuntimeLanguage;

#[cfg(test)]
pub(crate) const PUBLISHED_VALUE_MIME: &str = "application/vnd.draftmatter.published-value+json";

const PYTHON_HELPER: &str = r#"
from IPython.display import publish_display_data as _draftmatter_display_data
import math as _draftmatter_math

def publish(name, value, *, unit=None, digits=None):
    """Publish one scalar for use as {{name}} in DraftMatter manuscript text."""
    if not isinstance(name, str) or len(name) > 128 or name.startswith("dm:") or not name or not ("A" <= name[0] <= "Z" or "a" <= name[0] <= "z") or any(not (character.isascii() and (character.isalnum() or character in "_.:-")) for character in name):
        raise ValueError("Published value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.")
    if isinstance(value, bool):
        scalar = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not _draftmatter_math.isfinite(value):
            raise TypeError("publish() accepts only finite numeric values.")
        scalar = value
    elif isinstance(value, str):
        scalar = value
    else:
        try:
            scalar = value.item()
        except (AttributeError, ValueError):
            raise TypeError("publish() accepts one finite number, text value, or boolean; summarize arrays and tables first.") from None
        if not isinstance(scalar, (str, int, float, bool)) or (isinstance(scalar, float) and not _draftmatter_math.isfinite(scalar)):
            raise TypeError("publish() accepts one finite number, text value, or boolean; summarize arrays and tables first.")
    if unit is not None and not isinstance(unit, str):
        raise TypeError("publish() unit must be text.")
    if digits is not None and (not isinstance(digits, int) or isinstance(digits, bool) or not 0 <= digits <= 15):
        raise ValueError("publish() digits must be a whole number from 0 to 15.")
    payload = {"version": 1, "name": name, "value": scalar, "formatting": {}}
    if unit:
        payload["unit"] = unit
    if digits is not None:
        payload["formatting"]["digits"] = digits
    _draftmatter_display_data(data={"application/vnd.draftmatter.published-value+json": payload}, metadata={})
    return value
"#;

const R_HELPER: &str = r#"
publish <- function(name, value, unit = NULL, digits = NULL) {
  if (!is.character(name) || length(name) != 1L || is.na(name) || startsWith(name, "dm:") || !grepl("^[A-Za-z][A-Za-z0-9_.:-]{0,127}$", name)) {
    stop("Published value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.", call. = FALSE)
  }
  if (length(value) != 1L || is.list(value) || is.factor(value) || is.na(value) || !(is.numeric(value) || is.character(value) || is.logical(value))) {
    stop("publish() accepts one finite number, text value, or boolean; summarize vectors, tables, and models first.", call. = FALSE)
  }
  if (is.numeric(value) && !is.finite(value)) stop("publish() accepts only finite numeric values.", call. = FALSE)
  if (!is.null(unit) && (!is.character(unit) || length(unit) != 1L || is.na(unit))) stop("publish() unit must be text.", call. = FALSE)
  if (!is.null(digits) && (!is.numeric(digits) || length(digits) != 1L || is.na(digits) || digits %% 1 != 0 || digits < 0 || digits > 15)) {
    stop("publish() digits must be a whole number from 0 to 15.", call. = FALSE)
  }
  payload <- list(version = 1L, name = name, value = unname(value), formatting = list())
  if (!is.null(unit) && nzchar(unit)) payload$unit <- unit
  if (!is.null(digits)) payload$formatting$digits <- as.integer(digits)
  encoded <- jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null", digits = NA)
  bundle <- list(encoded)
  names(bundle) <- "application/vnd.draftmatter.published-value+json"
  empty_metadata <- structure(list(), names = character())
  IRdisplay::publish_mimebundle(bundle, metadata = empty_metadata)
  invisible(value)
}
"#;

const JULIA_HELPER: &str = r#"
const _DRAFTMATTER_PUBLISHED_VALUE_MIME = MIME"application/vnd.draftmatter.published-value+json"()

struct _DraftMatterPublishedValue
    payload::String
end

Base.show(io::IO, ::MIME"application/vnd.draftmatter.published-value+json", value::_DraftMatterPublishedValue) = print(io, value.payload)
Base.show(io::IO, ::MIME"text/plain", ::_DraftMatterPublishedValue) = nothing

IJulia.register_jsonmime(_DRAFTMATTER_PUBLISHED_VALUE_MIME)

_draftmatter_json_string(value) = "\"" * replace(String(value), "\\" => "\\\\", "\"" => "\\\"", "\n" => "\\n", "\r" => "\\r", "\t" => "\\t") * "\""

function _draftmatter_scalar_json(value)
    value isa Bool && return value ? "true" : "false"
    value isa AbstractString && return _draftmatter_json_string(value)
    if value isa Real
        isfinite(value) || throw(ArgumentError("publish accepts only finite numeric values."))
        return string(value)
    end
    throw(ArgumentError("publish accepts one finite number, text value, or boolean; summarize arrays, tables, and models first."))
end

function _draftmatter_publish(name::AbstractString, value; unit=nothing, digits=nothing)
    !startswith(name, "dm:") && occursin(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$", name) || throw(ArgumentError("Published value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens."))
    unit === nothing || unit isa AbstractString || throw(ArgumentError("publish unit must be text."))
    digits === nothing || (digits isa Integer && 0 <= digits <= 15) || throw(ArgumentError("publish digits must be a whole number from 0 to 15."))
    formatting = digits === nothing ? "{}" : "{\"digits\":" * string(digits) * "}"
    unit_field = unit === nothing || isempty(unit) ? "" : ",\"unit\":" * _draftmatter_json_string(unit)
    payload = "{\"version\":1,\"name\":" * _draftmatter_json_string(name) * ",\"value\":" * _draftmatter_scalar_json(value) * unit_field * ",\"formatting\":" * formatting * "}"
    display(_DraftMatterPublishedValue(payload))
    return value
end

publish(name::AbstractString, value; unit=nothing, digits=nothing) = _draftmatter_publish(name, value; unit, digits)

macro publish(variable, options...)
    variable isa Symbol || error("@publish expects a variable name, for example @publish mean_height unit=\"cm\" digits=1")
    keywords = Expr[]
    for option in options
        option isa Expr && option.head == :(=) && option.args[1] in (:unit, :digits) || error("@publish supports only unit= and digits= options")
        push!(keywords, Expr(:kw, option.args[1], option.args[2]))
    end
    esc(Expr(:call, :_draftmatter_publish, Expr(:parameters, keywords...), String(variable), variable))
end
"#;

pub(crate) fn publishing_helper(language: RuntimeLanguage) -> &'static str {
    match language {
        RuntimeLanguage::Python => PYTHON_HELPER,
        RuntimeLanguage::R => R_HELPER,
        RuntimeLanguage::Julia => JULIA_HELPER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_publishes_only_the_private_mime_contract() {
        for language in [
            RuntimeLanguage::Python,
            RuntimeLanguage::R,
            RuntimeLanguage::Julia,
        ] {
            let helper = publishing_helper(language);
            assert!(helper.contains(PUBLISHED_VALUE_MIME));
            assert!(helper.contains("dm:"));
        }
        assert!(publishing_helper(RuntimeLanguage::Python).contains("def publish"));
        assert!(publishing_helper(RuntimeLanguage::R).contains("publish <- function"));
        assert!(publishing_helper(RuntimeLanguage::R)
            .contains("structure(list(), names = character())"));
        assert!(publishing_helper(RuntimeLanguage::Julia)
            .contains("publish(name::AbstractString, value;"));
        assert!(publishing_helper(RuntimeLanguage::Julia).contains("macro publish"));
        assert!(publishing_helper(RuntimeLanguage::Julia)
            .contains("IJulia.register_jsonmime(_DRAFTMATTER_PUBLISHED_VALUE_MIME)"));
    }
}

import json
import os
import queue
import socketserver
import sys
import threading
import traceback
import uuid


PUBLISHED_VALUE_MIME = "application/vnd.draftmatter.published-value+json"


PYTHON_PUBLISH_HELPER = r'''
from IPython.display import publish_display_data as _draftmatter_display_data
import math as _draftmatter_math

def publish(name, value, *, unit=None, digits=None):
    """Publish one scalar for use as {{name}} in DraftMatter manuscript text."""
    if not isinstance(name, str) or not name or not name[0].isalpha() or any(not (character.isalnum() or character in "_.:-") for character in name):
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
'''


R_PUBLISH_HELPER = r'''
publish <- function(name, value, unit = NULL, digits = NULL) {
  if (!is.character(name) || length(name) != 1L || is.na(name) || !grepl("^[A-Za-z][A-Za-z0-9_.:-]{0,127}$", name)) {
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
  IRdisplay::publish_mimebundle(bundle, metadata = list())
  invisible(value)
}
'''


JULIA_PUBLISH_HELPER = r'''
struct _DraftMatterPublishedValue
    payload::String
end

Base.show(io::IO, ::MIME"application/vnd.draftmatter.published-value+json", value::_DraftMatterPublishedValue) = print(io, value.payload)
Base.show(io::IO, ::MIME"text/plain", ::_DraftMatterPublishedValue) = nothing

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
    occursin(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$", name) || throw(ArgumentError("Published value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens."))
    unit === nothing || unit isa AbstractString || throw(ArgumentError("publish unit must be text."))
    digits === nothing || (digits isa Integer && 0 <= digits <= 15) || throw(ArgumentError("publish digits must be a whole number from 0 to 15."))
    formatting = digits === nothing ? "{}" : "{\"digits\":" * string(digits) * "}"
    unit_field = unit === nothing || isempty(unit) ? "" : ",\"unit\":" * _draftmatter_json_string(unit)
    payload = "{\"version\":1,\"name\":" * _draftmatter_json_string(name) * ",\"value\":" * _draftmatter_scalar_json(value) * unit_field * ",\"formatting\":" * formatting * "}"
    display(_DraftMatterPublishedValue(payload))
    return value
end

macro publish(variable, options...)
    variable isa Symbol || error("@publish expects a variable name, for example @publish mean_height unit=\"cm\" digits=1")
    keywords = Expr[]
    for option in options
        option isa Expr && option.head == :(=) && option.args[1] in (:unit, :digits) || error("@publish supports only unit= and digits= options")
        push!(keywords, Expr(:kw, option.args[1], option.args[2]))
    end
    esc(Expr(:call, :_draftmatter_publish, Expr(:parameters, keywords...), String(variable), variable))
end
'''


def publishing_helper(language):
    normalized = str(language or "").lower()
    if normalized in ("python", "python3"):
        return PYTHON_PUBLISH_HELPER
    if normalized == "r":
        return R_PUBLISH_HELPER
    if normalized == "julia":
        return JULIA_PUBLISH_HELPER
    raise RuntimeError("DraftMatter cannot inject publishing helpers into this kernel language.")


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def json_safe(value):
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(key): json_safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [json_safe(item) for item in value]
        return str(value)


try:
    from jupyter_client import KernelManager

    kernel_name = sys.argv[1]
    working_directory = sys.argv[2]
    secret = sys.argv[3]
    project_environment = sys.argv[4] if len(sys.argv) > 4 else ""
    kernel_process_environment = os.environ.copy()
    if project_environment:
        kernel_process_environment["JULIA_PROJECT"] = project_environment
    manager = KernelManager(kernel_name=kernel_name)
    manager.start_kernel(cwd=working_directory, env=kernel_process_environment)
    jobs = queue.Queue()
    startup = queue.Queue(maxsize=1)
    activity_lock = threading.Lock()

    def kernel_environment(client):
        message_id = client.kernel_info()
        while True:
            reply = client.get_shell_msg(timeout=10)
            if reply.get("parent_header", {}).get("msg_id") == message_id:
                content = reply.get("content", {})
                language = content.get("language_info", {})
                details = {
                    "mode": "interactive-kernel",
                    "kernel": kernel_name,
                    "implementation": str(content.get("implementation") or "jupyter"),
                    "language": str(language.get("name") or ""),
                }
                if project_environment:
                    details["project"] = project_environment
                return {
                    "identity": kernel_name,
                    "version": str(language.get("version") or content.get("implementation_version") or ""),
                    "details": details,
                }

    def execute(client, code, environment, store_history=True):
        message_id = client.execute(code, allow_stdin=False, stop_on_error=False, store_history=store_history)
        messages = []
        sequence = 0
        execution_count = None
        clear_on_next = False
        while True:
            try:
                message = client.get_iopub_msg(timeout=300)
            except queue.Empty:
                return {"ok": False, "error": "The kernel did not become idle within five minutes."}
            if message.get("parent_header", {}).get("msg_id") != message_id:
                continue
            kind = message.get("header", {}).get("msg_type")
            content = message.get("content", {})
            if kind == "status" and content.get("execution_state") == "idle":
                break
            if kind == "clear_output":
                if content.get("wait"):
                    clear_on_next = True
                else:
                    messages = []
                continue
            if clear_on_next and kind in ("stream", "display_data", "execute_result", "error"):
                messages = []
                clear_on_next = False
            if kind == "stream":
                name = content.get("name")
                messages.append({
                    "kind": "stream",
                    "sequence": sequence,
                    "name": "stderr" if name == "stderr" else "stdout",
                    "text": str(content.get("text") or ""),
                })
                sequence += 1
            elif kind in ("display_data", "execute_result", "update_display_data"):
                messages.append({
                    "kind": "display",
                    "sequence": sequence,
                    "data": json_safe(content.get("data") or {}),
                    "metadata": json_safe(content.get("metadata") or {}),
                })
                execution_count = content.get("execution_count", execution_count)
                sequence += 1
            elif kind == "error":
                messages.append({
                    "kind": "error",
                    "sequence": sequence,
                    "name": str(content.get("ename") or "KernelError"),
                    "message": str(content.get("evalue") or "The kernel reported an error."),
                    "traceback": [str(line) for line in content.get("traceback") or []],
                })
                sequence += 1
            elif kind == "execute_input":
                execution_count = content.get("execution_count", execution_count)

        reply = None
        while True:
            candidate = client.get_shell_msg(timeout=20)
            if candidate.get("parent_header", {}).get("msg_id") == message_id:
                reply = candidate
                break
        content = (reply or {}).get("content", {})
        status = content.get("status") or ("error" if any(item["kind"] == "error" for item in messages) else "ok")
        execution_count = content.get("execution_count", execution_count)
        return {
            "ok": True,
            "status": "error" if status == "error" else "ok",
            "messages": messages,
            "executionCount": execution_count,
            "kernelRunId": "kernel:" + kernel_name + ":" + message_id,
            "environment": environment,
        }

    def inject_publishing_helper(client, environment):
        language = environment.get("details", {}).get("language")
        response = execute(client, publishing_helper(language), environment, store_history=False)
        if not response.get("ok") or response.get("status") != "ok":
            errors = [message.get("message") for message in response.get("messages", []) if message.get("kind") == "error"]
            raise RuntimeError("Could not inject DraftMatter's publishing helper into the kernel: " + (errors[0] if errors else "unknown kernel error"))

    def kernel_worker():
        client = None
        session_generation = 1
        execution_sequence = 0
        try:
            client = manager.client()
            client.start_channels()
            client.wait_for_ready(timeout=20)
            environment = kernel_environment(client)
            inject_publishing_helper(client, environment)
            startup.put({"ok": True, "environment": environment})
            while True:
                try:
                    task = jobs.get()
                    kind = task["kind"]
                    if kind == "execute":
                        execution_sequence += 1
                        response = execute(client, task["code"], environment)
                        response["sessionGeneration"] = session_generation
                        response["executionSequence"] = execution_sequence
                    elif kind == "restart":
                        client.stop_channels()
                        manager.restart_kernel(now=True)
                        client = manager.client()
                        client.start_channels()
                        client.wait_for_ready(timeout=20)
                        environment = kernel_environment(client)
                        session_generation += 1
                        execution_sequence = 0
                        inject_publishing_helper(client, environment)
                        response = {"ok": True, "environment": environment, "sessionGeneration": session_generation}
                    elif kind == "shutdown":
                        client.stop_channels()
                        client = None
                        manager.shutdown_kernel(now=True)
                        response = {"ok": True}
                    else:
                        response = {"ok": False, "error": "Unknown kernel worker command."}
                except Exception as error:
                    response = {"ok": False, "error": str(error), "traceback": traceback.format_exc().splitlines()}
                task["response"].put(response)
                if kind == "shutdown":
                    return
        except Exception as error:
            startup.put({"ok": False, "error": str(error), "traceback": traceback.format_exc().splitlines()})
        finally:
            if client is not None:
                try:
                    client.stop_channels()
                except Exception:
                    pass

    threading.Thread(target=kernel_worker, name="draftmatter-kernel-worker", daemon=True).start()
    ready = startup.get(timeout=25)
    if not ready.get("ok"):
        emit(ready)
        manager.shutdown_kernel(now=True)
        sys.exit(1)

    def dispatch(kind, code=None, timeout=330):
        response = queue.Queue(maxsize=1)
        jobs.put({"kind": kind, "code": code, "response": response})
        try:
            return response.get(timeout=timeout)
        except queue.Empty:
            return {"ok": False, "error": "The kernel worker did not answer within the command timeout."}

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                raw = self.rfile.readline(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    response = {"ok": False, "error": "Kernel command exceeds the 2 MB safety limit."}
                else:
                    request = json.loads(raw.decode("utf-8"))
                    if request.get("secret") != secret:
                        response = {"ok": False, "error": "Kernel command authentication failed."}
                    elif request.get("kind") == "execute":
                        if not activity_lock.acquire(blocking=False):
                            response = {"ok": False, "error": "This language kernel is already executing a cell."}
                        else:
                            try:
                                response = dispatch("execute", str(request.get("code") or ""))
                            finally:
                                activity_lock.release()
                    elif request.get("kind") == "interrupt":
                        manager.interrupt_kernel()
                        response = {"ok": True}
                    elif request.get("kind") == "restart":
                        with activity_lock:
                            response = dispatch("restart", timeout=40)
                    elif request.get("kind") == "shutdown":
                        with activity_lock:
                            response = dispatch("shutdown", timeout=15)
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
                    else:
                        response = {"ok": False, "error": "Unknown kernel command."}
            except Exception as error:
                response = {"ok": False, "error": str(error), "traceback": traceback.format_exc().splitlines()}
            self.wfile.write((json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    emit({"ok": True, "port": server.server_address[1], "environment": ready["environment"], "sessionId": str(uuid.uuid4())})
    server.serve_forever(poll_interval=0.1)
except Exception as error:
    emit({"ok": False, "error": str(error), "traceback": traceback.format_exc().splitlines()})
    sys.exit(1)

import json
import queue
import socketserver
import sys
import threading
import traceback
import uuid


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
    manager = KernelManager(kernel_name=kernel_name)
    manager.start_kernel(cwd=working_directory)
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
                return {
                    "identity": kernel_name,
                    "version": str(language.get("version") or content.get("implementation_version") or ""),
                    "details": {
                        "mode": "interactive-kernel",
                        "kernel": kernel_name,
                        "implementation": str(content.get("implementation") or "jupyter"),
                        "language": str(language.get("name") or ""),
                    },
                }

    def execute(client, code, environment):
        message_id = client.execute(code, allow_stdin=False, stop_on_error=False, store_history=True)
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
            "providerRunId": "kernel:" + kernel_name + ":" + message_id,
            "environment": environment,
        }

    def kernel_worker():
        client = None
        try:
            client = manager.client()
            client.start_channels()
            client.wait_for_ready(timeout=20)
            environment = kernel_environment(client)
            startup.put({"ok": True, "environment": environment})
            while True:
                try:
                    task = jobs.get()
                    kind = task["kind"]
                    if kind == "execute":
                        response = execute(client, task["code"], environment)
                    elif kind == "restart":
                        client.stop_channels()
                        manager.restart_kernel(now=True)
                        client = manager.client()
                        client.start_channels()
                        client.wait_for_ready(timeout=20)
                        environment = kernel_environment(client)
                        response = {"ok": True, "environment": environment}
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

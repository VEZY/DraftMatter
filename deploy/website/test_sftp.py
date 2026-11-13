"""Real SSH handshakes prove server-key checks happen before password delivery."""
import importlib.util
import io
from pathlib import Path
import socket
import threading
import unittest
from unittest import mock

import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

spec = importlib.util.spec_from_file_location('website_deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def server_key():
    key = Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption())
    return paramiko.Ed25519Key.from_private_key(io.StringIO(key.decode()))


class SftpHandshakeTests(unittest.TestCase):
    def handshake(self, wrong_key):
        actual = server_key()
        pinned = server_key() if wrong_key else actual
        received = []
        stop = threading.Event()
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(5)
        address = listener.getsockname()

        class Server(paramiko.ServerInterface):
            def check_auth_password(self, username, password):
                received.append((username, password))
                return paramiko.AUTH_SUCCESSFUL

            def get_allowed_auths(self, username):
                return 'password'

            def check_channel_request(self, kind, channel_id):
                return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

        def serve():
            transport = None
            try:
                connection, _ = listener.accept()
                transport = paramiko.Transport(connection)
                transport.add_server_key(actual)
                transport.set_subsystem_handler('sftp', paramiko.SFTPServer, paramiko.SFTPServerInterface)
                transport.start_server(server=Server())
                stop.wait(5)
            finally:
                if transport:
                    transport.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        base_client = paramiko.SSHClient

        class LocalClient(base_client):
            def connect(self, host, **kwargs):
                kwargs['sock'] = socket.create_connection(address, timeout=5)
                return super().connect(host, **kwargs)

        try:
            with mock.patch.object(paramiko, 'SSHClient', LocalClient):
                if wrong_key:
                    with self.assertRaises(paramiko.BadHostKeyException):
                        deploy.connect_sftp('ftp.cluster129.hosting.ovh.net', 'test-user', 'test-only-password', pinned.get_name() + ' ' + pinned.get_base64())
                    self.assertEqual(received, [], 'Credentials must never be sent to a server with an untrusted key.')
                else:
                    client, sftp = deploy.connect_sftp('ftp.cluster129.hosting.ovh.net', 'test-user', 'test-only-password', pinned.get_name() + ' ' + pinned.get_base64())
                    try:
                        self.assertEqual(received, [('test-user', 'test-only-password')])
                    finally:
                        sftp.close()
                        client.close()
        finally:
            stop.set()
            thread.join(6)
            listener.close()
            self.assertFalse(thread.is_alive())

    def test_accepts_verified_key_over_a_real_local_sftp_connection(self):
        self.handshake(False)

    def test_rejects_changed_key_before_transmitting_password(self):
        self.handshake(True)


if __name__ == '__main__':
    unittest.main()

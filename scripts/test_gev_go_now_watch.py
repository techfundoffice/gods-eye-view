#!/usr/bin/env python3
"""Unit checks for the go-now watcher helpers."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_watch():
    path = Path(__file__).with_name('gev-go-now-watch.py')
    spec = importlib.util.spec_from_file_location('gev_go_now_watch', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReplitSecretTests(unittest.TestCase):
    def setUp(self):
        self.watch = load_watch()

    def test_replit_secret_reads_environment_json(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'latest.json'
            path.write_text(json.dumps({
                'environment': {
                    'YOUTUBE_STREAM_KEY': 'abcd-efgh-ijkl-mnop',
                    'YOUTUBE_WATCH_URL': 'https://www.youtube.com/watch?v=CVSB4QJhVTU',
                }
            }), encoding='utf-8')
            self.watch.REPLIT_ENV_JSON = str(path)
            self.assertEqual(self.watch.replit_secret('YOUTUBE_STREAM_KEY'), 'abcd-efgh-ijkl-mnop')
            self.assertEqual(self.watch.replit_secret('MISSING'), '')

    def test_replit_secret_missing_file(self):
        self.watch.REPLIT_ENV_JSON = '/tmp/gev-missing-replit-env.json'
        self.assertEqual(self.watch.replit_secret('YOUTUBE_STREAM_KEY'), '')

    def test_first_stream_key_prefers_file_then_env_then_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            key_file = Path(folder) / 'key'
            env_file = Path(folder) / '.env'
            secret_file = Path(folder) / 'latest.json'
            secret_file.write_text(json.dumps({
                'environment': {'YOUTUBE_STREAM_KEY': 'from-secret'}
            }), encoding='utf-8')
            self.watch.KEY_FILE = str(key_file)
            self.watch.ENV_FILE = str(env_file)
            self.watch.REPLIT_ENV_JSON = str(secret_file)
            self.assertEqual(self.watch.first_stream_key(), 'from-secret')
            env_file.write_text('YOUTUBE_STREAM_KEY=from-env\n', encoding='utf-8')
            self.assertEqual(self.watch.first_stream_key(), 'from-env')
            key_file.write_text('from-file\n', encoding='utf-8')
            self.assertEqual(self.watch.first_stream_key(), 'from-file')

    def test_split_rtmps_url(self):
        ingest, key = self.watch.split_youtube_ingest(
            'rtmps://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop'
        )
        self.assertEqual(ingest, 'rtmps://a.rtmp.youtube.com/live2')
        self.assertEqual(key, 'abcd-efgh-ijkl-mnop')


if __name__ == '__main__':
    unittest.main()

"""Real media normalization regression: browser streaming WebM lacks duration."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recording_server', ROOT/'server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


@unittest.skipUnless((app.MEDIA_TOOLS/'ffmpeg').is_file(), 'local ffmpeg unavailable')
class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def streaming_webm(self, duration, fps=10):
        path = self.folder/'recording.webm'
        recording = subprocess.run([str(app.MEDIA_TOOLS/'ffmpeg'), '-nostdin', '-v', 'error',
                '-f', 'lavfi', '-i', f'color=c=black:s=64x64:r={fps}', '-t', str(duration),
                '-c:v', 'libvpx', '-f', 'webm', '-live', '1', 'pipe:1'], capture_output=True, check=True, timeout=15)
        path.write_bytes(recording.stdout)
        metadata = subprocess.check_output([str(app.MEDIA_TOOLS/'ffprobe'), '-v', 'error',
                     '-show_format', '-of', 'json', str(path)])
        self.assertNotIn('duration', json.loads(metadata)['format'])
        return path

    def test_streaming_recording_without_duration_header_normalizes(self):
        result = self.folder/'playback.mp4'
        app.normalize_video(self.streaming_webm(2.4), result)
        self.assertTrue(result.is_file())
        metadata = subprocess.check_output([str(app.MEDIA_TOOLS/'ffprobe'), '-v', 'error',
                    '-show_format', '-of', 'json', str(result)])
        self.assertAlmostEqual(float(json.loads(metadata)['format']['duration']), 2.4, places=1)

    def test_missing_duration_does_not_bypass_maximum_length(self):
        with self.assertRaises(app.ApiError) as raised:
            app.normalize_video(self.streaming_webm(46.5), self.folder/'playback.mp4')
        self.assertEqual(raised.exception.status, 422)

    def test_too_short_recording_is_rejected(self):
        with self.assertRaises(app.ApiError):
            app.normalize_video(self.streaming_webm(0.1), self.folder/'playback.mp4')

    def test_one_frame_beyond_45_seconds_rejected_before_engine(self):
        with self.assertRaises(app.ApiError) as raised:
            app.normalize_video(self.streaming_webm(45.0334, 30), self.folder/'playback.mp4')
        self.assertEqual(raised.exception.status, 422)

    def test_mp4_cadence_and_pixels_preserved(self):
        original = ROOT/'artifacts/vision-local-curl-smoke.mp4'
        if not original.is_file():
            self.skipTest('private local verification clip absent')
        output = self.folder/'copy.mp4'
        app.normalize_video(original, output)
        def decoded_hash(path):
            return subprocess.check_output([str(app.MEDIA_TOOLS/'ffmpeg'), '-v', 'error',
                    '-i', str(path), '-map', '0:v:0', '-f', 'framemd5', '-']).decode()
        self.assertEqual(decoded_hash(original), decoded_hash(output))


if __name__ == '__main__':
    unittest.main()

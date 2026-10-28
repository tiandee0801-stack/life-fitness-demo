#!/usr/bin/env python3
"""Bounded local RTMPose video observation. No camera, network or downloads."""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import shutil
from pathlib import Path
import subprocess
import sys
import time

from counter import CurlCounter, elbow_angle

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path(os.environ.get('LF_POSE_MODELS', ROOT / 'vendor/Good-GYM/models'))
FFPROBE = Path(os.environ.get('LF_FFPROBE', shutil.which('ffprobe') or '/usr/local/bin/ffprobe'))
DETECTOR = MODELS / 'yolox_nano_8xb8-300e_humanart-40f6f0d0.onnx'
POSE = MODELS / 'rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.onnx'
MAX_BYTES = 60 * 1024 * 1024
MAX_SECONDS = 45.0
MAX_WALL_SECONDS = 180
SAMPLE_FPS = 8.0
MAX_SAMPLES = 360


class VideoError(ValueError):
    pass


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    os.replace(temp, path)


def probe_video(path):
    """Check resource limits and rotation before constructing model sessions."""
    path = Path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise VideoError('视频为空或超过 60 MiB。')
    if not FFPROBE.is_file():
        raise VideoError('本地视频检查工具缺失，尚未进行识别。')
    try:
        p = subprocess.run([str(FFPROBE), '-v', 'error', '-print_format', 'json',
                            '-show_streams', '-show_format', str(path)],
                           capture_output=True, timeout=10, check=True)
        meta = json.loads(p.stdout)
        streams = [s for s in meta['streams'] if s.get('codec_type') == 'video'
                   and not s.get('disposition', {}).get('attached_pic')]
        if len(streams) != 1:
            raise VideoError('请上传仅有一个视频画面的普通视频文件。')
        stream = streams[0]
        w, h = int(stream['width']), int(stream['height'])
        if not (64 <= w <= 4096 and 64 <= h <= 4096 and w*h <= 9_000_000):
            raise VideoError('视频分辨率超出范围，请使用不超过 4K 的普通视频。')
        rate = stream.get('avg_frame_rate', '0/1').split('/')
        fps = float(rate[0]) / float(rate[1])
        duration = float(stream.get('duration') or meta['format']['duration'])
        if not math.isfinite(fps) or not 1 <= fps <= 120:
            raise VideoError('视频帧率无法可靠读取，或超出 1–120 fps。')
        if not math.isfinite(duration) or not 0.3 <= duration <= MAX_SECONDS + 0.001:
            raise VideoError('请使用 0.3–45 秒的视频。')
        rotation = float(stream.get('tags', {}).get('rotate', 0))
        for item in stream.get('side_data_list', []):
            rotation = float(item.get('rotation', rotation))
        if abs(rotation % 360) > 0.01:
            raise VideoError('视频仍有旋转标记，请先经上传接口转为正向画面后再识别。')
        codec = stream.get('codec_name')
        if codec not in ('h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mjpeg', 'prores'):
            raise VideoError('视频编码暂不支持，请转换为 MP4/H.264。')
        return {'width': w, 'height': h, 'fps': fps, 'duration': duration}
    except VideoError:
        raise
    except (subprocess.SubprocessError, ValueError, KeyError, TypeError, ZeroDivisionError):
        raise VideoError('无法读取视频元信息，请使用正常导出的 MP4 视频。') from None


def make_models():
    if not DETECTOR.is_file() or not POSE.is_file():
        raise VideoError('本地人体检测或姿态模型缺失，未尝试联网下载。')
    # rtmlib preprocessing/postprocessing is reused; ONNX execution is pinned to
    # bounded CPU sessions instead of depending on machine-wide provider choices.
    import onnxruntime as ort
    from rtmlib import YOLOX, RTMPose
    real_session = ort.InferenceSession

    def bounded_session(*args, **kwargs):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        kwargs['sess_options'] = options
        kwargs['providers'] = ['CPUExecutionProvider']
        return real_session(*args, **kwargs)

    # This CLI is a dedicated single-use process; restore even on failure.
    ort.InferenceSession = bounded_session
    try:
        with contextlib.redirect_stdout(sys.stderr):
            detector = YOLOX(str(DETECTOR), model_input_size=(416, 416),
                             backend='onnxruntime', device='cpu', score_thr=0.7)
            pose = RTMPose(str(POSE), model_input_size=(192, 256),
                           backend='onnxruntime', device='cpu', to_openpose=False)
    finally:
        ort.InferenceSession = real_session
    return detector, pose


def analyze(input_path, output_path, side):
    started = time.monotonic()
    info = probe_video(input_path)
    import cv2
    import numpy as np
    cv2.setNumThreads(2)
    cap = cv2.VideoCapture(str(input_path), cv2.CAP_FFMPEG)
    if not cap.isOpened():
        raise VideoError('视频无法解码，请重新导出为 MP4/H.264。')
    progress_path = Path(output_path).with_suffix('.progress.json')
    atomic_json(progress_path, {'progress': 2, 'status': 'running'})
    try:
        rotation = cap.get(cv2.CAP_PROP_ORIENTATION_META)
        if abs(rotation % 360) > 0.01:
            raise VideoError('解码器报告旋转画面，请先规范化视频。')
        ok, first_frame = cap.read()
        if not ok or first_frame is None:
            raise VideoError('视频中没有可解码的画面。')
        if first_frame.shape[:2] != (info['height'], info['width']):
            raise VideoError('视频尺寸与元信息不一致，停止分析以避免骨架错位。')
        detector, pose = make_models()
        counter = CurlCounter()
        frames, events = [], []
        valid_count = 0
        previous_bbox = None
        invalid_start = None
        longest_invalid = 0.0
        identity_broken = False
        had_multiple = False
        source_index = 0
        next_sample = 0.0
        previous_source_t = None
        frame = first_frame
        while True:
            if time.monotonic() - started > MAX_WALL_SECONDS:
                raise VideoError('本次视频处理超过时间上限，请截取更短片段。')
            if source_index > 5400:
                raise VideoError('视频帧数超出上限。')
            if frame is None:
                break
            if frame.shape[:2] != (info['height'], info['width']):
                raise VideoError('视频中途改变画面尺寸，无法可靠叠加骨架。')
            # Normalized uploads have constant fps. Real decoder timestamps are
            # retained when available; missing timestamps fall back to frame/fps.
            decoded_t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            t = decoded_t if math.isfinite(decoded_t) and (
                previous_source_t is None or decoded_t > previous_source_t) else source_index / info['fps']
            if previous_source_t is not None and t <= previous_source_t:
                raise VideoError('视频时间戳不连续，无法可靠计数。')
            previous_source_t = t
            if t > MAX_SECONDS + 0.05:
                raise VideoError('解码后视频超过 45 秒，停止处理。')
            if t + 1e-6 >= next_sample and len(frames) < MAX_SAMPLES:
                next_sample += 1.0 / SAMPLE_FPS
                scale = min(1.0, 960.0 / max(info['width'], info['height']))
                image = cv2.resize(frame, (round(info['width']*scale), round(info['height']*scale))) if scale < 1 else frame
                ih, iw = image.shape[:2]
                boxes = np.asarray(detector(image))
                points = [[0.0, 0.0, 0.0] for _ in range(17)]
                angle, valid, reason = None, False, 'person_not_visible'
                if len(boxes) > 1:
                    had_multiple = True
                    reason = 'multiple_people'
                elif len(boxes) == 1:
                    box = boxes[0].astype(float)
                    center = np.array([(box[0]+box[2])/2/iw, (box[1]+box[3])/2/ih])
                    switched = previous_bbox is not None and np.linalg.norm(center-previous_bbox) > 0.22
                    if switched:
                        identity_broken = True
                        reason = 'subject_discontinuity'
                    previous_bbox = center
                    kpts, scores = pose(image, bboxes=boxes[:1])
                    raw = np.asarray(kpts[0], dtype=float)
                    conf = np.asarray(scores[0], dtype=float)
                    if raw.shape != (17, 2) or conf.shape != (17,):
                        raise VideoError('本地模型输出格式与 COCO17 不一致。')
                    common = max(iw, ih)
                    angle_points = []
                    for p, s in zip(raw, conf):
                        finite = np.all(np.isfinite(p)) and math.isfinite(float(s))
                        in_frame = finite and 0 <= p[0] < iw and 0 <= p[1] < ih
                        score = min(1.0, max(0.0, float(s))) if in_frame else 0.0
                        x = min(1.0, max(0.0, float(p[0]/iw))) if finite else 0.0
                        y = min(1.0, max(0.0, float(p[1]/ih))) if finite else 0.0
                        angle_points.append([float(p[0]/common) if finite else 0.0,
                                             float(p[1]/common) if finite else 0.0, score])
                        points[len(angle_points)-1] = [round(x, 5), round(y, 5), round(score, 4)]
                    angle = elbow_angle(angle_points, side)
                    valid = angle is not None and not switched
                    if not valid and not switched:
                        reason = 'selected_arm_not_visible'
                if valid:
                    valid_count += 1
                    if invalid_start is not None:
                        longest_invalid = max(longest_invalid, t-invalid_start)
                    invalid_start = None
                else:
                    if invalid_start is None:
                        invalid_start = t
                    if not events or events[-1]['type'] != reason:
                        events.append({'t': round(t, 3), 'type': reason})
                event = counter.update(t, angle, valid)
                if event in ('cycle_completed', 'cycle_expired', 'cycle_too_fast'):
                    events.append({'t': round(t, 3), 'type': event})
                frames.append({'t': round(t, 4), 'points': points,
                               'angle': round(angle, 2) if valid else None,
                               'count': counter.count, 'valid': bool(valid)})
                atomic_json(progress_path, {'progress': min(96, round(t/info['duration']*94)+3), 'status': 'running'})
            source_index += 1
            ok, frame = cap.read()
            if not ok:
                frame = None
        if not frames:
            raise VideoError('未获得可分析的视频帧。')
        observed_end = (previous_source_t or 0) + 1/info['fps']
        if observed_end < info['duration'] - max(0.5, 2/info['fps']):
            raise VideoError('视频解码提前结束，可能文件不完整。')
        if invalid_start is not None:
            longest_invalid = max(longest_invalid, info['duration']-invalid_start)
        valid_ratio = valid_count / len(frames)
        usable = (info['fps'] >= 8 and valid_ratio >= 0.9 and valid_count >= 16 and longest_invalid <= 0.5
                  and not identity_broken and not had_multiple)
        count = counter.count if usable else None
        summary = (f'观察到 {count} 个完整的伸展—弯曲—伸展周期，仅统计所选侧清楚可见的动作。'
                   if usable else '画面不足以可靠汇总次数，请确保只有一人、所选侧肩肘腕全程清楚可见，并保持固定机位。')
        result = {'count': count, 'side': side, 'duration': round(info['duration'], 3),
                  'validRatio': round(valid_ratio, 4), 'quality': 'usable' if usable else 'insufficient',
                  'summary': summary, 'frames': frames, 'events': events,
                  'width': info['width'], 'height': info['height'], 'mode': 'rtmpose-onnx',
                  'limitations': ['仅为二维画面的弯举周期观察，不代表动作标准、训练效果或医学评估。',
                                  '左/右指身体本人的左/右；镜面翻转视频可能造成侧别混淆。',
                                  '阈值尚未用真实弯举视频集校准；遮挡、衣物、机位和动作幅度会影响结果。',
                                  '只支持固定机位单人视频，不具备可靠的人脸或身份识别能力。']}
        atomic_json(output_path, result)
        atomic_json(progress_path, {'progress': 100, 'status': 'done'})
        return result
    finally:
        cap.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--side', choices=['left', 'right'], required=True)
    args = parser.parse_args()
    try:
        result = analyze(args.input, args.output, args.side)
        print(json.dumps({'ok': True, 'quality': result['quality'], 'count': result['count']}, ensure_ascii=False))
        return 0
    except Exception as exc:
        message = str(exc) if isinstance(exc, VideoError) else '视频识别失败，请换用清晰短视频重试。'
        atomic_json(Path(args.output).with_suffix('.progress.json'),
                    {'progress': 0, 'status': 'error', 'error': message})
        print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

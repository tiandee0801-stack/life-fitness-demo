"""Life Fitness single-user local demo. No external API, no corporate claims."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import math
import os
import sys
import shutil
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
from urllib.parse import urlsplit, parse_qs, unquote
import uuid
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent.parent
GYM = Path(os.environ.get('LF_GYM_HOME', ROOT / 'vendor/Good-GYM'))
AI = Path(os.environ.get('LF_COACH_HOME', ROOT / 'local-ai'))
MEDIA_TOOLS = Path(os.environ.get('LF_MEDIA_TOOLS', Path(shutil.which('ffmpeg') or '/usr/local/bin/ffmpeg').parent))
PYTHON_COACH = Path(os.environ.get('LF_COACH_PYTHON', sys.executable))
PYTHON_VISION = Path(os.environ.get('LF_VISION_PYTHON', sys.executable))
PORT = 8844
DATA = ROOT / 'runtime'
VERSION = '0.1.0'
MAX_VIDEO = 60 * 1024 * 1024
COACH_LOCK = threading.Lock()
VISION_LOCK = threading.Lock()
MUTATION_LOCK = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='life-video')
ID_RE = re.compile(r'^[0-9a-f]{32}$')


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def now():
    return datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')


def database():
    conn = sqlite3.connect(DATA / 'life-fitness.sqlite', timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'media').mkdir(exist_ok=True)
    (DATA / 'jobs').mkdir(exist_ok=True)
    with database() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, created TEXT, message TEXT, response TEXT, profile TEXT);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created TEXT, status TEXT, side TEXT, result TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created TEXT, payload TEXT);
        ''')
        db.execute("UPDATE jobs SET status='error',error=? WHERE status IN ('queued','running')",
                   ('上次分析被中断，请重新提交视频。',))


def profile():
    with database() as db:
        row = db.execute("SELECT value FROM settings WHERE key='profile'").fetchone()
    return json.loads(row['value']) if row else None


def text_field(data, key, max_length, default=None):
    value = data.get(key, default)
    if not isinstance(value, str) or len(value) > max_length:
        raise ApiError(422, f'{key} 格式或长度不正确。')
    return value.strip()


def enum_field(data, key, options):
    value = data.get(key)
    if not isinstance(value, str) or value not in options:
        raise ApiError(422, f'{key} 请选择有效选项。')
    return value


def validate_profile(body):
    result = {k: enum_field(body, k, choices) for k, choices in {
        'goal': ('habit', 'strength', 'learn'), 'experience': ('beginner', 'regular'),
        'equipment': ('none', 'dumbbell'), 'limitations': ('none', 'needs_review')}.items()}
    if type(body.get('minutes')) is not int or body['minutes'] not in (10, 15, 20, 30):
        raise ApiError(422, '可用时间请选择 10、15、20 或 30 分钟。')
    result.update(minutes=body['minutes'], note=text_field(body, 'note', 400, ''), updatedAt=now())
    return result


def state():
    with database() as db:
        chats = db.execute('SELECT * FROM chats ORDER BY created,rowid').fetchall()
        sessions = db.execute('SELECT payload FROM sessions ORDER BY created DESC,rowid DESC').fetchall()
    return {'profile': profile(), 'chats': [dict(id=r['id'], createdAt=r['created'], message=r['message'],
             response=json.loads(r['response'])) for r in chats],
            'sessions': [json.loads(r['payload']) for r in sessions]}


def export_records():
    with database() as db:
        rows = db.execute('SELECT * FROM jobs ORDER BY created,rowid').fetchall()
    jobs = [dict(jobId=r['id'], createdAt=r['created'], side=r['side'], status=r['status'],
                 error=r['error'], result=json.loads(r['result']) if r['result'] else None) for r in rows]
    return {'version':VERSION, 'exportedAt':now(), **state(), 'videoJobs':jobs,
            'mediaNote':'此JSON包含视频分析记录，但不含视频文件；清空前请另行保留自己的原始视频。'}


def run_coach(body):
    message = text_field(body, 'message', 600)
    if not message:
        raise ApiError(422, '请先输入想问的问题。')
    with MUTATION_LOCK:
        if not COACH_LOCK.acquire(blocking=False):
            raise ApiError(429, 'Coach 正在处理上一条消息，请稍后再试。')
    try:
        saved_profile = profile()
        with database() as db:
            rows = db.execute('SELECT message,response FROM chats ORDER BY created DESC,rowid DESC LIMIT 2').fetchall()
        history = []
        for row in reversed(rows):
            history += [{'role':'user','content':row['message']},
                        {'role':'assistant','content':json.loads(row['response']).get('text','')}]
        payload = json.dumps({'profile':saved_profile, 'message':message, 'history':history}, ensure_ascii=False)
        if not PYTHON_COACH.is_file() or not (ROOT / 'engine/coach.py').is_file():
            raise ApiError(503, '本地 Coach 环境未就绪，没有生成模拟回答。')
        try:
            process = subprocess.run([str(PYTHON_COACH), str(ROOT / 'engine/coach.py')], input=payload,
                                     text=True, capture_output=True, timeout=90, cwd=ROOT)
            if process.returncode:
                raise ValueError('coach failed')
            result = json.loads(process.stdout)
            if result.get('kind') not in ('plan','clarify','review','out_of_scope','answer') or \
               result.get('mode') not in ('local-model','rule-boundary') or not isinstance(result.get('text'), str):
                raise ValueError('invalid response')
        except subprocess.TimeoutExpired:
            raise ApiError(504, '本地模型本次响应超时，请稍后重试；没有保存不完整结果。')
        except (ValueError, OSError):
            raise ApiError(502, '本地 Coach 输出未通过检查，请重试；没有用示例回答替代。')
        result['id'] = uuid.uuid4().hex
        with database() as db:
            db.execute('INSERT INTO chats VALUES (?,?,?,?,?)', (result['id'], now(), message,
                       json.dumps(result, ensure_ascii=False), json.dumps(saved_profile, ensure_ascii=False)))
        return result
    finally:
        COACH_LOCK.release()


def set_job(job_id, status, result=None, error=None):
    with database() as db:
        db.execute('UPDATE jobs SET status=?,result=?,error=? WHERE id=?',
                   (status, json.dumps(result, ensure_ascii=False) if result else None, error, job_id))


def normalize_video(source, target):
    """Inspect before conversion; auto-rotate and strip audio for predictable playback."""
    probe = subprocess.run([str(MEDIA_TOOLS/'ffprobe'), '-v', 'error', '-show_streams', '-show_format',
                           '-of', 'json', str(source)], capture_output=True, text=True, timeout=12)
    try:
        meta = json.loads(probe.stdout)
        stream = next(s for s in meta['streams'] if s.get('codec_type') == 'video')
        raw_duration = meta.get('format', {}).get('duration', stream.get('duration'))
        if raw_duration in (None, 'N/A', ''):
            # MediaRecorder's streaming WebM has no duration header. Inspect at
            # most 46 seconds of packet timestamps, then verify the final MP4.
            packets = subprocess.run([str(MEDIA_TOOLS/'ffprobe'), '-v', 'error',
                '-select_streams', 'v:0', '-read_intervals', '%+46',
                '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', str(source)],
                capture_output=True, text=True, timeout=12)
            stamps = [(float(p['pts_time']), float(p.get('duration_time', 0)))
                      for p in json.loads(packets.stdout).get('packets', [])]
            if not stamps or any(not math.isfinite(x) for pair in stamps for x in pair):
                raise ValueError()
            duration = max(t + max(d, 0) for t,d in stamps) - min(t for t,d in stamps)
        else:
            duration = float(raw_duration)
        w,h = int(stream['width']), int(stream['height'])
        if not (0.3 <= duration <= 45.001 and 16 <= w <= 4096 and 16 <= h <= 4096 and w*h <= 13_000_000):
            raise ValueError()
    except (ValueError, KeyError, StopIteration, TypeError):
        raise ApiError(422, '视频无法读取或超出范围。请上传 0.3–45 秒、最高 4K 的单人视频。')
    rotation = float(stream.get('tags', {}).get('rotate', 0))
    for side in stream.get('side_data_list', []):
        if 'rotation' in side:
            rotation = float(side['rotation'])
    copy_compatible = (stream.get('codec_name') == 'h264' and stream.get('pix_fmt') == 'yuv420p'
                       and max(w,h) <= 1280 and rotation % 360 == 0)
    command = [str(MEDIA_TOOLS/'ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
               '-i', str(source), '-t', '46', '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1']
    if copy_compatible:
        # Preserve decoded pixels and original cadence for pose measurements.
        command += ['-c:v', 'copy']
    else:
        command += ['-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                    '-vsync','0','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p']
    command += ['-movflags','+faststart',str(target)]
    converted = subprocess.run(command, capture_output=True, timeout=90)
    if converted.returncode or not target.is_file():
        raise ApiError(422, '视频转换失败，请换用 MP4 视频。')
    checked = subprocess.run([str(MEDIA_TOOLS/'ffprobe'), '-v', 'error', '-show_entries',
                              'format=duration', '-of', 'json', str(target)],
                              capture_output=True, text=True, timeout=12)
    try:
        final_duration = float(json.loads(checked.stdout)['format']['duration'])
        if not 0.3 <= final_duration <= 45.001:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        target.unlink(missing_ok=True)
        raise ApiError(422, '视频时长超出范围，请录制或上传 0.3–45 秒的视频。')


def analyze_video(job_id, side):
    raw = DATA/'media'/f'{job_id}.upload'
    movie = DATA/'media'/f'{job_id}.mp4'
    result_path = DATA/'jobs'/f'{job_id}.json'
    try:
        set_job(job_id, 'running')
        normalize_video(raw, movie)
        raw.unlink(missing_ok=True)
        if not PYTHON_VISION.is_file():
            raise ApiError(503, '本地动作识别环境不可用。')
        process = subprocess.run([str(PYTHON_VISION), str(ROOT/'engine/vision.py'), '--input', str(movie),
                                  '--output', str(result_path), '--side', side], cwd=ROOT, capture_output=True,
                                 timeout=240)
        if process.returncode or not result_path.is_file():
            raise ApiError(502, '动作识别未完成，请检查视频是否完整并重试。')
        result = json.loads(result_path.read_text())
        if result.get('quality') not in ('usable','insufficient') or not isinstance(result.get('frames'), list):
            raise ApiError(502, '视频分析结果格式不正确，未生成计数。')
        result.update(sourceUrl=f'/media/{job_id}.mp4')
        set_job(job_id, 'done', result)
    except ApiError as exc:
        set_job(job_id, 'error', error=exc.message)
        movie.unlink(missing_ok=True)
    except subprocess.TimeoutExpired:
        set_job(job_id, 'error', error='分析超时，请使用更短、画面更清楚的视频。')
        movie.unlink(missing_ok=True)
    except Exception:
        set_job(job_id, 'error', error='本次视频分析失败，没有生成替代计数。')
        movie.unlink(missing_ok=True)
    finally:
        raw.unlink(missing_ok=True)
        VISION_LOCK.release()


def get_job(job_id):
    if not isinstance(job_id, str) or not ID_RE.fullmatch(job_id):
        raise ApiError(404, '未找到这次分析。')
    with database() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    if not row:
        raise ApiError(404, '未找到这次分析。')
    progress = 100 if row['status']=='done' else 0
    progress_file = DATA/'jobs'/f'{job_id}.progress.json'
    if row['status']=='running' and progress_file.exists():
        try:
            p = json.loads(progress_file.read_text())
            progress = max(0, min(99, float(p.get('progress',0))))
        except (ValueError, OSError, TypeError):
            pass
    result = {'jobId':row['id'], 'status':row['status'], 'progress':progress, 'error':row['error']}
    if row['result']:
        result['result'] = json.loads(row['result'])
    return result


def save_feedback(body):
    current_profile = profile()
    saved_profile = current_profile
    if not saved_profile:
        raise ApiError(422, '请先保存训练档案。')
    effort = body.get('perceivedEffort')
    if type(effort) is not int or not 1 <= effort <= 10:
        raise ApiError(422, '主观用力程度请选择 1–10。')
    feedback = dict(perceivedEffort=effort, discomfort=enum_field(body,'discomfort',('none','yes')),
                    completion=enum_field(body,'completion',('completed','partial','not_started')),
                    note=text_field(body,'note',500,''))
    coach_id, job_id = body.get('coachId'), body.get('jobId')
    if coach_id is not None and (not isinstance(coach_id, str) or not ID_RE.fullmatch(coach_id)):
        raise ApiError(422,'Coach 记录不存在。')
    if job_id is not None and (not isinstance(job_id, str) or not ID_RE.fullmatch(job_id)):
        raise ApiError(422,'视频记录不存在。')
    if coach_id:
        if not isinstance(coach_id,str) or not ID_RE.fullmatch(coach_id):
            raise ApiError(422,'Coach 记录不存在。')
        with database() as db:
            coach = db.execute('SELECT response,profile FROM chats WHERE id=?',(coach_id,)).fetchone()
        if not coach:
            raise ApiError(422,'Coach 记录不存在。')
        saved_profile = json.loads(coach['profile']) or saved_profile
    job = None
    if job_id:
        job = get_job(job_id)
        if job['status'] != 'done':
            raise ApiError(409,'请等待视频分析完成后再关联本次记录。')
    review = feedback['discomfort']=='yes' or saved_profile.get('limitations')=='needs_review' or current_profile.get('limitations')=='needs_review'
    if re.search(r'疼|痛|受伤|肿|头晕|胸闷|不适',feedback['note']):
        review = True
    complete_label = {'completed':'已完成','partial':'部分完成','not_started':'尚未开始'}[feedback['completion']]
    count = job['result'].get('count') if job else None
    observation = (f'视频中观察到 {count} 次完整屈伸周期。' if count is not None else
                   ('本次视频观察条件不足，未给出次数。' if job else '本次没有视频识别结果。'))
    summary = f'你记录的完成情况：{complete_label}；主观用力程度 {effort}/10。{observation}'
    summary += ('已记录不适或需复核事项，本系统不据此安排进阶；请交由合格专业人员判断。' if review else
                '这是一条训练记录，不代表动作质量或训练安全结论。')
    item = dict(id=uuid.uuid4().hex, createdAt=now(), profileSnapshot=saved_profile, coachId=coach_id,
                jobId=job_id, feedback=feedback, summary=summary, reviewNeeded=review,
                observation=job['result'] if job else None)
    with database() as db:
        db.execute('INSERT INTO sessions VALUES (?,?,?)',(item['id'],item['createdAt'],json.dumps(item,ensure_ascii=False)))
    return {'session':item}


class Handler(BaseHTTPRequestHandler):
    server_version = 'LifeFitnessLocal/0.1'

    def log_message(self, fmt, *args):
        # Do not log bodies, personal records or model prompts.
        return

    def check_origin(self):
        if self.headers.get('Host','') not in (f'127.0.0.1:{PORT}',f'localhost:{PORT}'):
            raise ApiError(403,'仅允许本机访问。')
        if self.command not in ('GET','HEAD'):
            origin = self.headers.get('Origin')
            if origin not in (None, f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}') or \
               self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise ApiError(403,'仅允许本地应用提交数据。')

    def send_json(self, value, status=200, download=False):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        if download:
            self.send_header('Content-Disposition','attachment; filename="life-fitness-records.json"')
        self.end_headers()
        if self.command!='HEAD': self.wfile.write(data)

    def body_length(self, maximum):
        try:
            length = int(self.headers.get('Content-Length','0'))
        except ValueError:
            raise ApiError(400,'请求长度不正确。')
        if length<=0 or length>maximum:
            self.close_connection = True
            raise ApiError(413,'文件或内容为空、或超出大小限制。')
        return length

    def read_json(self):
        length = self.body_length(12000)
        if 'application/json' not in self.headers.get('Content-Type',''):
            raise ApiError(415,'请使用 JSON 格式。')
        try:
            result = json.loads(self.rfile.read(length))
            if not isinstance(result,dict): raise ValueError()
            return result
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400,'JSON 内容不正确。')

    def serve_file(self, path, kind=None):
        if not path.is_file():
            raise ApiError(404,'文件不存在。')
        size = path.stat().st_size
        start,end = 0,size-1
        range_header = self.headers.get('Range')
        if range_header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
            if not match or not any(match.groups()):
                raise ApiError(416,'无法读取指定范围。')
            a,b = match.groups()
            start = int(a) if a else max(0,size-int(b))
            end = min(int(b),size-1) if a and b else size-1
            if start<0 or start>end or start>=size:
                raise ApiError(416,'范围超出文件大小。')
        self.send_response(206 if range_header else 200)
        self.send_header('Content-Type',kind or mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        self.send_header('Content-Length',str(end-start+1))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        if range_header: self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command=='HEAD': return
        with path.open('rb') as stream:
            stream.seek(start)
            remaining=end-start+1
            while remaining:
                chunk=stream.read(min(65536,remaining))
                if not chunk:break
                self.wfile.write(chunk)
                remaining-=len(chunk)

    def route(self):
        self.connection.settimeout(120)
        self.check_origin()
        url = urlsplit(self.path)
        path = unquote(url.path)
        if self.command in ('GET','HEAD'):
            if path=='/api/health':
                return self.send_json({'ok':True,'app':'life-fitness','version':VERSION,
                    'coach':{'available':PYTHON_COACH.is_file() and (Path(os.environ.get('LF_MODEL_PATH', AI/'models/Qwen3-4B-Instruct-2507-4bit'))/'model.safetensors').is_file(),
                             'model':'Qwen3-4B-Instruct-2507-4bit','busy':COACH_LOCK.locked()},
                    'vision':{'available':PYTHON_VISION.is_file() and (ROOT/'engine/vision.py').is_file(),'busy':VISION_LOCK.locked()},
                    'scope':'local-single-user-demo'})
            if path=='/api/state': return self.send_json(state())
            if path=='/api/export': return self.send_json(export_records(),download=True)
            if path.startswith('/api/jobs/'): return self.send_json(get_job(path.rsplit('/',1)[-1]))
            match = re.fullmatch(r'/media/([0-9a-f]{32})\.mp4',path)
            if match:
                if get_job(match.group(1))['status']!='done':raise ApiError(404,'分析还未完成。')
                return self.serve_file(DATA/'media'/f'{match.group(1)}.mp4','video/mp4')
            if path.startswith('/api/'): raise ApiError(404,'接口不存在。')
            target=(ROOT/'dist'/('index.html' if path=='/' else path.lstrip('/'))).resolve()
            if not target.is_relative_to((ROOT/'dist').resolve()):raise ApiError(403,'无效路径。')
            return self.serve_file(target)
        if self.command=='PUT' and path=='/api/profile':
            updated=validate_profile(self.read_json())
            with MUTATION_LOCK:
                with database() as db:
                    db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',('profile',json.dumps(updated,ensure_ascii=False)))
            return self.send_json({'profile':updated})
        if self.command=='POST' and path=='/api/coach':
            return self.send_json(run_coach(self.read_json()))
        if self.command=='POST' and path=='/api/video':
            side=parse_qs(url.query).get('side',['left'])[0]
            if side not in ('left','right'): raise ApiError(422,'请选择身体左侧或右侧。')
            length=self.body_length(MAX_VIDEO)
            content_type=self.headers.get('Content-Type','')
            if not (content_type.startswith('video/') or content_type=='application/octet-stream'):
                self.close_connection=True
                raise ApiError(415,'请上传视频文件。')
            with MUTATION_LOCK:
                with database() as db:
                    count=db.execute('SELECT count(*) AS n FROM jobs').fetchone()['n']
                if count>=20:raise ApiError(409,'已保留20次分析，请先导出记录，再清空本Demo数据。')
                if not VISION_LOCK.acquire(blocking=False):raise ApiError(429,'上一段视频仍在分析，请稍后。')
                job_id=uuid.uuid4().hex
                raw=DATA/'media'/f'{job_id}.upload'
                try:
                    with raw.open('wb') as out:
                        remaining=length
                        while remaining:
                            chunk=self.rfile.read(min(65536,remaining))
                            if not chunk:raise ApiError(400,'视频没有上传完整。')
                            out.write(chunk);remaining-=len(chunk)
                    with database() as db:
                        db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)',(job_id,now(),'queued',side,None,None))
                    POOL.submit(analyze_video,job_id,side)
                except Exception:
                    raw.unlink(missing_ok=True)
                    VISION_LOCK.release()
                    raise
            return self.send_json({'jobId':job_id,'status':'queued'},202)
        if self.command=='POST' and path=='/api/feedback':
            with MUTATION_LOCK:result=save_feedback(self.read_json())
            return self.send_json(result,201)
        if self.command=='DELETE' and path=='/api/data':
            with MUTATION_LOCK:
                if COACH_LOCK.locked() or VISION_LOCK.locked():raise ApiError(409,'请等待正在进行的分析完成，再清空数据。')
                with database() as db:
                    for table in ('settings','sessions','chats','jobs'):db.execute(f'DELETE FROM {table}')
                for folder in ('media','jobs'):
                    for file in (DATA/folder).iterdir():
                        if file.is_file() and not file.is_symlink():file.unlink()
            return self.send_json({'ok':True})
        raise ApiError(404,'接口不存在。')

    def handle_request(self):
        try:self.route()
        except ApiError as error:self.send_json({'error':error.message,'detail':error.message},error.status)
        except (BrokenPipeError, ConnectionResetError):pass
        except Exception:self.send_json({'error':'本次操作未完成，请重试。'},500)

    do_GET=do_HEAD=do_POST=do_PUT=do_DELETE=do_OPTIONS=handle_request


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8844)
    parser.add_argument('--data-dir',type=Path,default=ROOT/'runtime')
    args=parser.parse_args()
    PORT,DATA=args.port,args.data_dir.resolve()
    initialize()
    httpd=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    print(f'Life Fitness 本地 Demo：http://127.0.0.1:{PORT}',flush=True)
    try:httpd.serve_forever()
    except KeyboardInterrupt:pass
    finally:httpd.server_close();POOL.shutdown(wait=False,cancel_futures=True)

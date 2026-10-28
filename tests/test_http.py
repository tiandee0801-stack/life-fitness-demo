"""HTTP integration and persistence boundaries, isolated data only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('life_server',ROOT/'server.py')
app=importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

PROFILE=dict(goal='habit',experience='beginner',equipment='none',minutes=15,limitations='none',note='测试资料')
FEEDBACK=dict(coachId=None,jobId=None,perceivedEffort=4,discomfort='none',completion='partial',note='记录')

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        app.DATA=Path(cls.temp.name)
        app.initialize()
        cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        app.PORT=cls.server.server_address[1]
        cls.base=f'http://127.0.0.1:{app.PORT}'
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.temp.cleanup()

    def request(self,path,method='GET',value=None,headers=None,raw=None):
        body=raw if raw is not None else (json.dumps(value).encode() if value is not None else None)
        h={'Content-Type':'application/json'}
        h.update(headers or {})
        req=urllib.request.Request(self.base+path,data=body,method=method,headers=h)
        try:
            with urllib.request.urlopen(req,timeout=10) as response:
                b=response.read();return response.status,(json.loads(b) if b else None)
        except urllib.error.HTTPError as error:
            return error.code,json.loads(error.read())

    def setUp(self):
        self.request('/api/data','DELETE')

    def test_health_identifies_this_app(self):
        code,result=self.request('/api/health')
        self.assertEqual(code,200);self.assertEqual(result['app'],'life-fitness')

    def test_profile_roundtrip(self):
        self.assertEqual(self.request('/api/profile','PUT',PROFILE)[0],200)
        self.assertEqual(self.request('/api/state')[1]['profile']['note'],'测试资料')

    def test_bad_enum_rejected(self):
        self.assertEqual(self.request('/api/profile','PUT',{**PROFILE,'equipment':'unknown'})[0],422)

    def test_boolean_minutes_rejected(self):
        self.assertEqual(self.request('/api/profile','PUT',{**PROFILE,'minutes':True})[0],422)

    def test_external_origin_rejected(self):
        self.assertEqual(self.request('/api/profile','PUT',PROFILE,{'Origin':'https://example.org'})[0],403)

    def test_wrong_host_rejected(self):
        self.assertEqual(self.request('/api/state',headers={'Host':'example.org'})[0],403)

    def test_cross_site_write_rejected(self):
        self.assertEqual(self.request('/api/profile','PUT',PROFILE,{'Sec-Fetch-Site':'cross-site'})[0],403)

    def test_json_array_rejected(self):
        self.assertEqual(self.request('/api/profile','PUT',[])[0],400)

    def test_empty_message_rejected(self):
        self.assertEqual(self.request('/api/coach','POST',{'message':'  '})[0],422)

    def test_profile_required_before_feedback(self):
        self.assertEqual(self.request('/api/feedback','POST',FEEDBACK)[0],422)

    def test_feedback_without_video_preserves_missing(self):
        self.request('/api/profile','PUT',PROFILE)
        code,result=self.request('/api/feedback','POST',FEEDBACK)
        self.assertEqual(code,201)
        self.assertIsNone(result['session']['observation'])
        self.assertIn('没有视频识别结果',result['session']['summary'])
        self.assertEqual(len(self.request('/api/state')[1]['sessions']),1)

    def test_discomfort_marks_review(self):
        self.request('/api/profile','PUT',PROFILE)
        result=self.request('/api/feedback','POST',{**FEEDBACK,'discomfort':'yes'})[1]
        self.assertTrue(result['session']['reviewNeeded'])

    def test_unknown_coach_reference_rejected(self):
        self.request('/api/profile','PUT',PROFILE)
        self.assertEqual(self.request('/api/feedback','POST',{**FEEDBACK,'coachId':'f'*32})[0],422)

    def test_missing_video_reference_rejected(self):
        self.request('/api/profile','PUT',PROFILE)
        self.assertEqual(self.request('/api/feedback','POST',{**FEEDBACK,'jobId':'f'*32})[0],404)

    def test_malformed_linked_records_rejected(self):
        self.request('/api/profile','PUT',PROFILE)
        for key in ('jobId','coachId'):
            for value in ([],{},0,True,''):
                with self.subTest(key=key,value=value):
                    self.assertEqual(self.request('/api/feedback','POST',{**FEEDBACK,key:value})[0],422)

    def test_pending_video_cannot_be_saved_as_result(self):
        self.request('/api/profile','PUT',PROFILE)
        with app.database() as db:
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)',('a'*32,app.now(),'running','left',None,None))
        self.assertEqual(self.request('/api/feedback','POST',{**FEEDBACK,'jobId':'a'*32})[0],409)

    def test_insufficient_result_stays_null(self):
        self.request('/api/profile','PUT',PROFILE)
        result={'quality':'insufficient','count':None,'frames':[]}
        with app.database() as db:
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)',('a'*32,app.now(),'done','left',json.dumps(result),None))
        saved=self.request('/api/feedback','POST',{**FEEDBACK,'jobId':'a'*32})[1]['session']
        self.assertIsNone(saved['observation']['count'])
        self.assertIn('条件不足',saved['summary'])

    def test_zero_observation_not_missing(self):
        self.request('/api/profile','PUT',PROFILE)
        result={'quality':'usable','count':0,'frames':[]}
        with app.database() as db:
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)',('a'*32,app.now(),'done','left',json.dumps(result),None))
        saved=self.request('/api/feedback','POST',{**FEEDBACK,'jobId':'a'*32})[1]['session']
        self.assertIn('0 次',saved['summary'])

    def test_profile_snapshot_not_overwritten(self):
        self.request('/api/profile','PUT',PROFILE)
        self.request('/api/feedback','POST',FEEDBACK)
        self.request('/api/profile','PUT',{**PROFILE,'equipment':'dumbbell'})
        self.assertEqual(self.request('/api/state')[1]['sessions'][0]['profileSnapshot']['equipment'],'none')

    def test_restriction_update_cannot_be_bypassed_by_old_chat(self):
        self.request('/api/profile','PUT',{**PROFILE,'limitations':'needs_review'})
        with app.database() as db:
            db.execute('INSERT INTO chats VALUES (?,?,?,?,?)',('a'*32,app.now(),'old',json.dumps({'text':'old'}),json.dumps(PROFILE)))
        saved=self.request('/api/feedback','POST',{**FEEDBACK,'coachId':'a'*32})[1]['session']
        self.assertTrue(saved['reviewNeeded'])

    def test_json_export_matches_records(self):
        self.request('/api/profile','PUT',PROFILE)
        self.request('/api/feedback','POST',FEEDBACK)
        export=self.request('/api/export')[1]
        self.assertEqual(len(export['sessions']),1)
        self.assertEqual(export['profile']['goal'],'habit')

    def test_export_includes_unlinked_video_analysis(self):
        with app.database() as db:
            db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?)',('a'*32,app.now(),'done','left',json.dumps({'count':0,'quality':'usable'}),None))
        export=self.request('/api/export')[1]
        self.assertEqual(export['sessions'],[])
        self.assertEqual(export['videoJobs'][0]['result']['count'],0)
        self.assertIn('不含视频文件',export['mediaNote'])

    def test_delete_only_app_data(self):
        outside=Path(self.temp.name).parent/'life-fitness-untouched-test.txt'
        outside.write_text('keep')
        try:
            self.request('/api/profile','PUT',PROFILE)
            self.request('/api/data','DELETE')
            self.assertIsNone(self.request('/api/state')[1]['profile'])
            self.assertTrue(outside.exists())
        finally:outside.unlink(missing_ok=True)

    def test_invalid_side(self):
        self.assertEqual(self.request('/api/video?side=wrong','POST',raw=b'x',headers={'Content-Type':'video/mp4'})[0],422)

    def test_nonvideo_body(self):
        self.assertEqual(self.request('/api/video?side=left','POST',raw=b'x')[0],415)

    def test_path_traversal(self):
        self.assertEqual(self.request('/%2e%2e/server.py')[0],403)

    def test_job_traversal(self):
        self.assertEqual(self.request('/api/jobs/..%2fserver.py')[0],404)

    def test_clear_while_busy_rejected(self):
        app.VISION_LOCK.acquire()
        try:self.assertEqual(self.request('/api/data','DELETE')[0],409)
        finally:app.VISION_LOCK.release()

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(ApiTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report={'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
            'passed':result.wasSuccessful(),'scope':'isolated HTTP/persistence tests; no model accuracy assertion'}
    (ROOT/'artifacts/http-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)

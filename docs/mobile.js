(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const PREFIX = 'lifeFitnessMobile.';
  const state = {
    profile: null, sessions: [], chats: [], profileDirty: false, coachId: null, task: null, initialLoading: true,
    chatBusy: false, profileBusy: false, feedbackBusy: false, clearing: false,
    file: null, blobUrl: null, result: null, jobId: null, jobStatus: null,
    pollTimer: null, toastTimer: null, animationId: null, capture: null,
    cameraPending: false, captureNonce: 0, replayStarted: false, tab: 'train',
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selectedDate: null, weeklyGoal: null, overlay: true, jobEpoch: 0
  };
  const labels = {
    goal: {habit:'建立训练习惯', strength:'基础力量训练', learn:'了解与观察动作'},
    completion: {completed:'已完成训练', partial:'完成部分训练', not_started:'尚未开始'},
    side: {left:'身体左侧', right:'身体右侧'}
  };
  const setText = (element, value) => { if (element) element.textContent = value == null ? '' : String(value); };
  const storage = {
    get(key) { try { return localStorage.getItem(PREFIX + key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(PREFIX + key, String(value)); } catch {} },
    remove(key) { try { localStorage.removeItem(PREFIX + key); } catch {} },
    clear() { try { Object.keys(localStorage).filter(key => key.startsWith(PREFIX)).forEach(key => localStorage.removeItem(key)); } catch {} }
  };
  const safeUrl = value => { try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
  const jsonOptions = (method, body) => ({method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const busyVideo = () => ['queued', 'running'].includes(state.jobStatus);
  const validCount = result => result?.quality === 'usable' && Number.isFinite(result.count) && result.count >= 0;
  const localDate = value => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  };
  function element(tag, className, content) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (content != null) setText(node, content); return node;
  }
  async function api(path, options = {}) {
    if (window.LFShowcase) return window.LFShowcase.api(path, options);
    const response = await fetch(path, options);
    let data; try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求未完成（${response.status}）`);
    return data;
  }
  function toast(message) {
    setText($('toast'), message); $('toast').hidden = false;
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => $('toast').hidden = true, 4800);
  }
  function status(message, error = false) {
    setText($('video-status'), message); $('video-status').classList.toggle('error', error);
  }
  function showTab(name, focus = false) {
    if (!['train','history','goals','settings'].includes(name)) name = 'train';
    if (name !== 'train') stopRecording(true);
    state.tab = name;
    ['train','history','goals','settings'].forEach(tab => $('view-'+tab).hidden = tab !== name);
    document.querySelectorAll('[data-tab]').forEach(button => {
      const active = button.dataset.tab === name; button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    if (location.hash !== '#'+name) history.replaceState(null, '', '#'+name);
    window.scrollTo({top:0, behavior:'instant'});
    if (name === 'history') renderHistory();
    if (name === 'train') requestAnimationFrame(drawOverlay);
    if (focus) { const title = $('view-'+name).querySelector('h1, h2'); if (title) { title.tabIndex=-1; title.focus({preventScroll:true}); } }
  }
  function updateControls() {
    const locked = busyVideo() || state.clearing;
    const filming = !!state.capture || state.cameraPending;
    $('upload-open').disabled = locked || filming;
    $('video-input').disabled = locked || filming;
    $('side-select').disabled = locked || filming;
    $('record-toggle').disabled = locked || state.cameraPending;
    $('analyze-video').disabled = !!window.LFShowcase || locked || filming || !state.file;
    $('feedback-open').disabled = locked || filming || (!state.result && !state.coachId);
    $('profile-save').disabled = state.initialLoading || state.profileBusy || state.clearing;
    $('coach-send').disabled = state.initialLoading || state.chatBusy || state.clearing;
    $('feedback-save').disabled = state.initialLoading || locked || state.feedbackBusy;
    $('clear-data').disabled = state.initialLoading || locked || state.chatBusy || state.profileBusy || state.feedbackBusy || filming;
    $('record-toggle').classList.toggle('recording', !!state.capture);
    $('record-toggle').setAttribute('aria-label', state.capture ? '停止录制并预览视频' : '拍摄一段视频，录制后分析');
    $('record-toggle').setAttribute('aria-pressed', state.capture ? 'true' : 'false');
    $('video-stage').classList.toggle('recording', !!state.capture);
  }
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]'); if (tab) showTab(tab.dataset.tab, true);
    const prompt = event.target.closest('[data-prompt]');
    if (prompt && !state.chatBusy) { $('coach-message').value = prompt.dataset.prompt; sendChat(prompt.dataset.prompt); }
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  function populateProfile(profile) {
    if (!profile) return;
    const form = $('profile-form');
    ['goal','experience','equipment','minutes','limitations','note'].forEach(key => {
      if (form.elements[key] && profile[key] != null) form.elements[key].value = String(profile[key]);
    });
  }
  $('profile-form').addEventListener('input', () => {
    state.profileDirty = true; setText($('profile-status'), '有未保存的修改，保存后用于下一次 Coach 对话。');
    renderTask(null);
  });
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.initialLoading || state.profileBusy || state.clearing) return;
    const form = event.currentTarget;
    const profile = {goal:form.elements.goal.value, experience:form.elements.experience.value,
      equipment:form.elements.equipment.value, minutes:Number(form.elements.minutes.value),
      limitations:form.elements.limitations.value, note:form.elements.note.value.trim()};
    state.profileBusy = true; $('profile-save').disabled = true; updateControls();
    setText($('profile-status'), '正在保存训练档案…');
    try {
      const data = await api('/api/profile', jsonOptions('PUT', profile));
      state.profile = data.profile; state.profileDirty = false;
      setText($('profile-status'), '档案已保存在此浏览器。可以返回训练页，与 Coach 对话。');
      setText($('chat-list').querySelector('.empty-state'), '档案已保存。可以和 Coach 讨论一次居家训练；它不会自动读取视频结果。');
      if (!$('coach-message').value) $('coach-message').value = '请结合我保存的条件，帮我开始一次居家训练，并说明如何做弯举动作观察。';
      toast('训练档案已保存');
    } catch (error) { setText($('profile-status'), '保存失败：'+error.message); }
    finally { state.profileBusy=false; $('profile-save').disabled=false; updateControls(); }
  });

  function addChat(role, content, extra = {}) {
    $('chat-list').querySelector('.empty-state')?.remove();
    const node = element('article', 'chat-message '+role);
    node.append(element('div','chat-label', role === 'user' ? '你' : role === 'error' ? '本次请求未完成' : 'Coach 示例'));
    node.append(element('div','chat-body', content));
    if (extra.mode) {
      const seconds = Number.isFinite(extra.latencyMs) ? ` · ${(extra.latencyMs/1000).toFixed(1)} 秒` : '';
      node.append(element('div','chat-meta', (extra.mode === 'example' ? '预设讲解 · 未调用 AI 模型' : extra.mode === 'local-model' ? '本地模型回答' : '范围与边界提示 · 规则判断') + seconds));
    }
    if (Array.isArray(extra.sources)) {
      const sources = element('div','chat-sources');
      extra.sources.forEach(source => { const href=safeUrl(source.url); if (!href) return;
        const link=element('a','source-link', source.title || '查看资料来源'); link.href=href; link.target='_blank'; link.rel='noopener noreferrer'; sources.append(link); });
      if (sources.children.length) node.append(sources);
    }
    $('chat-list').append(node); $('chat-list').scrollTop=$('chat-list').scrollHeight;
    return node;
  }
  function renderTask(task) {
    state.task=task || null; $('coach-task').hidden=!task;
    $('coach-task').querySelector('.task-copy')?.remove();
    if (!task) return;
    const content=element('div','task-copy'); content.append(element('strong','',task.title || '弯举动作观察'));
    [...(task.instructions || []), ...(task.capture || [])].forEach(line => content.append(element('p','task-line',line)));
    $('coach-task').insertBefore(content, $('coach-task-train'));
  }
  function renderChats() {
    $('chat-list').replaceChildren(); state.coachId=null; state.task=null;
    if (!state.chats.length) $('chat-list').append(element('div','empty-state',state.profile?'档案已保存。可以和 Coach 讨论一次居家训练；它不会自动读取视频结果。':'先保存训练档案，再和 Coach 讨论一次居家训练。Coach 不会自动读取视频结果。'));
    state.chats.slice(-12).forEach(item => {
      if (item.message) addChat('user',item.message);
      const response=item.response;
      if (response?.text) { addChat('assistant',response.text,response); state.coachId=response.id || item.id; state.task=response.task || null; }
    });
    renderTask(state.task); updateControls();
  }
  $('coach-open').addEventListener('click', () => {
    stopRecording(true); $('coach-dialog').showModal();
    if (state.profile && !state.profileDirty) $('coach-message').focus();
  });
  $('coach-close').addEventListener('click', () => $('coach-dialog').close());
  $('coach-task-train').addEventListener('click', () => { $('coach-dialog').close(); showTab('train',true); $('upload-open').focus(); });
  async function sendChat(message) {
    message=String(message || '').trim(); if (!message || state.chatBusy || state.clearing) return;
    if (state.initialLoading) { toast('正在载入此浏览器档案，请稍候再开始对话。'); return; }
    if (!state.profile || state.profileDirty) {
      $('coach-dialog').close(); showTab('goals',true);
      toast(state.profile ? '训练档案有修改，请先保存。' : '先保存你的训练档案，Coach 才能使用这些条件。'); $('profile-form').scrollIntoView({block:'start'}); return;
    }
    state.chatBusy=true; $('coach-send').disabled=true; updateControls();
    setText($('coach-status'),'正在此浏览器生成回答，首次加载可能稍久…');
    addChat('user',message); $('coach-message').value=''; const pending=addChat('assistant','正在生成…');
    try {
      const response=await api('/api/coach',jsonOptions('POST',{message})); pending.remove();
      addChat('assistant',response.text || '本次未返回可展示的内容。',response);
      state.coachId=response.id || null; renderTask(response.task || null);
      setText($('coach-status'), response.mode === 'example' ? '这是预设流程讲解；真实模型问答请运行仓库中的本地版。' : '已显示范围与边界提示。');
    } catch (error) {
      pending.remove(); addChat('error',error.message+'\n本次没有生成有效建议，可以稍后重试。');
      setText($('coach-status'),'本次回答未完成，未使用示例内容替代。');
    } finally { state.chatBusy=false; $('coach-send').disabled=false; updateControls(); }
  }
  $('coach-form').addEventListener('submit', event => { event.preventDefault(); sendChat($('coach-message').value); });
  $('coach-message').addEventListener('keydown',event => {
    if (event.key==='Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(event.currentTarget.value); }
  });

  function releaseBlob() { if (state.blobUrl) URL.revokeObjectURL(state.blobUrl); state.blobUrl=null; }
  function resetResult() {
    state.jobEpoch++; clearTimeout(state.pollTimer); state.result=null; state.jobId=null; state.jobStatus=null; state.replayStarted=false;
    storage.remove('lastJob'); $('progress-bar').hidden=true; $('pose-canvas').hidden=true;
    setText($('live-count'),'—'); setText($('count-label'),'等待动作观察'); setText($('result-summary'),'');
    drawOverlay(); updateControls();
  }
  function selectFile(file, name) {
    if (!file || busyVideo()) return;
    resetResult(); state.file=null; releaseBlob();
    const video=$('training-video'); video.pause(); video.srcObject=null; video.muted=false; video.controls=true;
    video.removeAttribute('src'); video.load();
    $('video-placeholder').hidden=false; video.hidden=true;
    if (file.size > 60*1024*1024) { status('视频超过 60 MiB，请选择更短或压缩后的视频。',true); updateControls(); return; }
    if (!file.size) { status('这段视频没有可读取的内容，请重新选择。',true); updateControls(); return; }
    state.file=file; state.blobUrl=URL.createObjectURL(file); video.src=state.blobUrl; video.hidden=false;
    $('video-placeholder').hidden=true; setText($('record-time'),'');
    status('视频仅在当前浏览器预览，不上传。此展示版不分析自选视频，请运行本地版使用真实识别。');
    updateControls();
  }
  $('upload-open').addEventListener('click', () => { if (!busyVideo() && !state.capture) $('video-input').click(); });
  $('video-input').addEventListener('change', event => {
    const file=event.currentTarget.files?.[0]; if (file) selectFile(file); event.currentTarget.value='';
  });
  $('side-select').addEventListener('change', () => {
    if (state.result) {
      status(`回放仍是${labels.side[state.result.side]}的分析；重新分析视频后才会使用新选择。`);
    }
  });
  $('training-video').addEventListener('loadedmetadata', () => {
    const video=$('training-video');
    if (state.file && !state.result && Number.isFinite(video.duration) && video.duration>45.001) {
      status('视频最长支持 45 秒，请剪短后重新选择。',true); $('analyze-video').disabled=true;
    }
    drawOverlay();
  });
  $('training-video').addEventListener('error', () => {
    if (state.file && !state.result) status('浏览器暂时无法预览这段视频。仍可提交分析；若服务也无法解码，请换成 MP4。',true);
  });
  async function startRecording() {
    if (busyVideo() || state.cameraPending || state.capture) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('当前浏览器不支持页面内录制，请拍摄后从“导入视频”选择文件。'); return;
    }
    const nonce=++state.captureNonce; state.cameraPending=true; updateControls();
    status('等待摄像头授权。仅录制画面，不使用麦克风；停止录制后才可分析。');
    let stream;
    try {
      stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:720},height:{ideal:1280},facingMode:'user'},audio:false});
      if (nonce!==state.captureNonce || state.tab!=='train') { stream.getTracks().forEach(track=>track.stop()); return; }
      const types=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm'];
      const mimeType=types.find(type=>MediaRecorder.isTypeSupported(type));
      const recorder=new MediaRecorder(stream,mimeType ? {mimeType,videoBitsPerSecond:2500000} : undefined);
      resetResult(); state.file=null; releaseBlob();
      const video=$('training-video'); video.pause(); video.removeAttribute('src'); video.srcObject=stream; video.hidden=false; video.muted=true; video.controls=false;
      $('video-placeholder').hidden=true;
      const capture={stream,recorder,chunks:[],started:performance.now(),timer:null,discard:false,stopped:false};
      state.capture=capture; state.cameraPending=false; updateControls();
      recorder.addEventListener('dataavailable', event => { if (event.data.size) capture.chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        capture.discard=true; stopRecording(true); status('录制未完成，摄像头已关闭。请重新录制或导入视频。',true);
      });
      recorder.addEventListener('stop', () => {
        clearInterval(capture.timer); capture.stream.getTracks().forEach(track=>track.stop());
        if (state.capture===capture) state.capture=null;
        if (video.srcObject===capture.stream) { video.pause(); video.srcObject=null; video.muted=false; video.controls=true; }
        updateControls();
        if (capture.discard) { capture.chunks=[]; video.hidden=true; $('video-placeholder').hidden=false; setText($('record-time'),''); return; }
        const blob=new Blob(capture.chunks,{type:recorder.mimeType || mimeType || 'video/webm'}); capture.chunks=[];
        const extension=blob.type.includes('mp4')?'mp4':'webm';
        selectFile(blob,`刚刚录制的弯举视频.${extension}`);
        toast('录制已结束，摄像头已关闭。点击“分析视频”开始观察。');
      });
      recorder.start(500);
      capture.timer=setInterval(() => {
        const elapsed=(performance.now()-capture.started)/1000;
        setText($('record-time'),`${Math.floor(elapsed)} 秒 / 最长约 45 秒`);
        if (elapsed>=44) stopRecording(false);
      },200);
      setText($('live-count'),'—'); setText($('count-label'),'录制中 · 尚未分析');
      status('正在录制。让一个人的肩、肘、手腕完整入镜；按红色按钮停止，然后手动分析。');
      video.play().catch(() => {});
    } catch (error) {
      stream?.getTracks().forEach(track=>track.stop());
      if (nonce===state.captureNonce && state.capture) stopRecording(true);
      if (nonce===state.captureNonce) status(error.name==='NotAllowedError' ? '未获得摄像头权限。可以在浏览器中允许，或直接导入已经拍摄的视频。' : '无法开启摄像头：'+error.message,true);
    } finally { if (nonce===state.captureNonce) state.cameraPending=false; updateControls(); }
  }
  function stopRecording(discard=false) {
    if (state.cameraPending) { state.captureNonce++; state.cameraPending=false; }
    const capture=state.capture;
    if (!capture) { updateControls(); return; }
    capture.discard = capture.discard || discard;
    clearInterval(capture.timer);
    if (capture.recorder.state!=='inactive' && !capture.stopped) { capture.stopped=true; capture.recorder.stop(); }
    else if (capture.recorder.state==='inactive' && !capture.stopped) {
      // start() can fail before any stop event exists. Release the UI as well.
      capture.discard=true;capture.chunks=[];state.capture=null;
      const video=$('training-video');
      if(video.srcObject===capture.stream){video.pause();video.srcObject=null;video.muted=false;video.controls=true;video.hidden=true;$('video-placeholder').hidden=false;}
      setText($('record-time'),'');
    }
    capture.stream.getTracks().forEach(track=>track.stop());
    if (discard) status('录制已取消，摄像头已关闭。可重新录制或导入视频。');
    updateControls();
  }
  $('record-toggle').addEventListener('click', () => { if (state.capture) stopRecording(false); else startRecording(); });

  $('analyze-video').addEventListener('click', async () => {
    if (!state.file || busyVideo() || state.capture || state.cameraPending) return;
    const video=$('training-video');
    if (Number.isFinite(video.duration) && video.duration>45.001) { status('视频最长支持 45 秒，请剪短后重新选择。',true); return; }
    resetResult(); state.jobStatus='queued'; updateControls(); video.pause();
    $('progress-bar').hidden=false; $('progress-bar').value=0; status('正在提交视频…');
    try {
      const job=await api('/api/video?side='+encodeURIComponent($('side-select').value),{method:'POST',headers:{'Content-Type':state.file.type || 'application/octet-stream'},body:state.file});
      if (!job.jobId) throw new Error('服务没有返回任务编号，请重试。');
      state.jobId=job.jobId; storage.set('lastJob',job.jobId); pollJob(state.jobEpoch);
    } catch (error) { state.jobStatus='error'; $('progress-bar').hidden=true; status('分析没有开始：'+error.message,true); updateControls(); }
  });
  async function pollJob(epoch) {
    if (epoch!==state.jobEpoch || !state.jobId) return;
    try {
      const job=await api('/api/jobs/'+encodeURIComponent(state.jobId));
      if (epoch!==state.jobEpoch) return;
      state.jobStatus=job.status;
      $('progress-bar').hidden=false; $('progress-bar').value=Math.min(100,Math.max(0,Number(job.progress)||0));
      status(job.status==='queued'?'视频已提交，等待此浏览器分析…':`正在观察动作 · ${Math.round(Number(job.progress)||0)}%`);
      if (job.status==='done') {
        if (!job.result) throw new Error('任务已结束，但没有可展示的结果。');
        state.result=job.result; renderResult(job.result); toast('样例已载入，可回放并保存示例反馈。');
      } else if (job.status==='error') throw new Error(job.error || '视频未能完成分析。');
      else if (['queued','running'].includes(job.status)) state.pollTimer=setTimeout(()=>pollJob(epoch),1250);
      else throw new Error('服务返回了无法识别的任务状态。');
    } catch (error) {
      if (epoch!==state.jobEpoch) return;
      state.jobStatus='error'; $('progress-bar').hidden=true; status('分析未完成：'+error.message,true);
    } finally { updateControls(); }
  }
  function renderResult(result) {
    state.replayStarted=false; $('progress-bar').hidden=true;
    $('side-select').value=result.side==='right'?'right':'left';
    const usable=validCount(result);
    setText($('live-count'),usable?result.count:'—'); setText($('count-label'),usable?'预设样例周期 · 次':'无法可靠计数');
    const summary=(result.summary || '请结合原始视频查看观察结果。')+(usable?` 样例预设 ${result.count} 次完整周期。`:' 不提供估计次数。');
    setText($('result-summary'),summary+(Array.isArray(result.limitations)&&result.limitations.length?' '+result.limitations.join(' '):''));
    status(`${labels.side[result.side] || '目标手臂'} · ${Number(result.duration||0).toFixed(1)} 秒 · ${usable?'预设样例已载入，非 AI 识别结果':'可观察信息不足，请检查拍摄条件'}`);
    const video=$('training-video'),href=safeUrl(result.sourceUrl);
    if (href && new URL(href).origin===location.origin) {
      video.pause(); video.srcObject=null; video.muted=false; video.controls=true;
      video.src=href; video.hidden=false; $('video-placeholder').hidden=true; releaseBlob();
    }
    $('pose-canvas').hidden=!state.overlay; drawOverlay(); updateControls();
  }
  const edges=[[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
  function currentFrame(time) {
    const frames=state.result?.frames; if (!Array.isArray(frames)||!frames.length) return null;
    let low=0,high=frames.length-1;
    while(low<high) { const mid=Math.ceil((low+high)/2); if(Number(frames[mid].t)<=time)low=mid;else high=mid-1; }
    return Math.abs(Number(frames[low].t)-time)<=.75?frames[low]:null;
  }
  function drawOverlay() {
    const canvas=$('pose-canvas'),video=$('training-video'),stage=$('video-stage'),ctx=canvas.getContext('2d');
    if (!ctx) return;
    const rect=stage.getBoundingClientRect(); if (!rect.width||!rect.height) return;
    const dpr=Math.min(window.devicePixelRatio||1,3),width=rect.width,height=rect.height;
    if (canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)) { canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr); }
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    if (!state.result) return;
    const frame=currentFrame(video.currentTime);
    if (!validCount(state.result)) { setText($('live-count'),'—');setText($('count-label'),'无法可靠计数'); }
    else if (state.replayStarted) {
      const count=video.ended?state.result.count:frame?.count;
      setText($('live-count'),Number.isFinite(count)?count:'—');setText($('count-label'),video.ended?'样例完整周期 · 次':'样例回放周期 · 次');
    }
    if (!state.overlay||!frame) return;
    const vw=Number(state.result.width)||video.videoWidth||width,vh=Number(state.result.height)||video.videoHeight||height;
    const ratio=Math.min(width/vw,height/vh),rw=vw*ratio,rh=vh*ratio,ox=(width-rw)/2,oy=(height-rh)/2;
    const points=frame.points||[],target=state.result.side==='right'?[6,8,10]:[5,7,9];
    const good=p=>Array.isArray(p)&&p.length>=3&&Number(p[2])>=.3&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]));
    const xy=p=>[ox+Number(p[0])*rw,oy+Number(p[1])*rh];
    edges.forEach(([a,b])=>{if(!good(points[a])||!good(points[b]))return;ctx.beginPath();ctx.moveTo(...xy(points[a]));ctx.lineTo(...xy(points[b]));ctx.strokeStyle=target.includes(a)&&target.includes(b)?'#d9ff3f':'#a7ff4bcc';ctx.lineWidth=target.includes(a)&&target.includes(b)?3.8:2.2;ctx.stroke();});
    points.forEach((point,index)=>{if(!good(point))return;ctx.beginPath();ctx.arc(...xy(point),target.includes(index)?4.6:3,0,Math.PI*2);ctx.fillStyle='#dcff51';ctx.strokeStyle='#111';ctx.lineWidth=1;ctx.fill();ctx.stroke();});
  }
  function animateVideo() { drawOverlay(); if(!$('training-video').paused&&!$('training-video').ended)state.animationId=requestAnimationFrame(animateVideo); }
  $('training-video').addEventListener('play',()=>{if(state.result)state.replayStarted=true;cancelAnimationFrame(state.animationId);animateVideo();});
  ['pause','seeked','timeupdate','loadeddata','ended'].forEach(name=>$('training-video').addEventListener(name,drawOverlay));
  $('training-video').addEventListener('seeking',()=>{if(state.result)state.replayStarted=true;});
  $('overlay-toggle').addEventListener('change',()=>{state.overlay=$('overlay-toggle').checked;storage.set('overlay',state.overlay);$('pose-canvas').hidden=!state.overlay||!state.result;drawOverlay();});
  if(window.ResizeObserver)new ResizeObserver(drawOverlay).observe($('video-stage'));else window.addEventListener('resize',drawOverlay);

  $('feedback-open').addEventListener('click',()=>{
    if(busyVideo())return;
    if(!state.profile||state.profileDirty){showTab('goals',true);toast('先保存训练档案，再记录这次反馈。');$('profile-form').scrollIntoView({block:'start'});return;}
    $('feedback-dialog').showModal();
  });
  $('feedback-close').addEventListener('click',()=>$('feedback-dialog').close());
  $('feedback-form').elements.perceivedEffort.addEventListener('input',event=>setText($('effort-value'),`${event.currentTarget.value} / 10`));
  $('feedback-form').addEventListener('submit',async event=>{
    event.preventDefault();if(state.initialLoading||state.feedbackBusy||busyVideo()||state.clearing)return;
    if(!state.profile){toast('请先保存训练档案。');return;}
    const form=event.currentTarget;
    const payload={coachId:state.coachId||null,jobId:state.jobStatus==='done'?state.jobId:null,
      perceivedEffort:Number(form.elements.perceivedEffort.value),discomfort:form.elements.discomfort.value,
      completion:form.elements.completion.value,note:form.elements.note.value.trim()};
    state.feedbackBusy=true;updateControls();
    try{
      const response=await api('/api/feedback',jsonOptions('POST',payload));
      if(response.session)state.sessions.unshift(response.session);else await loadState(false);
      const now=new Date();state.month=new Date(now.getFullYear(),now.getMonth(),1);state.selectedDate=localDate(now);
      $('feedback-dialog').close();form.reset();setText($('effort-value'),'5 / 10');renderHistory();showTab('history',true);toast('练后反馈已保存在此浏览器');
    }catch(error){toast('保存失败：'+error.message);}
    finally{state.feedbackBusy=false;updateControls();}
  });

  function weekDates() {
    const today=new Date(),monday=new Date(today.getFullYear(),today.getMonth(),today.getDate());
    monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
    return Array.from({length:7},(_,index)=>{const date=new Date(monday);date.setDate(monday.getDate()+index);return date;});
  }
  function trainedDates() {
    return new Set(state.sessions.filter(session=>['completed','partial'].includes(session.feedback?.completion)).map(session=>localDate(session.createdAt)).filter(Boolean));
  }
  function renderGoals() {
    const days=weekDates(),trained=trainedDates(),count=days.filter(day=>trained.has(localDate(day))).length,goal=state.weeklyGoal;
    setText($('goal-ring-text'),goal?`${count}/${goal}`:String(count));
    setText($('goal-week-label'),goal?`本周已记录 ${count} 天训练 · 自主目标 ${goal} 天`:`本周已记录 ${count} 天训练 · 选择你的自主目标`);
    const ring=$('goal-ring-text').closest('.goal-ring');if(ring)ring.style.setProperty('--progress',`${goal?Math.min(count/goal,1)*360:0}deg`);
    setText($('week-progress'),goal?`${count} / ${goal} 天`:`${count} 天 · 目标未设置`);
    $('goal-week-dots').replaceChildren();
    days.forEach((day,index)=>{const node=element('div','week-dot'+(trained.has(localDate(day))?' active':''));node.append(element('span','','一二三四五六日'[index]),element('b','',day.getDate()));node.title=localDate(day)+(trained.has(localDate(day))?' · 已记录训练':' · 暂无训练记录');$('goal-week-dots').append(node);});
    $('weekly-goal-options').querySelectorAll('[data-days]').forEach(button=>{const active=Number(button.dataset.days)===goal;button.classList.toggle('active',active);button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  }
  $('weekly-goal-options').addEventListener('click',event=>{
    const button=event.target.closest('[data-days]');if(!button)return;
    const days=Number(button.dataset.days);if(!Number.isInteger(days)||days<1||days>7)return;
    state.weeklyGoal=days;storage.set('weeklyGoal',days);renderGoals();toast(`已设置每周 ${days} 天的自主记录目标`);
  });
  function renderCalendar() {
    const year=state.month.getFullYear(),month=state.month.getMonth(),dates=new Set(state.sessions.map(session=>localDate(session.createdAt)).filter(Boolean)),today=localDate(new Date());
    setText($('month-title'),`${year} 年 ${month+1} 月`);const grid=$('calendar-grid');grid.replaceChildren();
    '一二三四五六日'.split('').forEach(day=>grid.append(element('span','calendar-weekday',day)));
    const first=(new Date(year,month,1).getDay()+6)%7,last=new Date(year,month+1,0).getDate();
    for(let i=0;i<first;i++){const spacer=element('span','calendar-spacer');spacer.setAttribute('aria-hidden','true');grid.append(spacer);}
    for(let day=1;day<=last;day++){
      const date=localDate(new Date(year,month,day)),button=element('button','calendar-day',day);button.type='button';
      button.classList.toggle('today',date===today);button.classList.toggle('has-record',dates.has(date));button.classList.toggle('selected',date===state.selectedDate);
      button.setAttribute('aria-label',`${month+1}月${day}日${dates.has(date)?'，有训练记录':''}`);button.setAttribute('aria-pressed',String(date===state.selectedDate));
      button.addEventListener('click',()=>{state.selectedDate=state.selectedDate===date?null:date;renderHistory();});grid.append(button);
    }
    const monthly=state.sessions.filter(session=>{const date=new Date(session.createdAt);return date.getFullYear()===year&&date.getMonth()===month;});
    const trainingDays=new Set(monthly.filter(session=>['completed','partial'].includes(session.feedback?.completion)).map(session=>localDate(session.createdAt)));
    setText($('month-days'),trainingDays.size);setText($('month-records'),monthly.length);
    const unique=new Map();monthly.forEach(session=>{if(session.jobId&&session.observation)unique.set(session.jobId,session.observation);});
    let cycles=0,known=0,unknown=0;unique.forEach(result=>{if(validCount(result)){cycles+=result.count;known++;}else unknown++;});
    setText($('month-cycles'),known?cycles:'—');$('month-cycles').title=known?`按 ${known} 段可用视频去重统计${unknown?`；另有 ${unknown} 段无法可靠计数`:''}`:'本月暂无可用视频计数，未测量不计为零';
    return monthly;
  }
  function renderHistory() {
    const monthly=renderCalendar();renderGoals();const list=$('history-list');list.replaceChildren();
    setText($('history-date'),state.selectedDate?`${state.selectedDate.replaceAll('-',' / ')} 的记录`:'本月训练记录');
    const rows=monthly.filter(session=>!state.selectedDate||localDate(session.createdAt)===state.selectedDate).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    if(!rows.length){list.append(element('div','empty-state',state.selectedDate?'这一天还没有记录。完成一次观察后，可以保存练后反馈。':'本月还没有记录。每一次真实反馈，都会在这里留下记录。'));return;}
    rows.forEach(session=>{
      const feedback=session.feedback||{},date=new Date(session.createdAt),card=element('article','history-card');
      const head=element('div','history-card-head');head.append(element('strong','', '示例反馈 · '+(labels.completion[feedback.completion]||'记录')),element('span','',date.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})+' '+date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})));card.append(head);
      const observation=session.observation;const countText=session.jobId?(validCount(observation)?`可见完整周期 ${observation.count} 次`:'无法可靠计数'):'未测量动作次数';
      card.append(element('p','history-meta',`${countText} · 主观用力 ${feedback.perceivedEffort??'—'}/10`));
      card.append(element('p','history-meta',feedback.discomfort==='yes'?'反馈有不适 · 需要关注':'未反馈不适'));
      if(feedback.note)card.append(element('p','history-note',feedback.note));
      if(session.jobId){const button=element('button','text-button','回看视频观察 ↗');button.type='button';button.addEventListener('click',()=>replaySession(session.jobId));card.append(button);}
      list.append(card);
    });
  }
  async function replaySession(jobId) {
    if(busyVideo()||state.capture||state.cameraPending){toast('请先结束当前视频任务。');return;}
    try{
      const job=await api('/api/jobs/'+encodeURIComponent(jobId));if(job.status!=='done'||!job.result)throw new Error('这条记录暂时没有可回看的完整视频结果。');
      resetResult();state.jobId=jobId;state.jobStatus='done';state.result=job.result;state.file=null;storage.set('lastJob',jobId);
      $('side-select').value=job.result.side==='right'?'right':'left';renderResult(job.result);showTab('train',true);
    }catch(error){toast(error.message);}
  }
  $('month-prev').addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1);state.selectedDate=null;renderHistory();});
  $('month-next').addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1);state.selectedDate=null;renderHistory();});

  $('export-data').addEventListener('click',()=>{const link=document.createElement('a');link.href=window.LFShowcase.exportUrl();link.download='LifeFitness-此浏览器记录.json';document.body.append(link);link.click();link.remove();toast('正在导出记录 JSON，不包含视频文件。');});
  $('clear-data').addEventListener('click',async()=>{
    if(state.initialLoading||busyVideo()||state.chatBusy||state.profileBusy||state.feedbackBusy||state.capture||state.cameraPending||state.clearing){toast('请先等待当前请求或录制结束。');return;}
    if(!window.confirm('确定清空这个 Life Fitness Demo 的档案、对话、训练记录和上传视频吗？导出的 JSON 不包含视频文件，请先保留自己的原始视频。此操作无法撤销，不会删除其他项目的数据。'))return;
    state.clearing=true;updateControls();
    try{
      await api('/api/data',{method:'DELETE'});storage.clear();resetResult();stopRecording(true);releaseBlob();
      state.profile=null;state.sessions=[];state.chats=[];state.coachId=null;state.file=null;state.profileDirty=false;state.weeklyGoal=null;state.overlay=true;
      state.month=new Date(new Date().getFullYear(),new Date().getMonth(),1);state.selectedDate=null;
      $('profile-form').reset();$('feedback-form').reset();$('overlay-toggle').checked=true;
      const video=$('training-video');video.pause();video.srcObject=null;video.removeAttribute('src');video.load();video.hidden=true;$('video-placeholder').hidden=false;
      setText($('profile-status'),'尚未保存训练档案');setText($('record-time'),'');setText($('effort-value'),'5 / 10');
      renderChats();renderHistory();status('导入或拍摄一段弯举视频，开始动作观察。');showTab('train',true);toast('本 Demo 的数据已清空');
    }catch(error){toast('未能清空：'+error.message);}
    finally{state.clearing=false;updateControls();}
  });
  ['coach-dialog','feedback-dialog'].forEach(id=>$(id).addEventListener('click',event=>{
    if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.currentTarget.close();
  }));
  async function loadState(includeChats=true) {
    const data=await api('/api/state');state.profile=data.profile||null;state.sessions=Array.isArray(data.sessions)?data.sessions:[];state.chats=Array.isArray(data.chats)?data.chats:[];
    if(state.profile&&!state.profileDirty){populateProfile(state.profile);setText($('profile-status'),'已载入此浏览器档案，可按实际情况修改并保存。');}
    renderHistory();if(includeChats)renderChats();
  }
  async function health() {
    if(window.LFShowcase){status('在线展示版：自己的视频仅预览，流程样例为预设动画。');setText($('coach-status'),'预设流程讲解 · 未连接 AI 模型');return;}
    try{
      const result=await api('/api/health');
      if(!result.coach?.available)setText($('coach-status'),'本地模型组件暂不可用。请求失败时会明确说明。');
      if(!result.vision?.available)status('本地动作识别组件暂不可用，请先确认已通过启动脚本打开。',true);
    }catch{toast('无法连接此浏览器服务，请通过 Life Fitness 启动脚本打开。');}
  }
  async function restoreJob() {
    if(state.initialLoading||state.clearing||state.file||state.capture||state.cameraPending||state.jobStatus)return;
    const id=storage.get('lastJob');if(!id||!/^[a-f0-9]{32}$/.test(id))return;
    state.jobId=id;state.jobStatus='queued';updateControls();await pollJob(state.jobEpoch);
  }
  const savedGoal=Number(storage.get('weeklyGoal'));if(Number.isInteger(savedGoal)&&savedGoal>=1&&savedGoal<=7)state.weeklyGoal=savedGoal;
  state.overlay=storage.get('overlay')!=='false';$('overlay-toggle').checked=state.overlay;
  showTab(location.hash.slice(1)||'train');renderHistory();updateControls();
  health();
  loadState().catch(error=>toast('此浏览器记录暂未载入：'+error.message)).finally(()=>{
    state.initialLoading=false;updateControls();restoreJob();
  });
  $('load-example').addEventListener('click', async()=>{
    try { const result=await window.LFShowcase.example();resetResult();state.jobId='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';state.jobStatus='done';state.result=result;state.file=null;storage.set('lastJob',state.jobId);renderResult(result);showTab('train');status('预设动画样例 · 非 AI 识别结果。可播放、回看骨架与保存示例反馈。'); } catch(error){toast('样例载入失败：'+error.message);}
  });
  window.addEventListener('pagehide',()=>{stopRecording(true);clearTimeout(state.pollTimer);cancelAnimationFrame(state.animationId);releaseBlob();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(state.capture||state.cameraPending))stopRecording(true);});
})();

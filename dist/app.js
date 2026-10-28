(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {profile:null,sessions:[],chats:[],coachId:null,task:null,chatBusy:false,file:null,blobUrl:null,result:null,jobId:null,jobStatus:null,pollTimer:null,toastTimer:null,animationId:null,profileDirty:false};
  const labels = {goal:{habit:'建立训练习惯',strength:'基础力量训练',learn:'了解与观察动作'},completion:{completed:'已完成训练',partial:'完成部分训练',not_started:'尚未开始'},side:{left:'身体左侧',right:'身体右侧'}};
  const text = (node, value) => { node.textContent = value == null ? '' : String(value); };
  const htmlEscape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = (value) => {try {const u=new URL(value,location.origin);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}};

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求未完成（${response.status}）`;
      throw new Error(detail);
    }
    return data;
  }
  function jsonOptions(method, body) {return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};}
  function toast(message) {
    text($('toast'),message);$('toast').hidden=false;
    clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>$('toast').hidden=true,4200);
  }
  function showPage(name, focus = false) {
    if (!['home','coach','video','history'].includes(name)) name='home';
    document.querySelectorAll('.page').forEach(page=>page.hidden=page.id!==`page-${name}`);
    document.querySelectorAll('.nav-button').forEach(button=>{
      const active=button.dataset.page===name;button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });
    if(location.hash!==`#${name}`)history.replaceState(null,'',`#${name}`);
    window.scrollTo({top:0,behavior:'instant'});
    if(name==='video')requestAnimationFrame(drawOverlay);
    if(focus){const title=$(`page-${name}`).querySelector('h1');title.tabIndex=-1;title.focus({preventScroll:true});}
  }
  document.addEventListener('click',event=>{
    const pageButton=event.target.closest('[data-page]');if(pageButton){showPage(pageButton.dataset.page,true);}
    const prompt=event.target.closest('[data-prompt]');if(prompt&&!state.chatBusy){$('chat-input').value=prompt.dataset.prompt;sendChat(prompt.dataset.prompt);}
  });
  $('start-session').addEventListener('click',()=>showPage('coach',true));
  window.addEventListener('hashchange',()=>showPage(location.hash.slice(1)));

  function populateProfile(profile) {
    if(!profile)return;
    const form=$('profile-form');
    ['goal','experience','equipment','minutes','limitations','note'].forEach(key=>{if(form.elements[key]&&profile[key]!=null)form.elements[key].value=String(profile[key]);});
  }
  $('sample-profile').addEventListener('click',()=>{
    populateProfile({goal:'learn',experience:'beginner',equipment:'dumbbell',minutes:15,limitations:'none',note:'示例资料：希望了解弯举动作，并学习如何记录一次居家训练。'});
    state.profileDirty=true;$('sample-notice').hidden=false;text($('profile-state'),'示例 · 未保存');
    text($('profile-message'),'这些是体验用示例条件，保存前可按你的实际情况修改。');showPage('coach',true);
  });
  $('profile-form').addEventListener('input',()=>{state.profileDirty=true;text($('profile-state'),'有未保存修改');renderTask(null);});
  $('profile-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget;
    const profile={goal:form.elements.goal.value,experience:form.elements.experience.value,equipment:form.elements.equipment.value,minutes:Number(form.elements.minutes.value),limitations:form.elements.limitations.value,note:form.elements.note.value.trim()};
    const button=$('save-profile');button.disabled=true;text(button,'正在保存…');$('profile-message').classList.remove('error');
    try{
      const saved=await api('/api/profile',jsonOptions('PUT',profile));state.profile=saved.profile||profile;state.profileDirty=false;
      text($('profile-state'),'已保存');text($('profile-message'),'已保存。现在可以和 Coach 讨论这次训练。');toast('训练条件已保存');
      const input=$('chat-input');if(!input.value)input.value='请结合我已保存的条件，帮我开始一次居家训练，并说明如何进行弯举动作观察。';
      if(window.innerWidth<=650)$('messages').scrollIntoView({behavior:'smooth',block:'center'});input.focus({preventScroll:true});
    }catch(error){text($('profile-message'),`保存失败：${error.message}`);$('profile-message').classList.add('error');}
    finally{button.disabled=false;button.innerHTML='保存条件，开始对话 <span aria-hidden="true">→</span>';}
  });

  function addMessage(role, content, extra = {}) {
    const empty=$('messages').querySelector('.conversation-empty');if(empty)empty.remove();
    const message=document.createElement('div');message.className=`chat-message ${role}`;
    const label=document.createElement('div');label.className='message-label';text(label,role==='user'?'你':role==='error'?'本次请求未完成':'AI Coach');
    const body=document.createElement('div');body.className='message-body';text(body,content);message.append(label,body);
    if(extra.pending){body.innerHTML='<span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">正在生成回答</span>';}
    if(Array.isArray(extra.sources)&&extra.sources.length){const sources=document.createElement('div');sources.className='message-sources';extra.sources.forEach(source=>{const url=safeUrl(source.url);if(!url)return;const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.title=source.title||'查看资料来源';text(link,`↗ ${source.title||'资料来源'}`);sources.append(link);});if(sources.childNodes.length)message.append(sources);}
    if(extra.mode){const meta=document.createElement('div');meta.className='message-meta';text(meta,extra.mode==='local-model'?'本地模型回答 · 请结合实际情况判断':'范围与边界提示 · 规则判断');message.append(meta);}
    $('messages').append(message);$('messages').scrollTop=$('messages').scrollHeight;return message;
  }
  function renderTask(task) {
    state.task=task||null;$('task-card').hidden=!task;if(!task)return;
    text($('task-title'),task.title||'弯举动作观察');$('task-instructions').replaceChildren();
    (task.instructions||[]).forEach(item=>{const p=document.createElement('p');text(p,item);$('task-instructions').append(p);});
    $('task-capture').replaceChildren();(task.capture||[]).forEach(item=>{const li=document.createElement('li');text(li,item);$('task-capture').append(li);});
  }
  function setChatBusy(busy) {
    state.chatBusy=busy;$('send-message').disabled=busy;document.querySelectorAll('[data-prompt]').forEach(button=>button.disabled=busy);
    text($('chat-status'),busy?'正在本机生成回答，首次加载可能稍久…':'回答附资料来源；识别不到或超出范围时会说明。');
  }
  async function sendChat(message) {
    message=String(message||'').trim();if(!message||state.chatBusy)return;
    if(!state.profile){toast('先保存训练条件，再开始这次对话。');$('save-profile').focus();return;}
    if(state.profileDirty){toast('你的训练条件有修改，请先保存后再发消息。');$('save-profile').focus();return;}
    addMessage('user',message);$('chat-input').value='';setChatBusy(true);const pending=addMessage('assistant','',{pending:true});
    try{
      const response=await api('/api/coach',jsonOptions('POST',{message}));pending.remove();addMessage('assistant',response.text||'本次未返回可展示的内容。',response);
      if(response.id)state.coachId=response.id;
      renderTask(response.task||null);updateFeedbackContext();
    }catch(error){pending.remove();addMessage('error',`${error.message}\n这次没有生成有效建议。可以稍后重试；视频观察与练后记录仍可单独使用。`);text($('chat-status'),'本次回答未完成，未使用示例内容替代。');}
    finally{setChatBusy(false);}
  }
  $('chat-form').addEventListener('submit',event=>{event.preventDefault();sendChat($('chat-input').value);});
  $('chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendChat(event.currentTarget.value);}});

  function videoError(message){$('video-error').hidden=!message;text($('video-error'),message);}
  function resetVideoResult(){state.result=null;state.jobId=null;state.jobStatus=null;clearTimeout(state.pollTimer);$('observation-results').hidden=true;$('analysis-progress').hidden=true;$('pose-canvas').hidden=true;$('video-caption').hidden=true;updateFeedbackContext();}
  $('video-file').addEventListener('change',event=>{
    const file=event.currentTarget.files?.[0];if(!file)return;
    if(['queued','running'].includes(state.jobStatus)){toast('视频正在处理中，请等本次分析完成。');return;}
    resetVideoResult();videoError('');state.file=null;
    if(file.size>60*1024*1024){videoError('这段视频超过 60 MiB，请选择更短或压缩后的视频。');$('analyze-video').disabled=true;return;}
    if(state.blobUrl)URL.revokeObjectURL(state.blobUrl);state.blobUrl=URL.createObjectURL(file);state.file=file;
    const video=$('motion-video');video.src=state.blobUrl;video.hidden=false;$('video-placeholder').hidden=true;
    text($('file-name'),`${file.name} · ${(file.size/1024/1024).toFixed(1)} MiB`);$('analyze-video').disabled=false;
  });
  $('motion-video').addEventListener('loadedmetadata',()=>{
    const video=$('motion-video');
    if(state.file&&!state.result&&Number.isFinite(video.duration)&&video.duration>45.15){videoError('视频最长支持 45 秒，请剪短后再提交。');$('analyze-video').disabled=true;}
    requestAnimationFrame(drawOverlay);
  });
  $('motion-video').addEventListener('error',()=>{if(state.file&&!state.result)videoError('浏览器暂时无法预览这个文件。你仍可以提交分析；若服务也无法解码，请换成 MP4 格式。');});
  function setAnalyzing(active){$('analyze-video').disabled=active||!state.file;$('video-file').disabled=active;$('analysis-side').disabled=active;$('save-feedback').disabled=active;}
  function updateProgress(value,label){$('analysis-progress').hidden=false;$('progress-bar').value=Math.max(0,Math.min(100,value));text($('progress-number'),`${Math.round(value)}%`);text($('progress-label'),label);}
  $('analyze-video').addEventListener('click',async()=>{
    if(!state.file||['queued','running'].includes(state.jobStatus))return;
    resetVideoResult();videoError('');state.jobStatus='queued';setAnalyzing(true);updateProgress(0,'正在提交视频…');updateFeedbackContext();
    try{
      const response=await api(`/api/video?side=${encodeURIComponent($('analysis-side').value)}`,{method:'POST',headers:{'Content-Type':state.file.type||'application/octet-stream'},body:state.file});
      if(!response.jobId)throw new Error('服务没有返回分析任务编号，请重试。');state.jobId=response.jobId;pollJob();
    }catch(error){state.jobStatus='error';videoError(`分析没有开始：${error.message}`);$('analysis-progress').hidden=true;setAnalyzing(false);updateFeedbackContext();}
  });
  async function pollJob(){
    try{
      const job=await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);state.jobStatus=job.status;
      updateProgress(Number(job.progress)||0,job.status==='queued'?'视频已提交，等待本地分析…':'正在观察视频中的动作…');
      if(job.status==='done'){
        if(!job.result)throw new Error('分析任务结束，但没有可展示的结果。');state.result=job.result;$('analysis-progress').hidden=true;setAnalyzing(false);renderResult(job.result);updateFeedbackContext();toast('视频分析完成，请结合画面查看结果。');
      }else if(job.status==='error'){throw new Error(job.error||'这段视频未能完成分析。');}
      else{state.pollTimer=setTimeout(pollJob,1300);}
    }catch(error){state.jobStatus='error';videoError(`分析未完成：${error.message}`);$('analysis-progress').hidden=true;setAnalyzing(false);updateFeedbackContext();}
  }
  function renderResult(result){
    $('observation-results').hidden=false;
    const usable=result.quality==='usable'&&result.count!=null;
    text($('quality-badge'),usable?'有可用观察结果':'无法可靠计数');$('quality-badge').className=`small-tag ${usable?'usable':'insufficient'}`;
    text($('result-count'),usable?result.count:'—');text($('result-duration'),`${Number(result.duration||0).toFixed(1)} 秒`);text($('result-valid'),`${Math.round(Number(result.validRatio||0)*100)}%`);text($('result-summary'),result.summary||'请结合原始视频查看关键点与观察限制。');
    $('result-limitations').replaceChildren();(result.limitations||[]).forEach(limit=>{const li=document.createElement('li');text(li,limit);$('result-limitations').append(li);});
    const video=$('motion-video');if(result.sourceUrl){const url=safeUrl(result.sourceUrl);if(url&&new URL(url).origin===location.origin){video.src=url;video.hidden=false;$('video-placeholder').hidden=true;}}
    $('pose-canvas').hidden=!$('overlay-toggle').checked;$('video-caption').hidden=false;requestAnimationFrame(drawOverlay);
  }
  const edges=[[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
  function currentFrame(time){
    const frames=state.result?.frames;if(!Array.isArray(frames)||!frames.length)return null;
    let lo=0,hi=frames.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Number(frames[mid].t)<=time)lo=mid;else hi=mid-1;}
    const frame=frames[lo];return Math.abs(Number(frame.t)-time)<=.75?frame:null;
  }
  function drawOverlay(){
    const canvas=$('pose-canvas'),video=$('motion-video'),stage=$('video-stage'),ctx=canvas.getContext('2d');
    if(!ctx)return;
    const rect=stage.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const dpr=window.devicePixelRatio||1;const width=Math.round(rect.width),height=Math.round(rect.height);
    if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    if(!state.result)return;
    const frame=currentFrame(video.currentTime);
    if(!frame){text($('frame-label'),'此时刻暂无可用关键点');text($('frame-detail'),'当前时刻未返回可展示的观察数据。');return;}
    const valid=frame.valid===true;
    text($('frame-label'),`${labels.side[state.result.side]||'目标手臂'} · ${valid?'可观察':'当前帧不可靠'}`);
    text($('frame-detail'),`${video.currentTime.toFixed(1)} 秒 · ${valid?`当前累计 ${frame.count??0} 次完整周期${frame.angle!=null?` · 画面肘角 ${Math.round(frame.angle)}°`:''}`:'关键点不足，暂停这部分动作计数'}`);
    if(!$('overlay-toggle').checked)return;
    const vw=Number(state.result.width)||video.videoWidth||width,vh=Number(state.result.height)||video.videoHeight||height;
    const scale=Math.min(width/vw,height/vh),rw=vw*scale,rh=vh*scale,ox=(width-rw)/2,oy=(height-rh)/2;
    const points=frame.points||[],target=state.result.side==='right'?[6,8,10]:[5,7,9];
    const good=(p)=>Array.isArray(p)&&p.length>=3&&Number(p[2])>=.3&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]));
    const xy=(p)=>[ox+Number(p[0])*rw,oy+Number(p[1])*rh];
    edges.forEach(([a,b])=>{if(!good(points[a])||!good(points[b]))return;const axy=xy(points[a]),bxy=xy(points[b]);const active=target.includes(a)&&target.includes(b);ctx.beginPath();ctx.moveTo(...axy);ctx.lineTo(...bxy);ctx.strokeStyle=active?(valid?'#f4b785':'#d3a06d'):'#a5d3b8b3';ctx.lineWidth=active?3:1.8;ctx.stroke();});
    points.forEach((p,i)=>{if(!good(p))return;const [x,y]=xy(p);ctx.beginPath();ctx.arc(x,y,target.includes(i)?4.5:2.6,0,Math.PI*2);ctx.fillStyle=target.includes(i)?'#ffe0ad':'#cdf0d3';ctx.strokeStyle='#183e36';ctx.lineWidth=1.1;ctx.fill();ctx.stroke();});
  }
  function animateVideo(){drawOverlay();if(!$('motion-video').paused&&!$('motion-video').ended)state.animationId=requestAnimationFrame(animateVideo);}
  $('motion-video').addEventListener('play',()=>{cancelAnimationFrame(state.animationId);animateVideo();});
  ['pause','seeked','timeupdate','loadeddata'].forEach(event=>$('motion-video').addEventListener(event,drawOverlay));
  $('overlay-toggle').addEventListener('change',()=>{$('pose-canvas').hidden=!$('overlay-toggle').checked||!state.result;drawOverlay();});
  if('ResizeObserver'in window)new ResizeObserver(drawOverlay).observe($('video-stage'));else window.addEventListener('resize',drawOverlay);

  $('effort').addEventListener('input',event=>text($('effort-value'),`${event.currentTarget.value} / 10`));
  function updateFeedbackContext(){
    const pending=['queued','running'].includes(state.jobStatus);$('feedback-context').classList.toggle('pending',pending);
    if(pending)text($('feedback-context'),'视频正在分析。完成后可保存关联结果的反馈。');
    else if(state.jobStatus==='done'&&state.result)text($('feedback-context'),state.result.count==null?'将关联本次视频；结果为无法可靠计数，不会填入估计次数。':`将关联本次视频观察：${state.result.count} 次完整周期。`);
    else text($('feedback-context'),'尚未关联视频结果，记录会标明未测量次数。');
    $('save-feedback').disabled=pending;
  }
  $('feedback-form').addEventListener('submit',async event=>{
    event.preventDefault();if(['queued','running'].includes(state.jobStatus))return;
    if(!state.profile){toast('请先保存训练条件，记录才能关联你的档案。');showPage('coach',true);return;}
    const form=event.currentTarget;const payload={coachId:state.coachId||null,jobId:state.jobStatus==='done'?state.jobId:null,perceivedEffort:Number(form.elements.perceivedEffort.value),discomfort:form.elements.discomfort.value,completion:form.elements.completion.value,note:form.elements.note.value.trim()};
    $('save-feedback').disabled=true;text($('save-feedback'),'正在保存…');$('feedback-message').classList.remove('error');
    try{const response=await api('/api/feedback',jsonOptions('POST',payload));if(response.session)state.sessions.unshift(response.session);else await loadState(false);renderHistory();text($('feedback-message'),'这次记录已保存。');toast('这次记录已保存，可以在训练记录页回看。');showPage('history',true);}
    catch(error){text($('feedback-message'),`保存失败：${error.message}`);$('feedback-message').classList.add('error');}
    finally{$('save-feedback').disabled=false;$('save-feedback').innerHTML='保存这次记录 <span aria-hidden="true">✓</span>';}
  });
  function stringSummary(value){if(typeof value==='string')return value;if(value&&typeof value==='object')return Object.entries(value).filter(([,v])=>['string','number'].includes(typeof v)).map(([key,v])=>`${key}：${v}`).join(' · ');return '';}
  function renderHistory(){
    const list=$('history-list');list.replaceChildren();text($('history-count'),state.sessions.length);
    if(!state.sessions.length){list.innerHTML='<div class="history-empty"><span class="empty-star" aria-hidden="true">✦</span><h2>你的第一条记录，从这次开始。</h2><p>完成一次对话或视频观察后，保存练后反馈。没有上传视频，也可以记录真实感受。</p><button class="button primary" data-page="coach">开始一次训练 <span aria-hidden="true">→</span></button></div>';return;}
    [...state.sessions].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).forEach(session=>{
      const f=session.feedback||{},profile=session.profileSnapshot||{},created=new Date(session.createdAt);const date=Number.isNaN(created.getTime())?'时间待确认':created.toLocaleDateString('zh-CN',{month:'long',day:'numeric'});const time=Number.isNaN(created.getTime())?'':created.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
      const card=document.createElement('article');card.className='session-card';
      const review=session.reviewNeeded||f.discomfort==='yes';
      card.innerHTML=`<div class="session-date"><strong>${htmlEscape(date)}</strong><span>${htmlEscape(time)}</span><span class="small-tag ${review?'insufficient':''}">${review?'有待关注反馈':'已保存'}</span></div><div><h2>${htmlEscape(labels.completion[f.completion]||'居家训练记录')}</h2><div class="session-details"><span>${htmlEscape(labels.goal[profile.goal]||'居家训练')}</span><span>主观用力 ${htmlEscape(f.perceivedEffort??'—')} / 10</span><span>${f.discomfort==='yes'?'反馈有不适':'未反馈不适'}</span><span>${session.jobId?'已关联视频观察':'次数未测量'}</span></div>${f.note?`<p class="session-note">${htmlEscape(f.note)}</p>`:''}${session.summary?`<p class="session-summary">${htmlEscape(stringSummary(session.summary))}</p>`:''}${session.jobId?'<button class="inline-link history-video">回看这次视频观察 ↗</button>':''}</div>`;
      const replay=card.querySelector('.history-video');if(replay)replay.addEventListener('click',async()=>{try{const job=await api(`/api/jobs/${encodeURIComponent(session.jobId)}`);if(job.status!=='done'||!job.result)throw new Error('这次视频暂时没有可回看的完整结果。');if(['queued','running'].includes(state.jobStatus)){toast('请先等待当前视频分析完成。');return;}state.jobId=session.jobId;state.jobStatus='done';state.result=job.result;state.file=null;$('video-file').value='';$('analyze-video').disabled=true;text($('file-name'),'正在回看已保存的视频');renderResult(job.result);updateFeedbackContext();showPage('video',true);}catch(error){toast(error.message);}});
      list.append(card);
    });
  }
  $('clear-data').addEventListener('click',async()=>{
    if(['queued','running'].includes(state.jobStatus)||state.chatBusy){toast('请等待本次请求结束，再清空数据。');return;}
    if(!window.confirm('确定清空这个 Life Fitness Demo 的档案、对话、训练记录和上传视频吗？导出的 JSON 不包含视频文件，清空前请保留自己的原始视频。此操作无法撤销，不会删除其他项目的数据。'))return;
    try{await api('/api/data',{method:'DELETE'});location.replace('/#home');location.reload();}catch(error){toast(`未能清空：${error.message}`);}
  });
  function renderSavedChats(chats){
    const normalized=[];
    chats.slice(-8).forEach(item=>{
      if(item.role&&typeof(item.content||item.text)==='string'){normalized.push({role:item.role==='user'?'user':'assistant',content:item.content||item.text,extra:item});}
      else if(item.message||item.response||item.text){if(item.message)normalized.push({role:'user',content:item.message,extra:{}});const response=item.response&&typeof item.response==='object'?item.response:item;if(response.text)normalized.push({role:'assistant',content:response.text,extra:response});}
      if(item.id&&item.role!=='user')state.coachId=item.id;
      if(item.response&&typeof item.response==='object')state.task=item.response.task||null;
      else if(item.role!=='user'&&(item.role||item.text))state.task=item.task||null;
    });
    normalized.forEach(msg=>addMessage(msg.role,msg.content,msg.extra));if(state.task)renderTask(state.task);
  }
  async function loadState(renderChats=true){
    const data=await api('/api/state');state.profile=data.profile||null;state.sessions=Array.isArray(data.sessions)?data.sessions:[];state.chats=Array.isArray(data.chats)?data.chats:[];
    if(state.profile){populateProfile(state.profile);text($('profile-state'),'已保存');text($('profile-message'),'已载入你的本机档案，可修改后重新保存。');}renderHistory();if(renderChats)renderSavedChats(state.chats);
  }
  async function health(){
    try{const data=await api('/api/health');const ready=data.coach?.available===true;text($('coach-health'),ready?'本地模型组件就绪':'本地模型暂不可用');$('coach-health').classList.toggle('unavailable',!ready);const dot=document.createElement('span');dot.className='tiny-dot';$('coach-health').prepend(dot);if(!data.vision?.available){videoError('本地动作识别组件暂不可用。可以先体验资料、对话和练后记录。');}}
    catch{text($('coach-health'),'本机服务连接失败');$('coach-health').classList.add('unavailable');toast('无法连接本机服务，请确认已通过启动脚本打开。');}
  }
  ['open-about','footer-about'].forEach(id=>$(id).addEventListener('click',()=>$('about-dialog').showModal()));
  ['close-about','about-done'].forEach(id=>$(id).addEventListener('click',()=>$('about-dialog').close()));
  $('about-dialog').addEventListener('click',event=>{if(event.target===$('about-dialog')){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.currentTarget.close();}});
  showPage(location.hash.slice(1)||'home');renderHistory();
  Promise.allSettled([loadState(),health()]).then(results=>{if(results[0].status==='rejected')toast(`本机记录暂未载入：${results[0].reason.message}`);});
  window.addEventListener('beforeunload',()=>{clearTimeout(state.pollTimer);if(state.blobUrl)URL.revokeObjectURL(state.blobUrl);});
})();

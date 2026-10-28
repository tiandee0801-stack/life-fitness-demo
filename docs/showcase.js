(() => {
 'use strict';
 const KEY='lifeFitnessShowcase.v1', JOB='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
 const blank=()=>({profile:null,chats:[],sessions:[]});
 let data; try{data=JSON.parse(localStorage.getItem(KEY))||blank();}catch{data=blank();}
 if(!Array.isArray(data.chats)||!Array.isArray(data.sessions))data=blank();
 const save=()=>localStorage.setItem(KEY,JSON.stringify(data));
 const clone=v=>JSON.parse(JSON.stringify(v));
 let sample;
 async function example(){if(!sample){const r=await fetch(new URL('assets/curl-example.json',location.href));if(!r.ok)throw new Error('样例不可用');sample=await r.json();sample.sourceUrl=new URL('assets/curl-example.mp4',location.href).href;}return clone(sample);}
 const now=()=>new Date().toISOString();
 window.LFShowcase={example,exportUrl(){const text=JSON.stringify({mode:'interactive-example',notice:'仅为展示版记录，不是真实AI推理结果。',exportedAt:now(),...data},null,2);const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));setTimeout(()=>URL.revokeObjectURL(url),30000);return url;},async api(path,options={}){
  const method=options.method||'GET';const body=typeof options.body==='string'?JSON.parse(options.body):{};
  if(path==='/api/state')return clone(data);
  if(path==='/api/profile'&&method==='PUT'){data.profile={...body,updatedAt:now()};save();return {profile:clone(data.profile)};}
  if(path==='/api/coach'&&method==='POST'){
   const response={id:crypto.randomUUID(),kind:'answer',mode:'example',sources:[],task:null,text:'这是预设流程讲解，未调用 AI 模型，也没有分析你的身体情况或视频。\n\n可以按这个顺序体验：保存训练档案 → 点击「播放完整流程样例」 → 回放预设骨架与计数 → 记录感受 → 到历史页回看。\n\n自己的视频只在浏览器预览，不上传。需要真实模型问答或视频识别时，请运行 GitHub 仓库里的本地版。'};
   data.chats.push({id:response.id,createdAt:now(),message:String(body.message||'').slice(0,600),response});save();return response;
  }
  if(path==='/api/jobs/'+JOB)return {jobId:JOB,status:'done',progress:100,result:await example()};
  if(path==='/api/feedback'&&method==='POST'){
   if(!data.profile)throw new Error('请先保存展示档案。');
   const session={id:crypto.randomUUID(),createdAt:now(),profileSnapshot:clone(data.profile),coachId:body.coachId||null,jobId:body.jobId===JOB?JOB:null,feedback:body,simulation:true,summary:'展示流程记录，非真实AI结果',observation:body.jobId===JOB?await example():null,reviewNeeded:body.discomfort==='yes'};
   data.sessions.unshift(session);save();return {session:clone(session)};
  }
  if(path==='/api/data'&&method==='DELETE'){data=blank();localStorage.removeItem(KEY);return {ok:true};}
  throw new Error('线上展示版未接入此模型服务。真实分析请使用仓库中的本地版。');
 }};
})();
